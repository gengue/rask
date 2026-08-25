import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ClickUpClient, RateLimiter } from "@rask/clickup-client";
import { placeholderId } from "@rask/clickup-client/vocabulary";
import {
  comments,
  createTestDb,
  type OutboxOp,
  type OutboxStatus,
  outbox,
  taskAssignees,
  tasks,
  users,
} from "@rask/schema";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { drainOutbox, MAX_ATTEMPTS } from "../src/outbox.ts";
import type { TokenPool } from "../src/tokens.ts";

/**
 * The outbox drain, against a real database and a ClickUp that answers from a
 * routing table.
 *
 * This is the only code path in Rask that can destroy data the user cannot get
 * back: it deletes rows by id, it re-posts on retry, and it is the thing that
 * decides whether a rejected write leaves the mirror telling the truth or
 * telling a story. None of that is observable without Postgres, because all of
 * it is expressed as statements against Postgres.
 */

const db = createTestDb();
/** A second connection, so a lock can be held while the drain runs. */
const holder = createTestDb();

const USER = "drain-test-user";
const TASK = "drain-test-task";
const LIST = "drain-test-list";
const ALICE = "8801";
const BOB = "8802";

/** The browser's id for an optimistic row. Also, deliberately, a valid task id. */
const CREATE_CLIENT = "drain-create-1";
const COMMENT_CLIENT = "drain-comment-1";
const REPLY_CLIENT = "drain-reply-1";
const PARENT_COMMENT = "drain-parent-comment";

const CLICKUP_UPDATED = 1_700_000_000_000;
const CLICKUP_DUE = 1_700_500_000_000;

// --- a ClickUp that answers from a table ----------------------------------

interface Answer {
  status?: number;
  body?: unknown;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A token pool of one, over a ClickUp built from `routes`.
 *
 * Keys are `"<METHOD> <path>"`. Anything unrouted answers 500, which is how
 * "ClickUp is having a bad minute" is spelled here, and every request is
 * recorded so a test can assert on what was *not* sent as well as what was.
 */
function clickUp(routes: Record<string, Answer>) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api/, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });

    const answer = routes[`${method} ${path}`] ?? { status: 500 };
    return new Response(JSON.stringify(answer.body ?? { err: "rejected", ECODE: "TEST_001" }), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const client = new ClickUpClient({
    token: "pk_test",
    fetch: fetchImpl,
    limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
    // The drain's own backoff is what is under test; the client retrying a 5xx
    // three times inside it would only make this slow.
    maxRetries: 0,
    sleep: async () => {},
  });

  const pool = {
    size: 1,
    next: () => ({ userId: USER, client, teamId: "t1" }),
    /*
     * Only this file's user has a token.
     *
     * `claim` is global on purpose: in production one worker drains the whole
     * queue. Each package now has its own test database (`scripts/db-test.ts`),
     * so a foreign row is no longer the hazard it was — but refusing an unknown
     * user is still the cheapest way to keep a stray row from being sent to
     * this stub as if it were ours.
     */
    for: async (userId: string) => (userId === USER ? client : null),
  } as unknown as TokenPool;

  const count = (method: string, path: string) =>
    calls.filter((c) => c.method === method && c.path === path).length;

  return { pool, calls, count };
}

/** What `GET /task/{id}` returns: ClickUp's truth, which the mirror disagrees with. */
function upstreamTask(over: Record<string, unknown> = {}) {
  return {
    id: TASK,
    name: "as ClickUp has it",
    status: { id: "s1", status: "in progress", color: "#f2c94c", orderindex: 1, type: "custom" },
    priority: { id: "2", priority: "high", color: "#ffcc00", orderindex: "2" },
    date_created: String(CLICKUP_UPDATED),
    date_updated: String(CLICKUP_UPDATED),
    due_date: String(CLICKUP_DUE),
    list: { id: LIST },
    assignees: [{ id: Number(BOB), username: "bob" }],
    ...over,
  };
}

// --- fixtures -------------------------------------------------------------

/**
 * The mirror as `applyTaskPatch` leaves it: the user's values written straight
 * in, and `date_updated` untouched, because ClickUp has not answered yet.
 */
