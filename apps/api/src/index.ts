import { ClickUpClient, RateLimiter } from "@rask/clickup-client";
import {
  comments,
  createDb,
  ingestComments,
  ingestReplies,
  ingestTasks,
  loadToken,
  syncCursors,
} from "@rask/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { authRoutes, currentUser, SESSION_COOKIE, type SessionUser } from "./auth.ts";
import { ChangeFeed } from "./changes.ts";
import { loadConfig } from "./config.ts";
import { getHierarchy, getTaskDetail, listMembers, listTasks, statusesForList } from "./queries.ts";
import {
  applyCommentPatch,
  applyTaskPatch,
  commentPatchInput,
  createComment,
  createTask,
  deleteComment,
  discardPendingComment,
  findComment,
  newCommentInput,
  newTaskInput,
  setCustomField,
  taskPatchInput,
} from "./writes.ts";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const feed = new ChangeFeed(db);

/** One ClickUp client per user, kept warm so each keeps its own rate bucket. */
const clients = new Map<string, ClickUpClient>();
async function clientFor(userId: string): Promise<ClickUpClient | null> {
  const cached = clients.get(userId);
  if (cached) return cached;
  const token = await loadToken(db, userId, config.encryptionKey);
  if (!token) return null;
  const client = new ClickUpClient({ token: token.token, limiter: new RateLimiter() });
  clients.set(userId, client);
  return client;
}

/**
 * Per-user push channel, on top of the workspace-wide change feed.
 *
 * The feed only knows about rows the mirror wrote. Things that concern one
 * person specifically (their task detail finished refreshing, one of their
 * writes was rejected) go here instead.
 */
type Push = (event: string, data: unknown) => void;
const userStreams = new Map<string, Set<Push>>();

function pushTo(userId: string, event: string, data: unknown): void {
  for (const send of userStreams.get(userId) ?? []) send(event, data);
}

type Env = { Variables: { user: SessionUser } };

const requireAuth = createMiddleware<Env>(async (c, next) => {
  const user = await currentUser(db, getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  c.set("user", user);
  await next();
});

const app = new Hono<Env>();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes(db, config));

const api = new Hono<Env>();
api.use("*", requireAuth);

api.get("/me", (c) => c.json(c.get("user")));

api.get("/hierarchy", async (c) => c.json(await getHierarchy(db)));

api.get("/members", async (c) => c.json(await listMembers(db)));

