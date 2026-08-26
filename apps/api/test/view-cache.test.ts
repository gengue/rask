import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createTestDb,
  listViews,
  saveToken,
  sessions,
  syncCursors,
  TEST_DATABASE_URL,
  tasks,
  users,
  viewMemberships,
} from "@rask/schema";
import { eq, inArray, like } from "drizzle-orm";
import type { Hono } from "hono";
import { hashSession } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";

/**
 * A view's membership, remembered between opens.
 *
 * The first open walks ClickUp — a view's filters are ClickUp's to evaluate —
 * and every open after that answers from what the walk wrote down, with the
 * repair running behind the response. Everything here can be silently wrong:
 * a hit that quietly re-walks is the seconds-long open this exists to remove,
 * a failed repair that empties the view is worse than the 502 it replaced,
 * and one person's membership painted as another's is ClickUp's "assignee is
 * Me" answered for the wrong person.
 */

const KEY = Buffer.alloc(32, 7).toString("base64");
const USER_A = "view-cache-test-user-a";
const USER_B = "view-cache-test-user-b";
const COOKIE_A = "view-cache-test-cookie-a";
const COOKIE_B = "view-cache-test-cookie-b";
const LIST = "view-cache-test-list";
const VIEW = "view-cache-test-view";
const PREFIX = "view-cache-test-task-";

let app: Hono;
/** Every ClickUp URL the API reached for, in order. */
let reached: string[] = [];
/** What a walk of the view answers. */
let viewTaskIds: string[] = [];
/** What the cold list fill answers. */
let listTaskIds: string[] = [];
/** Refuse everything, the way an unreachable ClickUp does. */
let clickUpDown = false;
/** Holds each view page open, so concurrent revalidations overlap. */
let walkDelayMs = 0;
/** Serve the same rows on two pages, the way a view reordering mid-walk does. */
let duplicatePages = false;
/** Put back in `afterAll`: `bun test` runs every file in one process. */
const realFetch = globalThis.fetch;