async function seedOptimisticTask() {
  await db.insert(tasks).values({
    id: TASK,
    listId: LIST,
    name: "renamed in the browser",
    status: "done",
    priority: 1,
    dueDate: new Date("2030-01-01T00:00:00Z"),
    dateCreated: new Date(CLICKUP_UPDATED),
    dateUpdated: new Date(CLICKUP_UPDATED),
  });
  await db.insert(taskAssignees).values({ taskId: TASK, userId: ALICE });
}

async function queue(row: {
  op: OutboxOp;
  payload: Record<string, unknown>;
  entityId?: string | null;
  clientId?: string | null;
  attempts?: number;
  status?: OutboxStatus;
  nextAttemptAt?: Date;
}): Promise<number> {
  const [inserted] = await db
    .insert(outbox)
    .values({ userId: USER, ...row })
    .returning({ id: outbox.id });
  if (!inserted) throw new Error("outbox insert returned nothing");
  return inserted.id;
}

async function queued(id: number) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id)).limit(1);
  return row ?? null;
}

async function mirrored(taskId = TASK) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row ?? null;
}

/**
 * Whether a placeholder was retired in the way the browser can hear about.
 *
 * Deleting the row outright is not that way, and reads as success from
 * anywhere except a browser: the change feed is a query over `tasks.synced_at`,
 * so a row that no longer exists produces no frame, and the copy every open tab
 * received when the API inserted the placeholder stays on screen next to the
 * real task for the life of the session.
 */
async function retired(taskId: string): Promise<boolean> {
  const row = await mirrored(taskId);
  if (!row) return false;
  return row.deletedAt !== null && row.syncedAt.getTime() >= Date.now() - 60_000;
}

async function assignees() {
  const rows = await db
    .select({ userId: taskAssignees.userId })
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, TASK))
    .orderBy(asc(taskAssignees.userId));
  return rows.map((r) => r.userId);
}

async function commentIds() {
  const rows = await db
    .select({ id: comments.id })
    .from(comments)
    .where(eq(comments.taskId, TASK))
    .orderBy(asc(comments.id));
  return rows.map((r) => r.id);
}

// --- watching the order the drain writes in -------------------------------

/*
 * The API's change feed polls `outbox.status = 'failed'` and pushes a
 * "ClickUp rejected that" toast to the author within a second. So the only
 * question that matters about a rejection is what the mirror held at the
 * instant that row turned `failed` — not what it holds once the dust settles.
 *
 * A trigger is the one vantage point that can answer it: it runs inside the
 * UPDATE itself, sees exactly the snapshot the feed's next poll will see, and
 * is blind to anything the drain does afterwards. Asserting on the final row
 * would pass just as happily with the two statements swapped back.
 */
const PROBE_USER_LITERAL = `'${USER}'`;

async function installFailureProbe() {
  await db.execute(sql`
    create table if not exists drain_test_failure_probe (
      seq bigserial primary key,
      outbox_id bigint not null,
      task_status text
    )`);
  await db.execute(sql`
    create or replace function drain_test_failure_probe_fn() returns trigger
    language plpgsql as $$
    begin
      insert into drain_test_failure_probe (outbox_id, task_status)
      select new.id, t.status from tasks t where t.id = new.entity_id;
      return new;
    end $$`);
  await db.execute(sql`drop trigger if exists drain_test_failure_probe_trg on outbox`);
  await db.execute(sql`
    create trigger drain_test_failure_probe_trg
      after update on outbox
      for each row
      when (new.status = 'failed' and new.user_id = ${sql.raw(PROBE_USER_LITERAL)})
      execute function drain_test_failure_probe_fn()`);
}

async function removeFailureProbe() {
  await db.execute(sql`drop trigger if exists drain_test_failure_probe_trg on outbox`);
  await db.execute(sql`drop function if exists drain_test_failure_probe_fn()`);
  await db.execute(sql`drop table if exists drain_test_failure_probe`);
}

