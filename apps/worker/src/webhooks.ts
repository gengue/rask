import { ClickUpError, WEBHOOK_TASK_EVENTS } from "@rask/clickup-client";
import {
  type Db,
  forgetWebhook,
  loadWebhooks,
  markTaskDeleted,
  type StoredWebhook,
  saveWebhook,
  webhookEvents,
} from "@rask/schema";
import { eq, sql } from "drizzle-orm";
import type { Config } from "./config.ts";
import { syncComments, syncTask } from "./sync.ts";
import type { TokenPool } from "./tokens.ts";

/**
 * Registering the webhook, watching its health, and draining what it delivers.
 *
 * All three live in the worker rather than the API for the same reason: the
 * worker is the only process that talks to ClickUp on a schedule, it is the one
 * that holds the token pool, and there is exactly one of it. Registration in
 * the API would run once per replica and race itself into duplicate webhooks.
 */

/**
 * Read-backs before a task is given up on.
 *
 * 2s, 4s, 8s, 16s, 32s — about a minute of trying. Past that the event is
 * dropped and the task waits for the next poll, which is precisely the case
 * polling was kept for. Holding the row longer would only delay the moment the
 * backstop is allowed to do its job.
 */
export const MAX_WEBHOOK_ATTEMPTS = 5;

/** Tasks read back per drain tick. One `GET /task/{id}` each. */
const DRAIN_BATCH = 25;

export interface DrainResult {
  done: number;
  /** Read-backs that failed and will be tried again. */
  deferred: number;
  /** Events dropped after the attempt budget ran out. Polling repairs these. */
  dropped: number;
}

interface QueuedEvent {
  task_id: string;
  event: string;
  /** Postgres sends a boolean column back as a boolean; the claim selects it. */
  needs_comments: boolean;
  attempts: number;
}

/**
 * Reads back the tasks webhooks told us about.
 *
 * The queue is keyed by task id, so this is idempotent by construction: the
 * work for a row is "fetch the task and upsert it", which produces the same
 * mirror however many times it runs and in whatever order rows are claimed.
 * That is what makes ClickUp's delivery guarantees — duplicated, reordered,
 * occasionally absent — stop mattering. Absent is the only one left, and it is
 * what polling covers.
 */
export async function drainWebhookEvents(
  db: Db,
  pool: TokenPool,
  limit = DRAIN_BATCH,
): Promise<DrainResult> {
  const result: DrainResult = { done: 0, deferred: 0, dropped: 0 };

  // Claiming bumps the attempt count, so there is no point claiming rows we
  // have no token to process. Leave them for a tick when somebody is signed in.
  if (pool.size === 0) return result;

  for (const row of await claim(db, limit)) {
    const entry = pool.next();
    if (!entry) break;

    try {
      if (row.event === "taskDeleted") {
        await markTaskDeleted(db, row.task_id);
      } else {
        await syncTask(db, entry.client, row.task_id);
        /*
         * The conversation, but only when something said so.
         *
         * This is the second request a comment event costs, and the only place
         * a comment reaches the mirror without somebody opening the task. It
         * runs after the task read-back rather than instead of it: a comment
         * event still moves the task's own mtime, and a mention on a task the
         * mirror has never seen has nothing to hang off until the task is
         * there.
         */
        if (row.needs_comments) await syncComments(db, entry.client, row.task_id);
      }
      await release(db, row.task_id);
      result.done++;
    } catch (error) {
      /*
       * A 404 is an answer, not a failure. `taskDeleted` is the event ClickUp
       * is least reliable about — it can be the one that goes missing, or
       * arrive after a `taskUpdated` for the same task — so the read-back
       * finding nothing is how a deletion is most often learned. Record it and
       * drop the row rather than retrying into the same 404 five times.
       */
      if (error instanceof ClickUpError && error.status === 404) {
        await markTaskDeleted(db, row.task_id);
        await release(db, row.task_id);
        result.done++;
        continue;
      }

      if (row.attempts >= MAX_WEBHOOK_ATTEMPTS) {
        await release(db, row.task_id);
        result.dropped++;
        console.error(`[webhook] giving up on ${row.task_id}:`, messageOf(error));
      } else {
        result.deferred++;
      }
    }
  }

  return result;
}