function page(ids: string[]): Response {
  return new Response(
    JSON.stringify({
      tasks: ids.map((id) => ({
        id,
        name: `task ${id}`,
        date_updated: "1700000000000",
        list: { id: LIST, name: "Requests" },
      })),
      last_page: true,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * The walk fetches four pages a round, so only page 0 carries rows — a stub
 * that answered every page identically would hand the route each task four
 * times, and the membership would remember the duplicates.
 */
function clickUp(): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    reached.push(url);
    if (clickUpDown) throw new Error("connect ECONNREFUSED");
    if (url.includes(`/view/${VIEW}/task`)) {
      if (walkDelayMs > 0) await Bun.sleep(walkDelayMs);
      const pageNumber = new URL(url).searchParams.get("page");
      if (pageNumber === "0") return page(viewTaskIds);
      if (pageNumber === "1" && duplicatePages) return page(viewTaskIds);
      return page([]);
    }
    return page(listTaskIds);
  }) as typeof globalThis.fetch;
}

async function get(path: string, cookie = COOKIE_A): Promise<Response> {
  return await app.request(path, { headers: { cookie: `rask_session=${cookie}` } });
}

async function rowIds(response: Response): Promise<string[]> {
  return ((await response.json()) as Array<{ id: string }>).map((row) => row.id).sort();
}

async function membershipOf(userId: string) {
  const [row] = await db
    .select()
    .from(viewMemberships)
    .where(eq(viewMemberships.userId, userId))
    .limit(1);
  return row ?? null;
}

/** How many times the view itself was walked. A walk is one round of pages. */
const VIEW_PAGE_BATCH = 4;
function viewWalks(): number {
  return reached.filter((url) => url.includes(`/view/${VIEW}/task`)).length / VIEW_PAGE_BATCH;
}

/** The next frame of the named SSE event, or a failure rather than a hang. */
type Frames = { read(): Promise<{ done: boolean; value?: Uint8Array }> };
async function nextEvent(reader: Frames, event: string): Promise<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream ended before a ${event} event`);
    buffer += decoder.decode(value, { stream: true });

    for (const frame of buffer.split("\n\n")) {
      const lines = frame.split("\n");
      if (!lines.some((line) => line === `event: ${event}`)) continue;
      const data = lines.find((line) => line.startsWith("data: "));
      if (data) return JSON.parse(data.slice("data: ".length));
    }
  }
  throw new Error(`no ${event} event within 5s`);
}

/** Waits out a background revalidation by watching for its write. */
async function revalidated(userId: string, after: Date): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await membershipOf(userId);
    if (row && row.syncedAt.getTime() > after.getTime()) return;
    await Bun.sleep(20);
  }
  throw new Error("revalidation never landed");
}

async function wipe() {
  await db.delete(viewMemberships).where(eq(viewMemberships.viewId, VIEW));
  await db.delete(tasks).where(like(tasks.id, `${PREFIX}%`));
  await db.delete(syncCursors).where(eq(syncCursors.scopeId, LIST));
  await db.delete(listViews).where(eq(listViews.listId, LIST));
  await db.delete(sessions).where(inArray(sessions.userId, [USER_A, USER_B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
}

const db = createTestDb();

beforeAll(async () => {
  // Never the developer's own database: importing index.ts builds a pool from
  // the environment, and `.env` names the mirror of a real workspace.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  process.env.SESSION_SECRET = "session-secret";
  process.env.CLICKUP_CLIENT_ID = "test-client-id";
  process.env.CLICKUP_CLIENT_SECRET = "test-client-secret";
  process.env.CLICKUP_REDIRECT_URI = "http://localhost:3000/auth/clickup/callback";
  process.env.SESSION_COOKIE_NAME = "rask_session";
  delete process.env.WEB_DIST;

  await wipe();
  const key = loadConfig(process.env).encryptionKey;
  for (const [userId, cookie] of [
    [USER_A, COOKIE_A],
    [USER_B, COOKIE_B],
  ] as const) {
    await db.insert(users).values({ id: userId, username: userId });
    await saveToken(db, { userId, teamId: "9001", token: `oauth-${userId}`, key });
    await db.insert(sessions).values({
      id: hashSession(cookie),
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  }
  await db.insert(listViews).values({
    id: VIEW,
    listId: LIST,
    name: "Cached",
    type: "list",
    orderindex: 0,
    isDefault: false,
    showClosed: false,
  });

  // The stub goes in before the import: `clientFor` builds one `ClickUpClient`
  // per user and it captures `globalThis.fetch` at construction.
  globalThis.fetch = clickUp();
  app = (await import("../src/index.ts")).app as unknown as Hono;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await wipe();
});

test("the first open walks ClickUp, answers, and writes the membership down", async () => {
  viewTaskIds = [`${PREFIX}1`, `${PREFIX}2`];
  listTaskIds = [`${PREFIX}1`, `${PREFIX}2`, `${PREFIX}3`];

  const response = await get(`/api/views/${VIEW}/tasks`);
  expect(response.status).toBe(200);
  expect(await rowIds(response)).toEqual([`${PREFIX}1`, `${PREFIX}2`]);
  expect(response.headers.get("X-Rask-Truncated")).toBe("0");
  expect(viewWalks()).toBe(1);

  const remembered = await membershipOf(USER_A);
  expect(remembered?.taskIds).toEqual([`${PREFIX}1`, `${PREFIX}2`]);
});

test("every open after that answers even with ClickUp unreachable", async () => {
  reached = [];
  clickUpDown = true;

  const response = await get(`/api/views/${VIEW}/tasks`);
  expect(response.status).toBe(200);
  expect(await rowIds(response)).toEqual([`${PREFIX}1`, `${PREFIX}2`]);

  // The repair failed against a dead ClickUp; the remembered answer stands
  // rather than being emptied, which is the whole reason it is remembered.
  await Bun.sleep(50);
  expect((await membershipOf(USER_A))?.taskIds).toEqual([`${PREFIX}1`, `${PREFIX}2`]);
});

test("the answer is repaired behind the response and pushed over SSE", async () => {
  clickUpDown = false;
  viewTaskIds = [`${PREFIX}1`, `${PREFIX}2`, `${PREFIX}4`];

  const stream = await app.request("/api/events", {
    headers: { cookie: `rask_session=${COOKIE_A}` },
  });
  const reader = stream.body?.getReader();
  if (!reader) throw new Error("no event stream");
  await nextEvent(reader, "ready");

  // The response paints the old membership; the fresh one follows.
  const response = await get(`/api/views/${VIEW}/tasks`);
  expect(await rowIds(response)).toEqual([`${PREFIX}1`, `${PREFIX}2`]);

  const pushed = (await nextEvent(reader, "view")) as { viewId: string; ids: string[] };
  expect(pushed.viewId).toBe(VIEW);
  expect(pushed.ids.sort()).toEqual([`${PREFIX}1`, `${PREFIX}2`, `${PREFIX}4`]);

  // The task the walk surfaced is mirrored, so the pushed id has a row behind it.
  const [ingested] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, `${PREFIX}4`))
    .limit(1);
  expect(ingested?.name).toBe(`task ${PREFIX}4`);

  await reader.cancel();
});

test("concurrent opens share one repair walk", async () => {
  reached = [];
  walkDelayMs = 100;
  const before = (await membershipOf(USER_A))?.syncedAt;
  if (!before) throw new Error("no membership to revalidate");

  const responses = await Promise.all([
    get(`/api/views/${VIEW}/tasks`),
    get(`/api/views/${VIEW}/tasks`),
    get(`/api/views/${VIEW}/tasks`),
  ]);
  for (const response of responses) expect(response.status).toBe(200);

  await revalidated(USER_A, before);
  walkDelayMs = 0;
  expect(viewWalks()).toBe(1);
});

test("a membership past the age gate walks again before answering", async () => {
  await db
    .update(viewMemberships)
    .set({ syncedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where(eq(viewMemberships.userId, USER_A));
  viewTaskIds = [`${PREFIX}2`];
  reached = [];

  const response = await get(`/api/views/${VIEW}/tasks`);
  // The fresh set, not the remembered one: the request waited for the walk.
  expect(await rowIds(response)).toEqual([`${PREFIX}2`]);
  expect(viewWalks()).toBe(1);
});

test("one person's membership is not another's first paint", async () => {
  viewTaskIds = [`${PREFIX}3`];
  reached = [];

  // B has no membership, so B walks — a hit here would paint A's rows.
  const response = await get(`/api/views/${VIEW}/tasks`, COOKIE_B);
  expect(await rowIds(response)).toEqual([`${PREFIX}3`]);
  expect(viewWalks()).toBe(1);

  expect((await membershipOf(USER_B))?.taskIds).toEqual([`${PREFIX}3`]);
  expect((await membershipOf(USER_A))?.taskIds).toEqual([`${PREFIX}2`]);
});

test("a task on two pages at once is remembered once", async () => {
  // A live view can reorder mid-walk and hand the same task back on two
  // pages. Doubled, the ids poison `ingestTasks`'s multi-row upsert — the
  // whole insert refuses, and the walk's tasks silently never reach the
  // mirror.
  await db.delete(viewMemberships).where(eq(viewMemberships.userId, USER_A));
  await db.delete(tasks).where(eq(tasks.id, `${PREFIX}5`));
  duplicatePages = true;
  viewTaskIds = [`${PREFIX}5`];

  const response = await get(`/api/views/${VIEW}/tasks`);
  expect(await rowIds(response)).toEqual([`${PREFIX}5`]);
  expect((await membershipOf(USER_A))?.taskIds).toEqual([`${PREFIX}5`]);
  duplicatePages = false;
});

test("truncation is replayed from the remembered walk", async () => {
  await db
    .update(viewMemberships)
    .set({ truncated: true })
    .where(eq(viewMemberships.userId, USER_A));
  // Down, so the repair cannot overwrite the flag mid-assertion.
  clickUpDown = true;

  const response = await get(`/api/views/${VIEW}/tasks`);
  expect(response.headers.get("X-Rask-Truncated")).toBe("1");
  clickUpDown = false;
});