/** What the mirror held when this row was marked failed. */
async function mirrorAtFailure(outboxId: number): Promise<Array<string | null>> {
  const result = await db.execute(sql`
    select task_status from drain_test_failure_probe
    where outbox_id = ${outboxId} order by seq`);
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Array<{ task_status: string | null }>;
  return rows.map((r) => r.task_status);
}

// --- lifecycle ------------------------------------------------------------

const OWNED_TASKS = [TASK, CREATE_CLIENT, placeholderId(CREATE_CLIENT)];

async function cleanup() {
  await db.delete(outbox).where(eq(outbox.userId, USER));
  await db.delete(tasks).where(inArray(tasks.id, OWNED_TASKS));
  await db.delete(users).where(inArray(users.id, [ALICE, BOB]));
  await db.execute(sql`delete from drain_test_failure_probe`);
}

beforeAll(installFailureProbe);
afterAll(removeFailureProbe);
beforeEach(cleanup);
afterEach(cleanup);

describe("a write ClickUp refuses", () => {
  test("has repaired the mirror by the time the row says failed", async () => {
    // Reverting after marking the row failed leaves a window where the toast
    // saying "ClickUp rejected that" reaches the browser while the browser is
    // still showing the value ClickUp rejected. It is a small window and it is
    // the one moment the user is looking, which is what makes the app look like
    // it is arguing with itself.
    await seedOptimisticTask();
    const id = await queue({ op: "update_task", entityId: TASK, payload: { status: "done" } });

    const { pool } = clickUp({
      [`PUT /v2/task/${TASK}`]: { status: 400, body: { err: "Status not found", ECODE: "T_1" } },
      // Somebody else edited the task upstream, so the guard in ingest is not
      // what is being measured here. Only the order is.
      [`GET /v2/task/${TASK}`]: {
        body: upstreamTask({ date_updated: String(CLICKUP_UPDATED + 60_000) }),
      },
    });
    const result = await drainOutbox(db, pool);

    expect(await mirrorAtFailure(id)).toEqual(["in progress"]);
    expect((await queued(id))?.status).toBe("failed");
    expect(result.failed).toBe(1);
  });

  test("repairs the whole row, not only the columns ingest replaces unconditionally", async () => {
    // ClickUp rejected the write, so its date_updated is unchanged — which is
    // exactly what ingest's skip guard reads as "nothing to do". Unforced, the
    // read-back puts the assignees back and leaves status, name, priority and
    // due date holding the value ClickUp refused, permanently. A row whose
    // assignees are ClickUp's and whose status is not is worse than either.
    await seedOptimisticTask();
    const id = await queue({ op: "update_task", entityId: TASK, payload: { status: "done" } });

    const { pool } = clickUp({
      [`PUT /v2/task/${TASK}`]: { status: 400, body: { err: "Status not found", ECODE: "T_1" } },
      [`GET /v2/task/${TASK}`]: { body: upstreamTask() },
    });
    await drainOutbox(db, pool);

    const row = await mirrored();
    expect(row?.status).toBe("in progress");
    expect(row?.name).toBe("as ClickUp has it");
    expect(row?.priority).toBe(2);
    expect(row?.dueDate).toEqual(new Date(CLICKUP_DUE));
    expect(await assignees()).toEqual([BOB]);
    expect((await queued(id))?.status).toBe("failed");
  });

  test("keeps the reason, because the toast is the only thing the user sees", async () => {
    await seedOptimisticTask();
    const id = await queue({ op: "update_task", entityId: TASK, payload: { status: "done" } });

    const { pool } = clickUp({
      [`PUT /v2/task/${TASK}`]: { status: 400, body: { err: "Status not found", ECODE: "T_1" } },
      [`GET /v2/task/${TASK}`]: { body: upstreamTask() },
    });
    await drainOutbox(db, pool);

    expect((await queued(id))?.lastError).toContain("Status not found");
  });
});

