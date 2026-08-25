import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  commentMentions,
  comments,
  createTestDb,
  inboxReads,
  oauthTokens,
  saveToken,
  sessions,
  TEST_DATABASE_URL,
  taskAssignees,
  tasks,
  users,
} from "@rask/schema";
import { eq, inArray, like } from "drizzle-orm";
import type * as honoModule from "hono";
import { hashSession } from "../src/auth.ts";
import { listTasks, notableComments } from "../src/queries.ts";

/**
 * The inbox window, over real rows.
 *
 * Two things here are silent when they break, which is why they are tested
 * against Postgres rather than reasoned about.
 *
 * The first is the order. `listTasks` truncates at the limit, so a page ordered
 * by due date drops whichever changes happen to be furthest down that ordering
 * rather than the oldest ones — and the inbox would quietly stop showing the
 * newest activity, which is the only thing it exists to show. Nothing about the
 * response says it happened.
 *
 * The second is which clock the cutoff reads. `synced_at` moves when Rask wrote
 * the row, so a nightly resync that changed nothing would fill everyone's inbox
 * with activity that never happened; `date_updated` is when a person did
 * something. They differ only under load, which is to say never in a test that
 * does not set them apart on purpose.
 */

const db = createTestDb();

const ID = (suffix: string) => `inb-${suffix}`;
/*
 * Numeric, because ClickUp's user ids are and `findMentions` only matches
 * digits — `@[name](clickup://user/inb-u-anna)` is not a mention, it is a link
 * to nothing. A fixture with prose ids passes every query in this file and
 * would have quietly asserted that mentions do not work.
 */
const ANNA = "990001";
const BEN = "990002";
const LIST = ID("list");

const KEY = Buffer.alloc(32, 7);
const COOKIE = "inbox-cookie";
const COOKIE_HEADER = `rask_session=${COOKIE}`;
let app: honoModule.Hono;

const MINUTE = 60_000;
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * MINUTE);