/**
 * Claims due rows and schedules their next attempt in one statement.
 *
 * `FOR UPDATE SKIP LOCKED`, like the outbox, so a second worker would be safe.
 * The backoff is applied here rather than in the failure branch on purpose: a
 * worker that dies mid-drain has already pushed its rows into the future, so
 * the restart picks up where it left off instead of hot-looping on whatever
 * killed it.
 */
async function claim(db: Db, limit: number): Promise<QueuedEvent[]> {
  const result = await db.execute(sql`
    with claimed as (
      select task_id from ${webhookEvents}
      where next_attempt_at <= now()
      order by received_at
      for update skip locked
      limit ${limit}
    )
    update ${webhookEvents} w
    set attempts = w.attempts + 1,
        next_attempt_at = now() + (least(300, 2 ^ (w.attempts + 1)))::int * interval '1 second'
    from claimed c
    where w.task_id = c.task_id
    returning w.task_id, w.event, w.needs_comments, w.attempts
  `);
  return (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  ) as QueuedEvent[];
}

function release(db: Db, taskId: string): Promise<unknown> {
  return db.delete(webhookEvents).where(eq(webhookEvents.taskId, taskId));
}

// --- Registration and health ---------------------------------------------

export type WebhookState =
  /** A webhook is registered and ClickUp is delivering. */
  | { kind: "active"; webhook: StoredWebhook }
  /** Registered, but ClickUp has counted failures against it. Still delivering. */
  | { kind: "failing"; webhook: StoredWebhook; failCount: number }
  /** No usable webhook. Polling is the only source of changes. */
  | { kind: "none"; reason: string };

export const NO_PUBLIC_URL = "CLICKUP_WEBHOOK_URL is not set";

/**
 * Makes sure exactly one live webhook points at our endpoint, and returns what
 * state it is in.
 *
 * Safe to call on every boot and on a schedule. The three things it must not do
 * are register a second webhook when one already exists, keep believing in one
 * that ClickUp has dropped, and leave a suspended one suspended.
 *
 * The awkward part is that `GET /team/{id}/webhook` only lists webhooks created
 * by the calling token. A registration is therefore pinned to the user who made
 * it — see `webhooks.user_id` — and looked up under that same token. Asking
 * with a round-robin token would answer "no webhooks here" and register another
 * one every time the cursor moved.
 */
export async function ensureWebhook(
  db: Db,
  pool: TokenPool,
  config: Config,
): Promise<WebhookState> {
  const endpoint = config.CLICKUP_WEBHOOK_URL;
  if (!endpoint) return { kind: "none", reason: NO_PUBLIC_URL };
  if (pool.size === 0) return { kind: "none", reason: "no ClickUp token" };

  const stored = (await loadWebhooks(db, config.encryptionKey)).filter(
    (row) => row.endpoint === endpoint,
  );

  for (const row of stored) {
    const client = row.userId ? await pool.for(row.userId) : null;
    if (!client) {
      /*
       * Whoever registered this has signed out or had their token revoked, and
       * no other token can see it — so it cannot be inspected, updated or
       * deleted, only left alone.
       *
       * The row stays, because it holds the secret and the old webhook may well
       * still be delivering; dropping it would start refusing deliveries that
       * are genuine. The loop falls through to registering a replacement under
       * a token we do have, and the orphan is left to ClickUp to suspend once
       * whatever eventually breaks it does.
       */
      console.warn(`[webhook] ${row.id} was registered by a user we no longer have a token for`);
      continue;
    }

    const live = await client.getWebhooks(row.teamId).catch((error) => {
      console.error("[webhook] could not list webhooks:", messageOf(error));
      return null;
    });
    if (!live) {
      /*
       * Could not ask, which is not the same as "there is nothing there".
       *
       * Reporting it as missing would speed polling back up, and polling goes
       * through the same API that just failed to answer — so it would buy
       * nothing and cost five times the requests at exactly the moment ClickUp
       * is struggling. The registration is assumed intact until the next pass
       * can actually check.
       */
      return { kind: "active", webhook: row };
    }

    const mine = live.find((webhook) => webhook.id === row.id);
    if (!mine) {
      // Deleted in ClickUp, by a person or by ClickUp itself. Forget it here so
      // the fall-through below registers a replacement.
      console.warn(`[webhook] ${row.id} is gone from ClickUp; re-registering`);
      await forgetWebhook(db, row.id);
      continue;
    }

    const status = mine.health?.status ?? "active";
    const failCount = mine.health?.fail_count ?? 0;

    if (status === "suspended") {
      /*
       * ClickUp stops delivering at `fail_count` 100, and immediately on a 401
       * or a 410. Only a status update restarts it, and nothing that was
       * dropped while it was down is ever resent.
       *
       * There is no repair to run here. The events lost during the suspension
       * are exactly what incremental polling with `date_updated_gt` picks up on
       * its next pass, because polling never depended on the webhook. That is
       * the whole reason it stays.
       */
      const revived = await client
        .updateWebhook(row.id, { endpoint, events: [...WEBHOOK_TASK_EVENTS], status: "active" })
        .catch((error) => {
          console.error(`[webhook] could not reactivate ${row.id}:`, messageOf(error));
          return null;
        });
      if (!revived) return { kind: "failing", webhook: row, failCount };
      console.log(`[webhook] ${row.id} was suspended and has been reactivated`);
      return { kind: "active", webhook: row };
    }

    if (failCount > 0) return { kind: "failing", webhook: row, failCount };
    return { kind: "active", webhook: row };
  }

  return register(db, pool, config, endpoint);
}

