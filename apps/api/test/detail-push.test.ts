import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  comments,
  createTestDb,
  oauthTokens,
  outbox,
  saveToken,
  sessions,
  TEST_DATABASE_URL,
  tasks,
  users,
} from "@rask/schema";
import { eq } from "drizzle-orm";
import type * as honoModule from "hono";
import { hashSession } from "../src/auth.ts";

/*
 * A comment moves `comments.synced_at` and never `tasks.synced_at`, so the
 * workspace change feed — which watches the task table — never mentions it. The
 * tab that posted is told in the response; every other tab of the same person
 * has to be told over their own channel, or it sits on the conversation from
 * before the write until something else happens to refresh it.
 *
 * So this opens a second stream and asserts the write arrives on it. Reading
 * the response of the write itself would pass against no push at all.
 */

const KEY = Buffer.alloc(32, 7);
const KEY_BASE64 = KEY.toString("base64");
const USER = "detail-push-user";
const TASK = "detail-push-task";
const COOKIE = "detail-push-cookie";
const COOKIE_HEADER = `rask_session=${COOKIE}`;

const db = createTestDb();
let app: honoModule.Hono;

beforeAll(async () => {
  // Never the developer's own database: importing index.ts builds a pool from
  // the environment, and `.env` names the mirror of a real workspace.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.TOKEN_ENCRYPTION_KEY = KEY_BASE64;
  process.env.SESSION_SECRET = "session-secret";
  process.env.CLICKUP_CLIENT_ID = "test-client-id";
  process.env.CLICKUP_CLIENT_SECRET = "test-client-secret";
  process.env.CLICKUP_REDIRECT_URI = "http://localhost:3000/auth/clickup/callback";
  process.env.SESSION_COOKIE_NAME = "rask_session";
  delete process.env.WEB_DIST;

  app = (await import("../src/index.ts")).app as unknown as honoModule.Hono;

  await db.insert(users).values({ id: USER }).onConflictDoNothing();
  await saveToken(db, { userId: USER, teamId: "9001", token: "oauth-token", key: KEY });
  await db.insert(sessions).values({
    id: hashSession(COOKIE),
    userId: USER,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await db.insert(tasks).values({ id: TASK, listId: "detail-push-list", name: "task" });
});

afterAll(async () => {
  await db.delete(comments).where(eq(comments.taskId, TASK));
  await db.delete(outbox).where(eq(outbox.userId, USER));
  await db.delete(tasks).where(eq(tasks.id, TASK));
  await db.delete(sessions).where(eq(sessions.userId, USER));
  await db.delete(oauthTokens).where(eq(oauthTokens.userId, USER));
  await db.delete(users).where(eq(users.id, USER));
});

/*
 * Only what an SSE reader has to be. Bun's `ReadableStreamDefaultReader` and the
 * DOM's disagree about `readMany`, and this file needs neither.
 */
type Frames = { read(): Promise<{ done: boolean; value?: Uint8Array }> };

/** The next frame of the named SSE event, or a failure rather than a hang. */
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

test("a posted comment reaches the author's other tabs", async () => {
  const stream = await app.request("/api/events", { headers: { cookie: COOKIE_HEADER } });
  const reader = stream.body?.getReader();
  if (!reader) throw new Error("no event stream");

  // The push is registered before `ready` goes out, so this is also the point
  // at which there is a stream to push to.
  await nextEvent(reader, "ready");

  const posted = await app.request(`/api/tasks/${TASK}/comments`, {
    method: "POST",
    headers: { cookie: COOKIE_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ text: "over here too", clientId: "detail-push-client" }),
  });
  expect(posted.status).toBe(201);

  const pushed = (await nextEvent(reader, "task")) as { id: string; comments: { text: string }[] };
  expect(pushed.id).toBe(TASK);
  expect(pushed.comments.map((comment) => comment.text)).toContain("over here too");

  await reader.cancel();
});