beforeAll(async () => {
  await cleanup();

  // Never the developer's own database: importing index.ts builds a pool from
  // the environment, and `.env` names the mirror of a real workspace.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.TOKEN_ENCRYPTION_KEY = KEY.toString("base64");
  process.env.SESSION_SECRET = "session-secret";
  process.env.CLICKUP_CLIENT_ID = "test-client-id";
  process.env.CLICKUP_CLIENT_SECRET = "test-client-secret";
  process.env.CLICKUP_REDIRECT_URI = "http://localhost:3000/auth/clickup/callback";
  process.env.SESSION_COOKIE_NAME = "rask_session";
  delete process.env.WEB_DIST;

  app = (await import("../src/index.ts")).app as unknown as honoModule.Hono;

  await db
    .insert(users)
    .values([
      { id: ANNA, username: "anna" },
      { id: BEN, username: "ben" },
    ])
    .onConflictDoNothing();

  // Anna signs in, so the routes below have somebody to answer as.
  await saveToken(db, { userId: ANNA, teamId: "9001", token: "oauth-token", key: KEY });
  await db.insert(sessions).values({
    id: hashSession(COOKIE),
    userId: ANNA,
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  await db.insert(tasks).values([
    {
      id: ID("fresh"),
      listId: LIST,
      name: "Changed a minute ago",
      status: "Open",
      statusType: "open",
      dateUpdated: ago(1),
      // Deliberately stale, and the opposite way round from `older` below: if
      // the cutoff ever reads synced_at, these two swap places and this file
      // says so.
      syncedAt: ago(500),
    },
    {
      id: ID("older"),
      listId: LIST,
      name: "Changed an hour ago",
      status: "Open",
      statusType: "open",
      dateUpdated: ago(60),
      syncedAt: ago(1),
      /*
       * Overdue, and the oldest change in the window.
       *
       * That combination is the whole point of the fixture: under the ordering
       * every other view uses this row leads the page, and under the inbox's it
       * comes last. Give the rows no due dates and the two orderings agree on
       * every one of them, and the test below asserts nothing.
       */
      dueDate: ago(10_000),
    },
    {
      id: ID("closed"),
      listId: LIST,
      name: "Somebody finished it",
      status: "Done",
      statusType: "done",
      dateUpdated: ago(5),
    },
    {
      id: ID("ancient"),
      listId: LIST,
      name: "Untouched for a fortnight",
      status: "Open",
      statusType: "open",
      dateUpdated: ago(20_160),
    },
    {
      id: ID("bens"),
      listId: LIST,
      name: "Not yours",
      status: "Open",
      statusType: "open",
      dateUpdated: ago(2),
    },
    {
      id: ID("undated"),
      listId: LIST,
      name: "No date_updated at all",
      status: "Open",
      statusType: "open",
      dateUpdated: null,
    },
  ]);

  await db.insert(tasks).values([
    {
      id: ID("notmine"),
      listId: LIST,
      name: "Somebody else's task, and you were pulled into it",
      status: "Open",
      statusType: "open",
      // Untouched inside the window on purpose: a mention has to drag its task
      // in by itself, or the one case the feature exists for does not work.
      dateUpdated: ago(20_160),
    },
    {
      id: ID("quiet"),
      listId: LIST,
      name: "Yours, stale, and the only voice on it is your own",
      status: "Open",
      statusType: "open",
      dateUpdated: ago(20_160),
    },
  ]);

  await db.insert(comments).values([
    {
      id: ID("c-mention"),
      taskId: ID("notmine"),
      userId: BEN,
      text: `@anna can you look at this`,
      markdown: `@[anna](clickup://user/${ANNA}) can you look at this`,
      date: ago(3),
    },
    {
      id: ID("c-assigned"),
      taskId: ID("ancient"),
      userId: BEN,
      text: "handing this one to you",
      assigneeId: ANNA,
      date: ago(4),
    },
    // On a task of Anna's, so notable by the blunt signal alone.
    {
      id: ID("c-plain"),
      taskId: ID("fresh"),
      userId: BEN,
      text: "ok",
      date: ago(2),
    },
    // Older than the "ok" above and on the same task: the ranking has to put
    // this one on the row anyway.
    {
      id: ID("c-mention-fresh"),
      taskId: ID("fresh"),
      userId: BEN,
      text: "@anna the numbers do not add up",
      markdown: `@[anna](clickup://user/${ANNA}) the numbers do not add up`,
      date: ago(30),
    },
    // Anna's own, and the newest thing on the task.
    {
      id: ID("c-mine"),
      taskId: ID("fresh"),
      userId: ANNA,
      text: "on it",
      date: ago(1),
    },
    /*
     * Anna's own, and the only comment on its task.
     *
     * `inb-fresh` above cannot test this on its own: it carries a mention that
     * outranks anything Anna said, so the row would look right whether or not
     * her own words were being filtered. This task has nothing else to hide
     * behind.
     */
    {
      id: ID("c-solo"),
      taskId: ID("quiet"),
      userId: ANNA,
      text: "note to self",
      date: ago(2),
    },
    // A plain comment on somebody else's task is not addressed to anyone.
    {
      id: ID("c-noise"),
      taskId: ID("notmine"),
      userId: BEN,
      text: "unrelated chatter",
      date: ago(2),
    },
  ]);

  await db.insert(commentMentions).values([
    { commentId: ID("c-mention"), userId: ANNA },
    { commentId: ID("c-mention-fresh"), userId: ANNA },
  ]);

  await db.insert(taskAssignees).values([
    { taskId: ID("quiet"), userId: ANNA },
    { taskId: ID("fresh"), userId: ANNA },
    { taskId: ID("older"), userId: ANNA },
    { taskId: ID("closed"), userId: ANNA },
    { taskId: ID("ancient"), userId: ANNA },
    { taskId: ID("undated"), userId: ANNA },
    { taskId: ID("bens"), userId: BEN },
  ]);
});

afterAll(cleanup);

async function cleanup() {
  // Comments cascade from tasks and mentions cascade from comments, so the one
  // delete is enough — but say it out loud, because a fixture that half-cleans
  // reads as a passing test the next time somebody adds a row.
  await db.delete(tasks).where(like(tasks.id, "inb-%"));
  await db.delete(sessions).where(eq(sessions.id, hashSession(COOKIE)));
  await db.delete(oauthTokens).where(inArray(oauthTokens.userId, [ANNA, BEN]));
  await db.delete(users).where(inArray(users.id, [ANNA, BEN]));
}

/** The inbox read, as the route issues it. */
function inbox(sinceMinutesAgo: number, limit?: number) {
  return listTasks(db, {
    assigneeId: ANNA,
    includeClosed: true,
    updatedSince: ago(sinceMinutesAgo),
    limit,
  });
}

describe("the inbox window", () => {
  test("keeps only your tasks, changed inside the window", async () => {
    const rows = await inbox(120);

    expect(rows.map((row) => row.id)).toEqual([ID("fresh"), ID("closed"), ID("older")]);
  });

  test("orders newest change first, so a truncated page drops the oldest", async () => {
    // The whole reason the inbox overrides the shared ordering: `older` is
    // overdue, so due-date-first would lead the page with it and a limit of two
    // would cut away the two changes that actually just happened.
    const page = await inbox(120, 2);

    // listTasks returns one row more than asked for; the route drops it and
    // reports "there is more" from its presence.
    expect(page.map((row) => row.id)).toEqual([ID("fresh"), ID("closed"), ID("older")]);
    expect(page.slice(0, 2).map((row) => row.id)).toEqual([ID("fresh"), ID("closed")]);
  });

  test("keeps a task somebody closed", async () => {
    // The change you most want to be told about, and the one an open-tasks-only
    // read silently drops.
    const rows = await inbox(120);

    expect(rows.map((row) => row.id)).toContain(ID("closed"));
  });

  test("cuts on ClickUp's clock, not on ours", async () => {
    // `older` was synced a minute ago and changed an hour ago; `fresh` the other
    // way round. A cutoff reading synced_at returns exactly the wrong one.
    const rows = await inbox(30);

    expect(rows.map((row) => row.id)).toEqual([ID("fresh"), ID("closed")]);
  });

  test("drops a task with no date_updated rather than treating it as new", async () => {
    // `null > cutoff` is null in SQL, not false, which is the shape of bug that
    // makes a row appear in a feed it has no timestamp to belong to.
    const rows = await inbox(1_000_000);

    expect(rows.map((row) => row.id)).not.toContain(ID("undated"));
  });

  test("without a cutoff, nothing about the ordering changes", async () => {
    // The inbox is an override, not a new default: every other view still leads
    // with what is due.
    const rows = await listTasks(db, { assigneeId: ANNA, includeClosed: true });

    expect(rows.map((row) => row.id)).toContain(ID("ancient"));
  });
});

describe("notable comments", () => {
  const reasons = (minutes: number) => notableComments(db, ANNA, ago(minutes));

  test("finds a mention on a task that is not yours and never moved", async () => {
    /*
     * The case the whole comment path exists for. `inb-notmine` has no Anna
     * assignee and its own `date_updated` is a fortnight old, so every query in
     * the file above misses it. Only the comment puts it on screen.
     */
    const found = await reasons(120);
    const mention = found.find((r) => r.taskId === ID("notmine"));

    expect(mention?.kind).toBe("mention");
    expect(mention?.commentId).toBe(ID("c-mention"));
    expect(mention?.authorName).toBe("ben");
  });

  test("ranks a mention above a newer plain comment on the same task", async () => {
    // "ok" is newer. It is also not addressed to anybody, and showing it would
    // bury the only line in the thread written at you.
    const found = await reasons(120);
    const fresh = found.find((r) => r.taskId === ID("fresh"));

    expect(fresh?.kind).toBe("mention");
    expect(fresh?.commentId).toBe(ID("c-mention-fresh"));
    expect(fresh?.excerpt).toBe("@anna the numbers do not add up");
  });

  test("flattens a mention out of the excerpt", async () => {
    // The stored markdown spells it `@[anna](clickup://user/...)`, which is not
    // something to put in front of a reader.
    const found = await reasons(120);

    expect(found.find((r) => r.taskId === ID("notmine"))?.excerpt).toBe(
      "@anna can you look at this",
    );
  });

  test("finds a comment assigned to you", async () => {
    const found = await reasons(120);
    const assigned = found.find((r) => r.taskId === ID("ancient"));

    expect(assigned?.kind).toBe("assigned");
    expect(assigned?.commentId).toBe(ID("c-assigned"));
  });

  test("ignores what you said yourself", async () => {
    /*
     * `inb-quiet` is assigned to Anna and the only thing said on it is hers, so
     * the task appears here or it does not at all — no stronger reason can
     * stand in front of the filter and make it look like it worked.
     *
     * Being notified about your own words is how a feed teaches somebody to
     * stop reading it.
     */
    const found = await reasons(120);

    expect(found.map((r) => r.taskId)).not.toContain(ID("quiet"));
    expect(found.map((r) => r.commentId)).not.toContain(ID("c-mine"));
  });

  test("ignores chatter on somebody else's task", async () => {
    // Same task as the mention, same author, nothing addressed to anyone. The
    // blunt "any comment" signal is scoped to tasks that are yours.
    const found = await reasons(120);

    expect(found.map((r) => r.commentId)).not.toContain(ID("c-noise"));
  });

  test("reports the newest thing said alongside the strongest", async () => {
    /*
     * `inb-fresh` shows Tuesday's mention and had an "ok" on it since. The row
     * is about the mention; whether the task is unread is about the "ok".
     *
     * Read unread off the ranked comment and a task whose conversation is still
     * moving goes quiet the moment an old mention outranks the new line — which
     * is a badge that counts one fewer than the window it is counting.
     */
    const fresh = (await reasons(120)).find((r) => r.taskId === ID("fresh"));

    expect(fresh?.commentId).toBe(ID("c-mention-fresh"));
    expect(fresh?.at?.getTime()).toBe(ago(30).getTime());
    // `inb-c-mine` is newer still, but Anna wrote it and it is not notable.
    expect(fresh?.latestAt?.getTime()).toBe(ago(2).getTime());
  });

  test("says nothing about a window that closed after the conversation", async () => {
    expect(await reasons(1)).toEqual([]);
  });
});

describe("over HTTP", () => {
  test("marks the inbox read at the server's clock", async () => {
    const before = new Date();

    const response = await app.request("/api/inbox/seen", {
      method: "POST",
      headers: { cookie: COOKIE_HEADER },
    });
    expect(response.status).toBe(200);

    const { inboxSeenAt } = (await response.json()) as { inboxSeenAt: string };
    const [anna] = await db.select().from(users).where(eq(users.id, ANNA)).limit(1);

    // What it reports and what it stored are the same instant. A route that
    // answered with `new Date()` of its own would drift from the column by
    // however long the write took, and the browser holds the answer.
    expect(anna?.inboxSeenAt.toISOString()).toBe(new Date(inboxSeenAt).toISOString());
    expect(Date.parse(inboxSeenAt)).toBeGreaterThanOrEqual(before.getTime());
  });

  test("rejects an out-of-range since instead of failing on it", async () => {
    /*
     * `new Date(9e15)` is an Invalid Date, and an invalid Date reaching the
     * driver is a 500 on a query parameter — the one error a validated
     * boundary is supposed to make impossible. It is bounded rather than
     * clamped: a caller asking for something meaningless should hear so.
     */
    const response = await app.request("/api/inbox?since=9000000000000000", {
      headers: { cookie: COOKIE_HEADER },
    });

    expect(response.status).toBe(400);
  });

  test("answers the window through the route, newest first", async () => {
    // Two rows of a window that holds three, so the truncation flag is a real
    // answer rather than a constant.
    const response = await app.request(`/api/inbox?since=${ago(120).getTime()}&limit=2`, {
      headers: { cookie: COOKIE_HEADER },
    });

    expect(response.status).toBe(200);

    const page = (await response.json()) as {
      tasks: Array<{ id: string }>;
      reasons: Array<{ taskId: string; kind: string }>;
      truncated: boolean;
    };

    expect(page.truncated).toBe(true);
    // The window half, in the order the feed reads.
    expect(page.tasks.slice(0, 2).map((row) => row.id)).toEqual([ID("fresh"), ID("closed")]);
  });

  test("carries the task a comment pulled in, whose own clock never moved", async () => {
    /*
     * `inb-notmine` is a fortnight stale and belongs to nobody in particular,
     * so the window query cannot reach it and the browser has no way to render
     * a reason for a task it was never sent. This is the second read the route
     * does, and it is the whole reason the feed is one round trip.
     */
    const response = await app.request(`/api/inbox?since=${ago(120).getTime()}`, {
      headers: { cookie: COOKIE_HEADER },
    });

    const page = (await response.json()) as {
      tasks: Array<{ id: string }>;
      reasons: Array<{ taskId: string; kind: string }>;
    };

    expect(page.reasons.find((r) => r.taskId === ID("notmine"))?.kind).toBe("mention");
    expect(page.tasks.map((row) => row.id)).toContain(ID("notmine"));
  });
});

describe("dismissing one entry", () => {
  /*
   * Each test sets up the rows it needs and clears them after.
   *
   * The obvious version leans on the test above it — dismiss in one, assert the
   * sweep in the next — and passes right up until somebody inserts a test
   * between them. `inbox_reads` is per user and this file has one, so leaving
   * state behind is leaving it for everything below.
   */
  const dismiss = (taskId: string) =>
    app.request("/api/inbox/read", {
      method: "POST",
      headers: { cookie: COOKIE_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });

  const dismissed = () => db.select().from(inboxReads).where(eq(inboxReads.userId, ANNA));

  /*
   * The watermark as this block found it, put back afterwards.
   *
   * One test in here moves it, and the block below reads the default the column
   * gave it — an afterEach that set some plausible instant instead of restoring
   * would leave that assertion testing this file's cleanup rather than the
   * schema.
   */
  let watermark: Date;

  beforeAll(async () => {
    const [anna] = await db.select().from(users).where(eq(users.id, ANNA)).limit(1);
    if (!anna) throw new Error("fixture missing");
    watermark = anna.inboxSeenAt;
  });

  afterEach(async () => {
    await db.delete(inboxReads).where(eq(inboxReads.userId, ANNA));
    await db.update(users).set({ inboxSeenAt: watermark }).where(eq(users.id, ANNA));
  });

  test("records the instant, and moves it forward on a second dismissal", async () => {
    const first = (await (await dismiss(ID("fresh"))).json()) as { readAt: string };
    const again = (await (await dismiss(ID("fresh"))).json()) as { readAt: string };

    // Forward, never restated. A conflict that kept the first instant would
    // leave a row unread forever once a new comment landed on it.
    expect(Date.parse(again.readAt)).toBeGreaterThanOrEqual(Date.parse(first.readAt));

    const rows = await dismissed();
    expect(rows.map((row) => row.taskId)).toEqual([ID("fresh")]);
  });

  test("rides along on the window rather than being applied to it", async () => {
    /*
     * The row stays in the payload with its dismissal beside it. Filtering it
     * out here would make "mark as read" indistinguishable from "delete" — the
     * second scope in the browser exists precisely to show what you cleared.
     */
    await dismiss(ID("fresh"));

    const page = (await (
      await app.request(`/api/inbox?since=${ago(120).getTime()}`, {
        headers: { cookie: COOKIE_HEADER },
      })
    ).json()) as { tasks: Array<{ id: string }>; reads: Array<{ taskId: string }> };

    expect(page.reads.map((r) => r.taskId)).toContain(ID("fresh"));
    expect(page.tasks.map((t) => t.id)).toContain(ID("fresh"));
  });

  test("refuses a request with no task", async () => {
    const response = await app.request("/api/inbox/read", {
      method: "POST",
      headers: { cookie: COOKIE_HEADER, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  test("marking the whole inbox read sweeps the dismissals it made redundant", async () => {
    /*
     * The watermark passes every one of them by definition, so keeping the rows
     * is a table that only grows. In one transaction with the watermark move,
     * or a failed write drops dismissals it had no business touching.
     */
    await dismiss(ID("fresh"));
    expect(await dismissed()).not.toEqual([]);

    await app.request("/api/inbox/seen", { method: "POST", headers: { cookie: COOKIE_HEADER } });

    expect(await dismissed()).toEqual([]);
  });
});

describe("the read mark", () => {
  test("defaults to the moment the user row appeared", async () => {
    // Not the epoch. A column defaulting to null or to 1970 would greet
    // everybody with every task they have ever been assigned.
    const [anna] = await db.select().from(users).where(eq(users.id, ANNA)).limit(1);

    expect(anna?.inboxSeenAt).toBeInstanceOf(Date);
    expect(anna?.inboxSeenAt.getTime()).toBeGreaterThan(now - 60 * MINUTE);
  });

  test("moves forward when the inbox is read", async () => {
    const seenAt = new Date();
    await db.update(users).set({ inboxSeenAt: seenAt }).where(eq(users.id, ANNA));

    const [anna] = await db.select().from(users).where(eq(users.id, ANNA)).limit(1);
    expect(anna?.inboxSeenAt.getTime()).toBe(seenAt.getTime());

    // And the window it produces is empty of everything older than it.
    const rows = await listTasks(db, {
      assigneeId: ANNA,
      includeClosed: true,
      updatedSince: seenAt,
    });
    expect(rows).toEqual([]);
  });
});