/**
 * Registers a webhook, adopting one that is already there if ClickUp will tell
 * us its secret.
 *
 * The adoption path matters on a fresh database pointed at a workspace that has
 * been through this before: without it, every deploy against an empty mirror
 * would leave another webhook behind, all of them delivering to the same
 * endpoint, and only the newest one verifiable.
 */
async function register(
  db: Db,
  pool: TokenPool,
  config: Config,
  endpoint: string,
): Promise<WebhookState> {
  const entry = pool.next();
  if (!entry) return { kind: "none", reason: "no ClickUp token" };

  const teamId = config.CLICKUP_TEAM_ID ?? entry.teamId;

  try {
    const existing = await entry.client.getWebhooks(teamId);
    const mine = existing.find((webhook) => webhook.endpoint === endpoint);

    if (mine?.secret) {
      await saveWebhook(db, {
        id: mine.id,
        teamId,
        endpoint,
        userId: entry.userId,
        secret: mine.secret,
        key: config.encryptionKey,
      });
      console.log(`[webhook] adopted existing webhook ${mine.id}`);
      return { kind: "active", webhook: await required(db, config, mine.id) };
    }

    if (mine) {
      /*
       * Our endpoint, but ClickUp did not hand back the secret, so nothing it
       * delivers can be verified and every delivery will be refused. Leaving it
       * would mean adding another one beside it on every boot, each of them
       * failing towards suspension. It is addressed to us, so it is ours to
       * remove.
       */
      console.warn(`[webhook] ${mine.id} points here but has no readable secret; replacing it`);
      await entry.client.deleteWebhook(mine.id).catch((error) => {
        console.error(`[webhook] could not delete ${mine.id}:`, messageOf(error));
      });
    }

    const created = await entry.client.createWebhook(teamId, {
      endpoint,
      events: [...WEBHOOK_TASK_EVENTS],
      // Unset in production, where the whole Workspace is mirrored. Set to
      // narrow a first rollout — or a developer's funnel — to one List.
      listId: config.CLICKUP_WEBHOOK_LIST_ID,
    });

    if (!created.secret) {
      // Without the secret nothing it delivers can be verified, and ClickUp
      // only ever hands it over at creation. A webhook we cannot authenticate
      // is worse than none, so it goes back.
      await entry.client.deleteWebhook(created.id).catch(() => {});
      return { kind: "none", reason: "ClickUp created a webhook without a secret" };
    }

    await saveWebhook(db, {
      id: created.id,
      teamId,
      endpoint,
      userId: entry.userId,
      secret: created.secret,
      key: config.encryptionKey,
    });
    console.log(
      `[webhook] registered ${created.id} -> ${endpoint}` +
        (config.CLICKUP_WEBHOOK_LIST_ID ? ` (list ${config.CLICKUP_WEBHOOK_LIST_ID})` : ""),
    );
    return { kind: "active", webhook: await required(db, config, created.id) };
  } catch (error) {
    console.error("[webhook] registration failed:", messageOf(error));
    return { kind: "none", reason: messageOf(error) };
  }
}

/** Reads back what we just stored, so callers get the decrypted row, not the input. */
async function required(db: Db, config: Config, id: string): Promise<StoredWebhook> {
  const rows = await loadWebhooks(db, config.encryptionKey);
  const found = rows.find((row) => row.id === id);
  if (!found) throw new Error(`webhook ${id} vanished immediately after being stored`);
  return found;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
