import { createDb } from "@rask/schema";
import { loadConfig } from "./config.ts";
import { drainOutbox } from "./outbox.ts";
import { activeLists, coldLists, syncHierarchy, syncList } from "./sync.ts";
import { TokenPool } from "./tokens.ts";
import { drainWebhookEvents, ensureWebhook, NO_PUBLIC_URL } from "./webhooks.ts";

/**
 * Six loops, no scheduler library.
 *
 *  - outbox: ship pending writes to ClickUp
 *  - webhook: read back the tasks ClickUp's events named
 *  - cold: first read of a list somebody has just opened
 *  - poll: re-read every tracked list, because webhooks get lost and have no replay
 *  - health: notice a webhook ClickUp has suspended, and revive it
 *  - reconcile: once a night, ignore the cursors and re-read everything
 *
 * Each loop reschedules itself only after the previous run finishes, so a slow
 * cycle delays the next one instead of stacking on top of it.
 */

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const pool = new TokenPool(db, config.encryptionKey);

/** Read-backs are the whole point of a webhook; a second of queueing is the budget. */
const WEBHOOK_DRAIN_INTERVAL_MS = 1_000;
/** How often the registration is re-checked against ClickUp. */
const WEBHOOK_HEALTH_INTERVAL_MS = 5 * 60_000;
/** How long a list somebody just opened waits to be read for the first time. */
const COLD_INTERVAL_MS = 3_000;

let stopping = false;

/**
 * `ms` may be a function, which is how the poll interval changes underneath a
 * running loop: it is read after each tick, so a webhook going unhealthy at
 * 04:00 speeds polling back up without a restart.
 */
function every(ms: number | (() => number), name: string, run: () => Promise<void>): void {
  const next = () => (typeof ms === "function" ? ms() : ms);
  const tick = async () => {
    if (stopping) return;
    try {
      await run();
    } catch (error) {
      console.error(`[${name}]`, error instanceof Error ? error.message : error);
    }
    if (!stopping) setTimeout(tick, next());
  };
  setTimeout(tick, next());
}

async function pollOnce(full: boolean): Promise<void> {
  const count = await pool.refresh();
  if (count === 0) return;
  if (!hierarchyLoaded) hierarchyLoaded = await refreshHierarchy();

  const listIds = await activeLists(db);
  if (listIds.length === 0) return;

  let changed = 0;
  let requests = 0;

  for (const listId of listIds) {
    if (stopping) break;
    const entry = pool.next();
    if (!entry) break;
    try {
      const stats = await syncList(db, entry.client, listId, { full, teamId: entry.teamId });
      changed += stats.changed;
      requests += stats.requests;
    } catch (error) {
      console.error(`[poll] list ${listId}`, error instanceof Error ? error.message : error);
    }
  }

  if (changed > 0 || full) {
    console.log(
      `[${full ? "reconcile" : "poll"}] ${listIds.length} lists, ${requests} requests, ${changed} changed`,
    );
  }
}

/**
 * Refreshes the Space/Folder/List tree.
 *
 * Tries each token in turn. A single revoked token must not stop the worker:
 * someone leaving the company should not take ingestion down with them, and a
 * token that fails here still gets its own writes attempted in the outbox loop.
 */
