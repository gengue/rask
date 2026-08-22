import { createDb } from "@rask/schema";
import { loadConfig } from "./config.ts";
import { drainOutbox } from "./outbox.ts";
import { activeLists, syncHierarchy, syncList } from "./sync.ts";
import { TokenPool } from "./tokens.ts";

/**
 * Three loops, no scheduler library.
 *
 *  - outbox: ship pending writes to ClickUp
 *  - poll: re-read every tracked list, because webhooks get lost and have no replay
 *  - reconcile: once a night, ignore the cursors and re-read everything
 *
 * Each loop reschedules itself only after the previous run finishes, so a slow
 * cycle delays the next one instead of stacking on top of it.
 */

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const pool = new TokenPool(db, config.encryptionKey);

let stopping = false;

function every(ms: number, name: string, run: () => Promise<void>): void {
  const tick = async () => {
    if (stopping) return;
    try {
      await run();
    } catch (error) {
      console.error(`[${name}]`, error instanceof Error ? error.message : error);
    }
    if (!stopping) setTimeout(tick, ms);
  };
  setTimeout(tick, ms);
}

async function pollOnce(full: boolean): Promise<void> {
  const count = await pool.refresh();
  if (count === 0) return;

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

const tokenCount = await pool.refresh();
console.log(`[worker] ${tokenCount} ClickUp token(s) available`);
await refreshHierarchy();

every(config.OUTBOX_INTERVAL_MS, "outbox", async () => {
  await pool.refresh();
  const result = await drainOutbox(db, pool);
  if (result.sent + result.failed > 0) {
    console.log(
      `[outbox] sent ${result.sent}, failed ${result.failed}, deferred ${result.deferred}`,
    );
  }
});

every(config.POLL_INTERVAL_MS, "poll", () => pollOnce(false));

// Checked every 15 minutes; runs when the clock first lands in the target hour.
let lastReconcileDay = -1;
every(15 * 60_000, "reconcile", async () => {
  const now = new Date();
  if (now.getHours() !== config.RECONCILE_HOUR || now.getDate() === lastReconcileDay) return;
  lastReconcileDay = now.getDate();
  // Lists get created and renamed; the nightly pass is where that catches up.
  await refreshHierarchy();
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
