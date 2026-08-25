import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTestDb,
  oauthTokens,
  saveToken,
  sessions,
  TEST_DATABASE_URL,
  taskAssignees,
  tasks,
  users,
} from "@rask/schema";
import { eq, like } from "drizzle-orm";
import type * as honoModule from "hono";
import { hashSession } from "../src/auth.ts";
import { listTasks } from "../src/queries.ts";

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
const ANNA = ID("u-anna");
const BEN = ID("u-ben");
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

  await db.insert(taskAssignees).values([
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
  await db.delete(tasks).where(like(tasks.id, "inb-%"));
  await db.delete(sessions).where(eq(sessions.id, hashSession(COOKIE)));
  await db.delete(oauthTokens).where(like(oauthTokens.userId, "inb-%"));
  await db.delete(users).where(like(users.id, "inb-%"));
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

  test("rejects an out-of-range updatedSince instead of failing on it", async () => {
    /*
     * `new Date(9e15)` is an Invalid Date, and an invalid Date reaching the
     * driver is a 500 on a query parameter — the one error a validated
     * boundary is supposed to make impossible. It is bounded rather than
     * clamped: a caller asking for something meaningless should hear so.
     */
    const response = await app.request("/api/tasks?assignee=me&updatedSince=9000000000000000", {
      headers: { cookie: COOKIE_HEADER },
    });

    expect(response.status).toBe(400);
  });

  test("answers the window through the route, newest first", async () => {
    // The parameter is wired end to end: parsed, coerced to a Date, and handed
    // to the same query the tests above drive directly.
    const since = ago(120).getTime();
    const response = await app.request(
      `/api/tasks?assignee=me&closed=1&updatedSince=${since}&limit=2`,
      { headers: { cookie: COOKIE_HEADER } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Rask-Truncated")).toBe("1");

    const rows = (await response.json()) as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual([ID("fresh"), ID("closed")]);
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