describe("undoing a create", () => {
  test("deletes the placeholder and not the task whose id looks like the client id", async () => {
    // The placeholder is `tmp_` + the client id, and the client id is a string
    // the browser made up. Deleting by the client id itself — one missing call
    // to placeholderId() — deletes a real task out of the mirror, and nothing
    // upstream deleted it, so nothing will ever bring it back.
    await db.insert(tasks).values([
      { id: placeholderId(CREATE_CLIENT), listId: LIST, name: "typed a second ago" },
      { id: CREATE_CLIENT, listId: LIST, name: "a task that exists in ClickUp" },
    ]);
    const id = await queue({
      op: "create_task",
      clientId: CREATE_CLIENT,
      payload: { listId: LIST, name: "typed a second ago" },
    });

    const { pool } = clickUp({
      [`POST /v2/list/${LIST}/task`]: { status: 400, body: { err: "Bad status", ECODE: "T_2" } },
    });
    await drainOutbox(db, pool);

    expect(await retired(placeholderId(CREATE_CLIENT))).toBe(true);
    expect((await mirrored(CREATE_CLIENT))?.name).toBe("a task that exists in ClickUp");
    expect((await mirrored(CREATE_CLIENT))?.deletedAt).toBeNull();
    expect((await queued(id))?.status).toBe("failed");
  });

  test("deletes the placeholder comment and not the comment whose id looks like it", async () => {
    // Same trap as the task create, and the row it would take out is somebody
    // else's comment on a task they are reading right now.
    await seedOptimisticTask();
    await db.insert(comments).values([
      { id: placeholderId(COMMENT_CLIENT), taskId: TASK, text: "sending…" },
      { id: COMMENT_CLIENT, taskId: TASK, text: "a comment that exists in ClickUp" },
    ]);
    await queue({
      op: "create_comment",
      entityId: TASK,
      clientId: COMMENT_CLIENT,
      payload: { taskId: TASK, text: "sending…", parentId: null },
    });

    const { pool } = clickUp({
      [`POST /v2/task/${TASK}/comment`]: { status: 400, body: { err: "Nope", ECODE: "C_1" } },
    });
    await drainOutbox(db, pool);

    expect(await commentIds()).toEqual([COMMENT_CLIENT]);
  });

  test("takes back the reply it optimistically added to the thread's count", async () => {
    // The count is what the UI renders next to the thread. Left one too high it
    // promises a reply that is not there, and the repair cannot be a refetch:
    // the token that failed the write is the token that would have to do it.
    await seedOptimisticTask();
    await db.insert(comments).values([
      { id: PARENT_COMMENT, taskId: TASK, text: "the thread", replyCount: 3 },
      {
        id: placeholderId(REPLY_CLIENT),
        taskId: TASK,
        parentCommentId: PARENT_COMMENT,
        text: "sending…",
      },
    ]);
    await queue({
      op: "create_comment",
      entityId: TASK,
      clientId: REPLY_CLIENT,
      payload: { taskId: TASK, text: "sending…", parentId: PARENT_COMMENT },
    });

    const { pool } = clickUp({
      [`POST /v2/comment/${PARENT_COMMENT}/reply`]: {
        status: 400,
        body: { err: "Nope", ECODE: "C_1" },
      },
    });
    await drainOutbox(db, pool);

    const [parent] = await db
      .select({ replyCount: comments.replyCount })
      .from(comments)
      .where(eq(comments.id, PARENT_COMMENT));
    expect(parent?.replyCount).toBe(2);
    expect(await commentIds()).toEqual([PARENT_COMMENT]);
  });
});

