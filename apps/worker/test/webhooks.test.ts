import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ClickUpClient, RateLimiter } from "@rask/clickup-client";
import { createTestDb, enqueueWebhookEvent, tasks, webhookEvents } from "@rask/schema";
import { eq, inArray } from "drizzle-orm";
import type { TokenPool } from "../src/tokens.ts";
import { drainWebhookEvents, MAX_WEBHOOK_ATTEMPTS } from "../src/webhooks.ts";

/**
 * The read-back path, against a real database.
 *
 * A ClickUp event says which task changed and nothing else, so the entire
 * behaviour worth testing is what the queue does with the delivery patterns
 * ClickUp actually produces: the same event twice, two events for one task,
 * events in the wrong order, and events for a task that is no longer there.
 * All of them have to converge on the same mirror, or a lost webhook is not
 * the worst thing that can happen — a wrong one is.
 */

const db = createTestDb();

const TASK_IDS = ["hookA", "hookB", "hookC"];

async function cleanup() {
  await db.delete(webhookEvents).where(inArray(webhookEvents.taskId, TASK_IDS));
  await db.delete(tasks).where(inArray(tasks.id, TASK_IDS));
}

beforeEach(cleanup);
afterEach(cleanup);

interface Fetched {
  url: string;
}

/**
 * A token pool of one, over a ClickUp that answers from a lookup table.
 *
 * `answers` maps a task id to what `GET /task/{id}` returns, or to a status
 * code to fail with. Anything not listed 500s, which is how "ClickUp is having
 * a bad minute" is spelled here.
 */
function makePool(answers: Record<string, { status?: number; body?: unknown }>) {
  const fetched: Fetched[] = [];

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push({ url });
    const id = url.split("/v2/task/")[1]?.split("?")[0] ?? "";
    const answer = answers[id] ?? { status: 500 };
    return new Response(JSON.stringify(answer.body ?? { err: "boom", ECODE: "X" }), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const client = new ClickUpClient({
    token: "pk_test",
    fetch: fetchImpl,
    limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
    // No retry inside the client: the queue's own backoff is what is under test,
    // and three jittered sleeps per failure would make this slow for nothing.
    maxRetries: 0,
    sleep: async () => {},
  });

  const pool = {
    size: 1,
    next: () => ({ userId: "u1", client, teamId: "t1" }),
    for: async () => client,
  } as unknown as TokenPool;

  return { pool, fetched };
}

function task(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `task ${id}`,
    date_updated: "1700000000000",
    list: { id: "list-1", name: "List" },
    ...over,
  };
}

async function queued(taskId: string) {
  const [row] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.taskId, taskId))
    .limit(1);
  return row ?? null;
}

async function mirrored(taskId: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row ?? null;
}

describe("enqueueing", () => {
  test("coalesces repeat events for one task into a single read-back", async () => {
    // ClickUp fires taskUpdated and taskStatusUpdated for the same edit, and
    // will happily send either twice. Someone dragging a card across a board
    // must not cost one GET per event.
    for (const event of ["taskUpdated", "taskStatusUpdated", "taskUpdated"]) {
      await enqueueWebhookEvent(db, { taskId: "hookA", event });
    }

    const { pool, fetched } = makePool({ hookA: { body: task("hookA") } });
    const result = await drainWebhookEvents(db, pool);

    expect(result.done).toBe(1);
    expect(fetched).toHaveLength(1);
  });

  test("keeps the newest event name when two collapse", async () => {
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskUpdated" });
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskDeleted" });

    expect((await queued("hookA"))?.event).toBe("taskDeleted");
  });

  test("does not lose the webhook id to a delivery that omitted it", async () => {
    // The id is how a misbehaving registration gets traced back. Overwriting it
    // with a null would make the row useless for exactly that.
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskUpdated", webhookId: "wh-1" });
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskStatusUpdated" });

    expect((await queued("hookA"))?.webhookId).toBe("wh-1");
  });

  test("does not reset a row that is already backing off", async () => {
    // A task producing events every few seconds would otherwise never reach the
    // give-up point where polling is allowed to take over.
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskUpdated" });
    const { pool } = makePool({});
    await drainWebhookEvents(db, pool);

    const backedOff = await queued("hookA");
    expect(backedOff?.attempts).toBe(1);

    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskUpdated" });

    const after = await queued("hookA");
    expect(after?.attempts).toBe(1);
    expect(after?.nextAttemptAt).toEqual(backedOff?.nextAttemptAt as Date);
  });
});