const taskFilters = z.object({
  list: z.string().optional(),
  space: z.string().optional(),
  assignee: z.string().optional(),
  status: z.string().optional(),
  tag: z.string().optional(),
  closed: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

api.get("/tasks", async (c) => {
  const query = taskFilters.safeParse(c.req.query());
  if (!query.success) return c.json({ error: z.prettifyError(query.error) }, 400);
  const f = query.data;

  const limit = f.limit ?? 500;
  const rows = await listTasks(db, {
    listId: f.list,
    spaceId: f.space,
    assigneeId: f.assignee === "me" ? c.get("user").id : f.assignee,
    statuses: f.status ? f.status.split(",") : undefined,
    tag: f.tag,
    includeClosed: f.closed === "1",
    limit,
  });

  // A list of 5,000 tasks silently arriving as 500 is the kind of thing that
  // makes a client stop trusting its own counts. Say so instead.
  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;
  c.header("X-Rask-Truncated", truncated ? "1" : "0");

  // Loading a list is what marks it worth polling. Nothing else registers
  // interest, so the worker never polls lists nobody looks at.
  if (f.list)
    await db.insert(syncCursors).values({ scope: "list", scopeId: f.list }).onConflictDoNothing();

  return c.json(rows);
});

api.get("/lists/:id/statuses", async (c) => c.json(await statusesForList(db, c.req.param("id"))));

api.get("/tasks/:id", async (c) => {
  const detail = await getTaskDetail(db, c.req.param("id"));
  if (!detail) return c.json({ error: "not found" }, 404);

  // Answer from the mirror right away, then refresh from ClickUp in the
  // background. The SSE feed delivers the fresher version a moment later, so
  // opening a task is instant and still ends up correct.
  void refreshTask(c.get("user").id, c.req.param("id"));

  return c.json(detail);
});

api.patch("/tasks/:id", async (c) => {
  const body = taskPatchInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  await applyTaskPatch(db, {
    taskId: c.req.param("id"),
    userId: c.get("user").id,
    patch: body.data,
  });

  return c.json(await getTaskDetail(db, c.req.param("id")));
});

api.post("/tasks", async (c) => {
  const body = newTaskInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const id = await createTask(db, { userId: c.get("user").id, task: body.data });
  return c.json(await getTaskDetail(db, id), 201);
});

/**
 * Comment writes answer with the whole refreshed detail.
 *
 * The task collection carries no comments, so there is no place for the client
 * to apply a patch of its own. Returning the detail the mirror now holds means
 * the browser replaces one object and is exactly in step with the server.
 */
api.post("/tasks/:id/comments", async (c) => {
  const body = newCommentInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const taskId = c.req.param("id");
  await createComment(db, { taskId, userId: c.get("user").id, comment: body.data });
  return c.json(await getTaskDetail(db, taskId), 201);
});

api.patch("/comments/:id", async (c) => {
  const body = commentPatchInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const comment = await findComment(db, c.req.param("id"));
  if (!comment) return c.json({ error: "not found" }, 404);

  // Anyone may resolve a thread — that is a shared state and ClickUp treats it
  // as one. Rewriting somebody else's words is a different thing.
  if (body.data.text !== undefined && comment.userId !== c.get("user").id) {
    return c.json({ error: "you can only edit your own comments" }, 403);
  }
  // Nothing to address upstream yet: ClickUp has not assigned an id, so a PUT
  // would 404 and take the local edit down with it on the revert.
  if (comment.id.startsWith("tmp_")) {
    return c.json({ error: "this comment has not reached ClickUp yet" }, 409);
  }

  await applyCommentPatch(db, { comment, userId: c.get("user").id, patch: body.data });
  return c.json(await getTaskDetail(db, comment.taskId));
});

api.delete("/comments/:id", async (c) => {
  const comment = await findComment(db, c.req.param("id"));
  if (!comment) return c.json({ error: "not found" }, 404);
  if (comment.userId !== c.get("user").id) {
    return c.json({ error: "you can only delete your own comments" }, 403);
  }

  const userId = c.get("user").id;
  if (comment.id.startsWith("tmp_")) await discardPendingComment(db, { comment, userId });
  else await deleteComment(db, { comment, userId });

  return c.json(await getTaskDetail(db, comment.taskId));
});

const customFieldInput = z.object({ value: z.unknown() });

api.put("/tasks/:id/fields/:fieldId", async (c) => {
  const body = customFieldInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  await setCustomField(db, {
    taskId: c.req.param("id"),
    fieldId: c.req.param("fieldId"),
    userId: c.get("user").id,
    value: body.data.value,
  });
  return c.json({ ok: true }, 202);
});

/** Forces a full re-read of one list. The escape hatch for a lost webhook. */
api.post("/lists/:id/resync", async (c) => {
  const listId = c.req.param("id");
  await db
    .insert(syncCursors)
    .values({ scope: "list", scopeId: listId })
    .onConflictDoUpdate({
      target: [syncCursors.scope, syncCursors.scopeId],
      // Clearing the cursor is the whole resync: the next poll has nothing to
      // resume from and re-reads the list end to end.
      set: { lastUpdatedAt: null, failures: 0, lastError: null },
    });
  return c.json({ ok: true }, 202);
});

api.get("/events", (c) => {
  const userId = c.get("user").id;

  return streamSSE(c, async (stream) => {
    let closed = false;
    const unsubscribe = feed.subscribe((tasks) => {
      void stream.writeSSE({ event: "tasks", data: JSON.stringify(tasks) });
    });

    const push: Push = (event, data) => {
      void stream.writeSSE({ event, data: JSON.stringify(data) });
    };

    // Only the author of a rejected write hears about it.
    const unsubscribeFailures = feed.onFailure((failure) => {
      if (failure.userId !== userId) return;
      push("write-failed", failure);

      // The worker has already repaired the mirror from ClickUp. Comments do
      // not move tasks.synced_at, so without this push the panel would keep
      // showing a comment that no longer exists.
      if (!failure.entityId) return;
      void getTaskDetail(db, failure.entityId)
        .then((detail) => {
          if (detail) push("task", detail);
        })
        .catch(() => {});
    });
    const mine = userStreams.get(userId) ?? new Set<Push>();
    mine.add(push);
    userStreams.set(userId, mine);

    stream.onAbort(() => {
      closed = true;
      unsubscribe();
      unsubscribeFailures();
      mine.delete(push);
      if (mine.size === 0) userStreams.delete(userId);
    });

    await stream.writeSSE({ event: "ready", data: "{}" });

    // Proxies and load balancers cut idle connections. A comment every 25s is
    // cheaper than teaching the client to reconnect gracefully.
    while (!closed) {
      await stream.sleep(25_000);
      if (closed) break;
      await stream.writeSSE({ event: "ping", data: "{}" });
    }
  });
});

app.route("/api", api);

if (config.WEB_DIST) {
  // Production: one process serves the SPA and the API from one origin, which
  // is what keeps the session cookie SameSite=Lax with no CORS layer to get
  // wrong. WEB_DIST is relative to the working directory, because that is what
  // Hono's static handler resolves against.
  const { serveStatic } = await import("hono/bun");
  app.use("*", serveStatic({ root: config.WEB_DIST }));

  // Deep links are client-side routes, so anything the static handler did not
  // match falls back to the shell. Read once at boot rather than per request.
  const shell = await Bun.file(`${config.WEB_DIST}/index.html`).text();
  app.get("*", (c) => c.html(shell));
}

/**
 * How many pages of comments one refresh will walk.
 *
 * ponytail: 25 comments a page, so four pages is a hundred. Past that the
 * conversation is an archive, not something anyone is reading in a side panel.
 * The number to raise the day a task detail grows a "load older comments"
 * control.
 */
const COMMENT_PAGES = 4;

/**
 * How many threads one refresh will pull.
 *
 * Only threads whose reply count moved are fetched, so in the steady state this
 * is zero. The cap is for the first open of a busy task, where every thread
 * looks new at once: it costs ten requests now and the rest on the next pass,
 * rather than a hundred while somebody waits.
 */
const THREADS_PER_REFRESH = 10;

async function refreshTask(userId: string, taskId: string): Promise<void> {
  try {
    if (taskId.startsWith("tmp_")) return;
    const client = await clientFor(userId);
    if (!client) return;

    const [task] = await Promise.all([client.getTask(taskId), refreshComments(client, taskId)]);
    await ingestTasks(db, [task]);

    // The change feed watches tasks.synced_at, which does not move when
    // ClickUp had nothing new. Push the refreshed detail directly so newly
    // fetched comments still land in the open tab.
    const detail = await getTaskDetail(db, taskId);
    if (detail) pushTo(userId, "task", detail);
  } catch (error) {
    console.error("[refresh]", taskId, error instanceof Error ? error.message : error);
  }
}

/**
 * Re-reads a task's conversation.
 *
 * Threads are only fetched when ClickUp's `reply_count` disagrees with how many
 * replies the mirror already holds. That is what keeps a refresh at one request
 * per page in the steady state instead of one per thread: an open task that is
 * being polled every minute costs the same whether it has one thread or ten.
 */
async function refreshComments(client: ClickUpClient, taskId: string): Promise<void> {
  const mirrored = await replyCounts(taskId);
  let threads = 0;

  for await (const page of client.iterateComments(taskId, { maxPages: COMMENT_PAGES })) {
    await ingestComments(db, taskId, page);

    for (const comment of page) {
      if (comment.reply_count === (mirrored.get(comment.id) ?? 0)) continue;
      if (threads++ >= THREADS_PER_REFRESH) return;
      await ingestReplies(db, taskId, comment.id, await client.getThreadedComments(comment.id));
    }
  }
}

/** Replies the mirror already has, per parent comment. */
async function replyCounts(taskId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ parentId: comments.parentCommentId, n: sql<number>`count(*)::int` })
    .from(comments)
    .where(and(eq(comments.taskId, taskId), isNotNull(comments.parentCommentId)))
    .groupBy(comments.parentCommentId);
  return new Map(rows.map((row) => [row.parentId ?? "", row.n]));
}

console.log(`[api] listening on http://localhost:${config.API_PORT}`);

export default { port: config.API_PORT, fetch: app.fetch, idleTimeout: 120 };