describe("a write ClickUp could not answer", () => {
  test("goes back in the queue instead of being thrown away", async () => {
    // A 502 is ClickUp having a minute, not a rejection. Treating it as one
    // loses the user's edit and tells them it was refused, which is a lie they
    // have no way to check.
    await seedOptimisticTask();
    const id = await queue({ op: "update_task", entityId: TASK, payload: { status: "done" } });

    const { pool } = clickUp({ [`PUT /v2/task/${TASK}`]: { status: 502 } });
    const before = Date.now();
    const result = await drainOutbox(db, pool);

    const row = await queued(id);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(before);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.deferred).toBeGreaterThanOrEqual(1);
  });

  test("leaves the mirror alone, because the write may still land", async () => {
    // Reverting on a transient failure would snatch the user's change back and
    // then reapply it seconds later when the retry succeeds. The value flickers
    // and they cannot tell whether it saved.
    await seedOptimisticTask();
    await queue({ op: "update_task", entityId: TASK, payload: { status: "done" } });

    const { pool, calls } = clickUp({ [`PUT /v2/task/${TASK}`]: { status: 502 } });
    await drainOutbox(db, pool);

    expect((await mirrored())?.status).toBe("done");
    expect(await assignees()).toEqual([ALICE]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  test("stops retrying once the attempt budget is gone, and repairs on the way out", async () => {
    // Without the budget a permanently unreachable endpoint keeps one row
    // cycling forever and the user is never told anything is wrong. Giving up
    // has to repair the mirror too — a row abandoned still holding an
    // optimistic value is the same lie as a rejected one.
    await seedOptimisticTask();
    const id = await queue({
      op: "update_task",
      entityId: TASK,
      payload: { status: "done" },
      attempts: MAX_ATTEMPTS - 1,
    });

    const { pool } = clickUp({
      [`PUT /v2/task/${TASK}`]: { status: 502 },
      [`GET /v2/task/${TASK}`]: { body: upstreamTask() },
    });
    const result = await drainOutbox(db, pool);

    const row = await queued(id);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(MAX_ATTEMPTS);
    expect(result.failed).toBe(1);
    expect((await mirrored())?.status).toBe("in progress");
  });
});

describe("a comment that reached ClickUp", () => {
  test("is not posted a second time when the read-back fails", async () => {
    // Past the POST the comment exists upstream, so a retry does not retry
    // anything — it posts a duplicate, under the user's name, on a task other
    // people are reading. Nothing in the type system stops a future line from
    // throwing there; this is what notices.
    await seedOptimisticTask();
    await db
      .insert(comments)
      .values({ id: placeholderId(COMMENT_CLIENT), taskId: TASK, text: "sending…" });
    const id = await queue({
      op: "create_comment",
      entityId: TASK,
      clientId: COMMENT_CLIENT,
      payload: { taskId: TASK, text: "sending…", parentId: null },
    });

    const { pool, count } = clickUp({
      [`POST /v2/task/${TASK}/comment`]: { body: { id: "real-comment-1" } },
      // The read-back that gives the row its real id, author and reply count.
      [`GET /v2/task/${TASK}/comment`]: { status: 500 },
    });

    await drainOutbox(db, pool);
    // Two seconds of backoff, gone. If anything after the POST had thrown, the
    // row would be pending again and this is the retry that duplicates it.
    await db.update(outbox).set({ nextAttemptAt: new Date() }).where(eq(outbox.userId, USER));
    await drainOutbox(db, pool);

    expect(count("POST", `/v2/task/${TASK}/comment`)).toBe(1);
    expect((await queued(id))?.status).toBe("done");
    expect(await commentIds()).toEqual([]);
  });

  test("is not replied a second time when the thread read-back fails", async () => {
    // The reply endpoint answers with an empty body, so the row's real id only
    // ever comes from the thread refetch. That refetch failing must not be
    // allowed to mean the reply is sent again.
    await seedOptimisticTask();
    await db.insert(comments).values([
      { id: PARENT_COMMENT, taskId: TASK, text: "the thread", replyCount: 3 },
      {
        id: placeholderId(REPLY_CLIENT),
        taskId: TASK,
        parentCommentId: PARENT_COMMENT,
        text: "sending…",
      },
    ]);
    const id = await queue({
      op: "create_comment",
      entityId: TASK,
      clientId: REPLY_CLIENT,
      payload: { taskId: TASK, text: "sending…", parentId: PARENT_COMMENT },
    });

    const { pool, count } = clickUp({
      [`POST /v2/comment/${PARENT_COMMENT}/reply`]: { body: {} },
      [`GET /v2/comment/${PARENT_COMMENT}/reply`]: { status: 500 },
    });

    await drainOutbox(db, pool);
    await db.update(outbox).set({ nextAttemptAt: new Date() }).where(eq(outbox.userId, USER));
    await drainOutbox(db, pool);

    expect(count("POST", `/v2/comment/${PARENT_COMMENT}/reply`)).toBe(1);
    expect((await queued(id))?.status).toBe("done");
  });
});

describe("read-backs that follow a write ClickUp accepted", () => {
  test("a tag write's refetch is actually applied", async () => {
    // ClickUp does not move date_updated for a tag change, so the guard in
    // ingest would skip the row this GET was made for and the request would be
    // paid for and thrown away — leaving whatever the mirror already believed,
    // including the tag colour the write was made to learn.
    await seedOptimisticTask();
    const id = await queue({
      op: "add_tag",
      entityId: TASK,
      payload: { taskId: TASK, tag: "performance" },
    });

    const { pool } = clickUp({
      [`POST /v2/task/${TASK}/tag/performance`]: { body: {} },
      [`GET /v2/task/${TASK}`]: {
        body: upstreamTask({
          tags: [{ name: "performance", tag_fg: "#FFFFFF", tag_bg: "#EA4335", creator: 183 }],
        }),
      },
    });
    await drainOutbox(db, pool);

    expect((await mirrored())?.tags).toEqual([
      { name: "performance", fg: "#FFFFFF", bg: "#EA4335" },
    ]);
    expect((await mirrored())?.status).toBe("in progress");
    expect((await queued(id))?.status).toBe("done");
  });

  /*
   * Clearing has its own verb.
   *
   * Every body the field endpoint accepts is a value of some type and none of
   * them is none, so an emptied field posted as `{ value: null }` comes back
   * refused — as a "ClickUp rejected your change" toast for a field the author
   * only meant to empty. The stub answers 500 to anything it was not given, so
   * a POST here fails the row rather than passing quietly.
   */
  test("clearing a custom field deletes it rather than posting nothing", async () => {
    await seedOptimisticTask();
    const id = await queue({
      op: "set_custom_field",
      entityId: TASK,
      payload: { taskId: TASK, fieldId: "f1", value: null },
    });

    const { pool, calls } = clickUp({
      [`DELETE /v2/task/${TASK}/field/f1`]: { body: {} },
      [`GET /v2/task/${TASK}`]: { body: upstreamTask() },
    });
    await drainOutbox(db, pool);

    expect((await queued(id))?.status).toBe("done");
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  test("a custom field write's refetch is actually applied", async () => {
    // Same shape: setting a Custom Field does not move date_updated either.
    await seedOptimisticTask();
    const id = await queue({
      op: "set_custom_field",
      entityId: TASK,
      payload: { taskId: TASK, fieldId: "f1", value: "opt-2" },
    });

    const { pool } = clickUp({
      [`POST /v2/task/${TASK}/field/f1`]: { body: {} },
      [`GET /v2/task/${TASK}`]: { body: upstreamTask() },
    });
    await drainOutbox(db, pool);

    expect((await mirrored())?.status).toBe("in progress");
    expect((await queued(id))?.status).toBe("done");
  });
});

describe("claiming", () => {
  /*
   * Two workers drain the same table. Without SKIP LOCKED the second one blocks
   * on the first one's rows instead of getting on with the rest of the queue,
   * and every write behind them waits — which is what a queue is supposed to
   * prevent. Worse, without the row lock at all, they both send the same write.
   *
   * The explicit timeout is because a drain that blocks rather than skips would
   * otherwise hang here instead of failing.
   */
  test("leaves a row another worker is already holding to that worker", async () => {
    await seedOptimisticTask();
    const held = await queue({ op: "update_task", entityId: TASK, payload: { name: "held" } });
    const free = await queue({ op: "update_task", entityId: TASK, payload: { name: "free" } });

    const { pool } = clickUp({ [`PUT /v2/task/${TASK}`]: { body: upstreamTask() } });

    let lock!: () => void;
    const locked = new Promise<void>((resolve) => {
      lock = resolve;
    });
    let unlock!: () => void;
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });

    const holding = holder.transaction(async (tx) => {
      await tx.execute(sql`select id from ${outbox} where id = ${held} for update`);
      lock();
      await released;
    });

    try {
      await locked;
      await drainOutbox(db, pool);
    } finally {
      unlock();
      await holding;
    }

    const skipped = await queued(held);
    expect(skipped?.status).toBe("pending");
    expect(skipped?.attempts).toBe(0);
    expect((await queued(free))?.status).toBe("done");
  }, 5_000);

  test("does not touch a row whose backoff has not elapsed", async () => {
    // Backoff is the only thing keeping a row that fails instantly from
    // spinning through its five attempts in a millisecond and being given up on
    // before ClickUp has finished restarting.
    await seedOptimisticTask();
    const id = await queue({
      op: "update_task",
      entityId: TASK,
      payload: { status: "done" },
      attempts: 1,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });

    const { pool, calls } = clickUp({ [`PUT /v2/task/${TASK}`]: { body: upstreamTask() } });
    await drainOutbox(db, pool);

    const row = await queued(id);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("does not re-claim a row that is already out for delivery", async () => {
    // `sending` means some worker has this row in flight. Claiming it again is
    // how one edit becomes two comments, or two tag writes ClickUp counts twice.
    await seedOptimisticTask();
    const id = await queue({
      op: "update_task",
      entityId: TASK,
      payload: { status: "done" },
      status: "sending",
    });

    const { pool, calls } = clickUp({ [`PUT /v2/task/${TASK}`]: { body: upstreamTask() } });
    await drainOutbox(db, pool);

    expect((await queued(id))?.status).toBe("sending");
    expect(calls).toHaveLength(0);
  });
});

describe("a create ClickUp accepted", () => {
  test("swaps the placeholder for the real row and remembers the id", async () => {
    // The placeholder and the real task both exist for a moment. Leaving the
    // placeholder behind shows the task twice in the list, and one of the two
    // is a row no later poll will ever touch or remove — and "leaving it
    // behind" includes deleting it, since the only way the browser hears about
    // a row is the change feed, and the feed cannot see a row that is gone.
    await db
      .insert(tasks)
      .values({ id: placeholderId(CREATE_CLIENT), listId: LIST, name: "typed a second ago" });
    const id = await queue({
      op: "create_task",
      clientId: CREATE_CLIENT,
      payload: { listId: LIST, name: "typed a second ago" },
    });

    const { pool } = clickUp({
      [`POST /v2/list/${LIST}/task`]: { body: upstreamTask({ name: "typed a second ago" }) },
    });
    await drainOutbox(db, pool);

    expect(await retired(placeholderId(CREATE_CLIENT))).toBe(true);
    expect((await mirrored())?.name).toBe("typed a second ago");
    // The API needs this to tell the author which task the failure or the
    // success was about.
    expect((await queued(id))?.entityId).toBe(TASK);
  });
});

describe("rows a dead worker left behind", () => {
  test("a row stuck in `sending` is taken back and sent", async () => {
    /*
     * `claim` is one autocommitted statement: it commits `sending` and drops
     * its lock before the work begins. A worker killed between those two points
     * used to strand the row forever — nothing else in the repo selects
     * `sending` — and the user was never told, because the change feed only
     * watches for `failed`. Their edit simply never happened.
     */
    await seedOptimisticTask();
    const stranded = await queue({
      op: "update_task",
      entityId: TASK,
      payload: { name: "written before the worker died" },
      status: "sending",
    });
    await db
      .update(outbox)
      .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(outbox.id, stranded));

    const { pool, count } = clickUp({ [`PUT /v2/task/${TASK}`]: { body: upstreamTask() } });
    const result = await drainOutbox(db, pool, 20);

    expect(result.sent).toBe(1);
    expect(count("PUT", `/v2/task/${TASK}`)).toBe(1);
    expect((await queued(stranded))?.status).toBe("done");
  });

  test("a row another worker is still working on is left alone", async () => {
    // The other half of the bet. Reclaiming eagerly sends the same write twice,
    // which for a create means two tasks.
    await seedOptimisticTask();
    const inFlight = await queue({
      op: "update_task",
      entityId: TASK,
      payload: { name: "someone else is sending this right now" },
      status: "sending",
    });

    const { pool, count } = clickUp({ [`PUT /v2/task/${TASK}`]: { body: upstreamTask() } });
    await drainOutbox(db, pool, 20);

    expect(count("PUT", `/v2/task/${TASK}`)).toBe(0);
    expect((await queued(inFlight))?.status).toBe("sending");
  });
});