async function refreshHierarchy(): Promise<boolean> {
  const count = await pool.refresh();
  if (count === 0) return false;

  for (let attempt = 0; attempt < count; attempt++) {
    const entry = pool.next();
    if (!entry) break;
    try {
      const teamId = config.CLICKUP_TEAM_ID ?? entry.teamId;
      const stats = await syncHierarchy(db, entry.client, teamId);
      console.log(`[worker] hierarchy synced in ${stats.ms}ms (${stats.requests} requests)`);
      return true;
    } catch (error) {
      console.error(
        `[worker] hierarchy sync failed for user ${entry.userId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.error("[worker] no usable ClickUp token; ingestion is idle until someone signs in");
  return false;
}

/**
 * Whether a webhook is currently delivering, which is the only thing that
 * decides how fast the backup poll runs.
 *
 * "Failing" counts as delivering: ClickUp keeps sending while `fail_count`
 * climbs, and it resets itself once deliveries succeed again. Only "no usable
 * webhook" puts polling back to the two-minute interval, which is exactly the
 * behaviour Rask had before any of this existed.
 */
let webhookDelivering = false;

async function checkWebhook(): Promise<void> {
  await pool.refresh();
  const state = await ensureWebhook(db, pool, config);
  const delivering = state.kind !== "none";

  if (delivering !== webhookDelivering) {
    const interval = delivering ? config.POLL_INTERVAL_WEBHOOK_MS : config.POLL_INTERVAL_MS;
    console.log(
      `[webhook] ${delivering ? "delivering" : "not delivering"}; polling every ${Math.round(interval / 1000)}s`,
    );
  }
  webhookDelivering = delivering;

  if (state.kind === "failing") {
    console.warn(`[webhook] ${state.webhook.id} is failing (fail_count ${state.failCount})`);
  }
  if (state.kind === "none" && state.reason !== NO_PUBLIC_URL) {
    console.warn(`[webhook] not registered: ${state.reason}`);
  }
}

const tokenCount = await pool.refresh();
console.log(`[worker] ${tokenCount} ClickUp token(s) available`);
/*
 * False until the tree lands once, and retried by the poll below.
 *
 * A worker on a fresh deployment boots before anybody can possibly have signed
 * in, so this first attempt has no token to make and every list, every space
 * and the sidebar itself stay empty. Without the retry the next attempt is the
 * nightly reconciliation, which is a long time to look at an empty app.
 */
let hierarchyLoaded = await refreshHierarchy();
await checkWebhook();

every(config.OUTBOX_INTERVAL_MS, "outbox", async () => {
  await pool.refresh();
  const result = await drainOutbox(db, pool);
  if (result.sent + result.failed > 0) {
    console.log(
      `[outbox] sent ${result.sent}, failed ${result.failed}, deferred ${result.deferred}`,
    );
  }
});

/*
 * Runs whether or not a webhook is registered. The queue is a table, so rows
 * can outlive the registration that produced them — a webhook deleted while
 * events were in flight, or a synthetic delivery in dev — and draining an empty
 * table is one indexed query.
 */
every(WEBHOOK_DRAIN_INTERVAL_MS, "webhook", async () => {
  const result = await drainWebhookEvents(db, pool);
  if (result.done + result.dropped > 0) {
    console.log(
      `[webhook] read back ${result.done}, deferred ${result.deferred}, dropped ${result.dropped}`,
    );
  }
});

every(WEBHOOK_HEALTH_INTERVAL_MS, "webhook-health", checkWebhook);

/*
 * The first read of a list somebody has just opened. See `coldLists` for why it
 * cannot wait for the poll and why running this often costs nothing: the set is
 * empty except for the seconds after a list is opened, and the token pool is
 * only touched when it is not.
 */
every(COLD_INTERVAL_MS, "cold", async () => {
  const listIds = await coldLists(db);
  if (listIds.length === 0) return;
  if ((await pool.refresh()) === 0) return;

  for (const listId of listIds) {
    if (stopping) break;
    const entry = pool.next();
    if (!entry) break;
    try {
      const stats = await syncList(db, entry.client, listId, { teamId: entry.teamId });
      console.log(
        `[cold] list ${listId}: ${stats.tasks} tasks, ${stats.requests} requests, ${stats.ms}ms`,
      );
    } catch (error) {
      // Already recorded against the cursor, which is what stops this retrying
      // in three seconds; the poll owns it from here.
      console.error(`[cold] list ${listId}`, error instanceof Error ? error.message : error);
    }
  }
});

every(
  () => (webhookDelivering ? config.POLL_INTERVAL_WEBHOOK_MS : config.POLL_INTERVAL_MS),
  "poll",
  () => pollOnce(false),
);

// Checked every 15 minutes; runs when the clock first lands in the target hour.
let lastReconcileDay = -1;
every(15 * 60_000, "reconcile", async () => {
  const now = new Date();
  if (now.getHours() !== config.RECONCILE_HOUR || now.getDate() === lastReconcileDay) return;
  lastReconcileDay = now.getDate();
  // Lists get created and renamed; the nightly pass is where that catches up.
  hierarchyLoaded = (await refreshHierarchy()) || hierarchyLoaded;
  await pollOnce(true);
});

console.log("[worker] running");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.log("[worker] stopping");
    setTimeout(() => process.exit(0), 100);
  });
}
