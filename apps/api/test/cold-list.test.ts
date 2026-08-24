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
} from "@rask/schema";
import { eq, like } from "drizzle-orm";
import type { Hono } from "hono";
import { hashSession } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";

/**
 * The first open of a list nobody has opened before.
 *
 * Reads are answered from the mirror, and the mirror has nothing for a list it
 * has never synced, so this route used to return an empty page and the browser
 * drew "Nothing here" over a list that was merely unread. The worker's cold
 * pass fixed it three seconds later, which is why the bug looked like "the tabs
 * work and the list does not".
 *
 * Both halves are pinned here because each fails differently. Without the
 * fetch — or with it moved back after the mirror read, which is the original
 * bug exactly — the first request answers empty. Without the claim holding, the
 * fetch repeats on every list anyone opens and the symptom is a rate limit
 * somewhere else entirely.
 */

const KEY = Buffer.alloc(32, 7).toString("base64");
const USER = "cold-list-test-user";
const COOKIE = "cold-list-test-cookie";
const LIST = "cold-list-test-list";
const VIEW = "cold-list-test-view";
const PREFIX = "cold-list-test-task-";

let app: Hono;
/** Every ClickUp URL the API reached for, in order. */
let reached: string[] = [];
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
 * ClickUp with two tasks in the list, one of which the view's filters keep.
 *
 * The asymmetry is the point: a view is a subset, so a mirror filled from the
 * view alone is a list missing rows nobody will ever ask ClickUp for again.
 */
function clickUp(): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    reached.push(url);
    return url.includes(`/view/${VIEW}/task`)
      ? page([`${PREFIX}1`])
      : page([`${PREFIX}1`, `${PREFIX}2`]);
  }) as typeof globalThis.fetch;
}

async function get(path: string): Promise<Response> {
  return await app.request(path, { headers: { cookie: `rask_session=${COOKIE}` } });
}

async function wipe() {
  await db.delete(tasks).where(like(tasks.id, `${PREFIX}%`));
  await db.delete(syncCursors).where(eq(syncCursors.scopeId, LIST));
  await db.delete(listViews).where(eq(listViews.listId, LIST));
  await db.delete(sessions).where(eq(sessions.userId, USER));
  await db.delete(users).where(eq(users.id, USER));
}

/** Back to a list nobody has opened, without tearing down the session. */
async function forget() {
  await db.delete(tasks).where(like(tasks.id, `${PREFIX}%`));
  await db.delete(syncCursors).where(eq(syncCursors.scopeId, LIST));
  reached = [];
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

  await wipe();
  await db.insert(users).values({ id: USER, username: "Cold", email: "cold@example.test" });
  await saveToken(db, {
    userId: USER,
    teamId: "9001",
    token: "oauth-token",
    key: loadConfig(process.env).encryptionKey,
  });
  await db
    .insert(sessions)
    .values({ id: hashSession(COOKIE), userId: USER, expiresAt: new Date(Date.now() + 3_600_000) });

  /*
   * The stub goes in before the import, because `clientFor` builds one
   * `ClickUpClient` per user and it captures `globalThis.fetch` at construction.
   * Dynamic for the same reason as the environment above: index.ts reads its
   * config and opens its pool at module scope.
   */
  globalThis.fetch = clickUp();
  app = (await import("../src/index.ts")).app as unknown as Hono;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await wipe();
});

test("the first ask for a list fills it from ClickUp before answering", async () => {
  const response = await get(`/api/tasks?list=${LIST}`);
  expect(response.status).toBe(200);

  const rows = (await response.json()) as Array<{ id: string }>;
  expect(rows.map((row) => row.id).sort()).toEqual([`${PREFIX}1`, `${PREFIX}2`]);

  // One page of that list, and the request waited for it.
  expect(reached).toHaveLength(1);
  expect(reached[0]).toContain(`/list/${LIST}/task`);
});

test("and registers it, so the worker takes the rest of the list", async () => {
  // The bare row `coldLists` looks for: written, and left unread.
  const [cursor] = await db
    .select()
    .from(syncCursors)
    .where(eq(syncCursors.scopeId, LIST))
    .limit(1);

  expect(cursor?.scope).toBe("list");
  expect(cursor?.lastRunAt).toBeNull();
});

test("every ask after that is answered from the mirror alone", async () => {
  reached = [];

  const response = await get(`/api/tasks?list=${LIST}`);
  const rows = (await response.json()) as Array<{ id: string }>;

  expect(rows).toHaveLength(2);
  expect(reached).toEqual([]);
});

/**
 * A ClickUp URL is a view's URL, so this is the common way in: the pasted link
 * opens a tab, and the sidebar entry for the list under it is the second thing
 * clicked. The tab route registers the list too — and if it registered without
 * filling, the list would be marked accounted for while the mirror held only
 * the rows that view's filters kept.
 */
test("arriving through a view fills the whole list, not the view's subset", async () => {
  await forget();
  await db.insert(listViews).values({
    id: VIEW,
    listId: LIST,
    name: "All",
    type: "list",
    orderindex: 0,
    isDefault: true,
    showClosed: false,
  });

  expect((await get(`/api/views/${VIEW}/tasks`)).status).toBe(200);
  expect(reached.some((url) => url.includes(`/view/${VIEW}/task`))).toBe(true);
  expect(reached.some((url) => url.includes(`/list/${LIST}/task`))).toBe(true);

  reached = [];
  const response = await get(`/api/tasks?list=${LIST}`);
  const rows = (await response.json()) as Array<{ id: string }>;

  // Both tasks and not just the one the view kept, and no second round trip:
  // the view route already paid for the list's first page.
  expect(rows.map((row) => row.id).sort()).toEqual([`${PREFIX}1`, `${PREFIX}2`]);
  expect(reached).toEqual([]);
});