describe("read-back", () => {
  test("mirrors the task the event named and clears the row", async () => {
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskUpdated" });

    const { pool } = makePool({ hookA: { body: task("hookA", { name: "renamed" }) } });
    await drainWebhookEvents(db, pool);

    expect((await mirrored("hookA"))?.name).toBe("renamed");
    expect(await queued("hookA")).toBeNull();
  });

  test("lands on the same mirror whatever order the events arrived in", async () => {
    // The out-of-order case, which the read-back makes moot: the fetch returns
    // what ClickUp holds now, not what the event described, so an old event
    // processed late cannot write stale data.
    const { pool } = makePool({ hookA: { body: task("hookA", { name: "current" }) } });

    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskStatusUpdated" });
    await drainWebhookEvents(db, pool);
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskCreated" });
    await drainWebhookEvents(db, pool);

    expect((await mirrored("hookA"))?.name).toBe("current");
  });

  test("marks a task deleted without spending a request on it", async () => {
    await db.insert(tasks).values({ id: "hookA", listId: "list-1", name: "doomed" });
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskDeleted" });

    const { pool, fetched } = makePool({});
    await drainWebhookEvents(db, pool);

    expect((await mirrored("hookA"))?.deletedAt).toBeInstanceOf(Date);
    expect(fetched).toHaveLength(0);
  });

  test("treats a 404 on read-back as a deletion, not a failure", async () => {
    // The `taskDeleted` event is the one most likely to be the one ClickUp
    // drops, so a 404 here is usually how a deletion is actually learned.
    await db.insert(tasks).values({ id: "hookB", listId: "list-1", name: "gone" });
    await enqueueWebhookEvent(db, { taskId: "hookB", event: "taskUpdated" });

    const { pool } = makePool({ hookB: { status: 404, body: { err: "Task not found" } } });
    const result = await drainWebhookEvents(db, pool);

    expect(result.done).toBe(1);
    expect(result.deferred).toBe(0);
    expect((await mirrored("hookB"))?.deletedAt).toBeInstanceOf(Date);
    expect(await queued("hookB")).toBeNull();
  });

  test("mirrors a task the poll has never seen", async () => {
    // taskCreated in a list nobody has opened. The row lands anyway; whether
    // the list is worth polling is a separate decision, and stays one.
    await enqueueWebhookEvent(db, { taskId: "hookC", event: "taskCreated" });

    const { pool } = makePool({ hookC: { body: task("hookC") } });
    await drainWebhookEvents(db, pool);

    expect((await mirrored("hookC"))?.listId).toBe("list-1");
  });
});

describe("failure", () => {
  test("keeps the row and backs off when ClickUp is unavailable", async () => {
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskUpdated" });

    const { pool } = makePool({ hookA: { status: 502 } });
    const result = await drainWebhookEvents(db, pool);

    expect(result.deferred).toBe(1);
    const row = await queued("hookA");
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("gives up after the attempt budget and lets polling repair it", async () => {
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskUpdated" });
    // Already spent its budget; the claim makes this the last attempt.
    await db
      .update(webhookEvents)
      .set({ attempts: MAX_WEBHOOK_ATTEMPTS - 1 })
      .where(eq(webhookEvents.taskId, "hookA"));

    const { pool } = makePool({ hookA: { status: 502 } });
    const result = await drainWebhookEvents(db, pool);

    expect(result.dropped).toBe(1);
    expect(await queued("hookA")).toBeNull();
  });

  test("leaves rows alone when there is no token to process them with", async () => {
    // Claiming costs an attempt, so an empty pool must not burn the budget of
    // every queued event while nobody is signed in.
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskUpdated" });
    const empty = { size: 0, next: () => null } as unknown as TokenPool;

    const result = await drainWebhookEvents(db, empty);

    expect(result).toEqual({ done: 0, deferred: 0, dropped: 0 });
    expect((await queued("hookA"))?.attempts).toBe(0);
  });

  test("does not claim a row whose backoff has not elapsed", async () => {
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskUpdated" });
    await db
      .update(webhookEvents)
      .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(webhookEvents.taskId, "hookA"));

    const { pool, fetched } = makePool({ hookA: { body: task("hookA") } });
    const result = await drainWebhookEvents(db, pool);

    expect(result.done).toBe(0);
    expect(fetched).toHaveLength(0);
  });
});

/**
 * The read-back forces the ingest, and that is not a detail.
 *
 * `ingestTasks` skips rows whose `date_updated` has not moved, so the nightly
 * full resync does not rewrite 147,000 unchanged rows and flood SSE. A webhook
 * is the opposite situation: ClickUp has named one task and said it changed.
 *
 * Unforced, any change that leaves `date_updated` alone is delivered, read back
 * and then dropped on the floor with no error anywhere. Time tracked against a
 * task is one such change — it moves `time_spent` and nothing else — and it is
 * what made this visible.
 */
describe("forcing the read-back", () => {
  test("stores a new total even though date_updated did not move", async () => {
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskCreated" });
    await drainWebhookEvents(
      db,
      makePool({ hookA: { body: task("hookA", { time_spent: 3_600_000 }) } }).pool,
    );
    expect((await mirrored("hookA"))?.timeSpent).toBe(3_600_000);

    // Same `date_updated`: ClickUp does not consider the task itself edited.
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskTimeTrackedUpdated" });
    const { pool, fetched } = makePool({
      hookA: { body: task("hookA", { time_spent: 7_200_000 }) },
    });
    const result = await drainWebhookEvents(db, pool);

    expect(result.done).toBe(1);
    expect(fetched).toHaveLength(1);
    expect((await mirrored("hookA"))?.timeSpent).toBe(7_200_000);
  });

  test("moves synced_at, so the change feed pushes it to the open tab", async () => {
    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskUpdated" });
    await drainWebhookEvents(db, makePool({ hookA: { body: task("hookA") } }).pool);

    const before = new Date("2020-01-01T00:00:00Z");
    await db.update(tasks).set({ syncedAt: before }).where(eq(tasks.id, "hookA"));

    await enqueueWebhookEvent(db, { taskId: "hookA", event: "taskTimeTrackedUpdated" });
    await drainWebhookEvents(db, makePool({ hookA: { body: task("hookA") } }).pool);

    // Without the force this row is skipped, synced_at stays in 2020, and the
    // tab looking at the task never hears that anything happened.
    expect((await mirrored("hookA"))?.syncedAt.getTime()).toBeGreaterThan(before.getTime());
  });
});
