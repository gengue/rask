import { ClickUpClient, type ClickUpTask, RateLimiter } from "@rask/clickup-client";
import {
  comments,
  createDb,
  ingestComments,
  ingestReplies,
  ingestTasks,
  loadToken,
  replaceListViews,
  syncCursors,
  tasks,
} from "@rask/schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { authRoutes, currentUser, type SessionUser } from "./auth.ts";
import { ChangeFeed } from "./changes.ts";
import { loadConfig } from "./config.ts";
import { fieldIdsIn, parseFilter } from "./filters.ts";
import {
  findListView,
  getHierarchy,
  getTaskDetail,
  listFilterFields,
  listMembers,
  listTasks,
  listViewsFor,
  resolveRefs,
  searchTasks,
  statusesForList,
} from "./queries.ts";
import { clickUpWebhookRoutes } from "./webhooks.ts";
import {
  applyChecklistItemPatch,
  applyCommentPatch,
  applyTaskPatch,
  checklistItemPatchInput,
  checklistPatchInput,
  commentPatchInput,
  createChecklist,
  createChecklistItem,
  createComment,
  createTask,
  deleteChecklist,
  deleteChecklistItem,
  deleteComment,
  discardPendingComment,
  findChecklist,
  findChecklistItem,
  findComment,
  newChecklistInput,
  newChecklistItemInput,
  newCommentInput,
  newTaskInput,
  renameChecklist,
  setCustomField,
  setTaskTags,
  taskPatchInput,
  taskTagsInput,
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

/**
 * A row the outbox has not shipped yet, so ClickUp has no id for it.
 *
 * Addressing one upstream would 404 and take the local state down with it on
 * the revert, so those writes are refused rather than queued. The window is a
 * couple of seconds — the outbox drains every two — and the UI says so.
 */
const pending = (id: string): boolean => id.startsWith("tmp_");
const NOT_YET = "this has not reached ClickUp yet";

type Env = { Variables: { user: SessionUser } };

const requireAuth = createMiddleware<Env>(async (c, next) => {
  const user = await currentUser(db, getCookie(c, config.SESSION_COOKIE_NAME));
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  c.set("user", user);
  await next();
});

const app = new Hono<Env>();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes(db, config));

/*
 * ClickUp's change feed. Registered here, before the SPA fallback below, and
 * outside the `api` group on purpose: it carries no session cookie, so putting
 * it behind `requireAuth` would 401 every delivery. Its own authentication is
 * the X-Signature check in webhooks.ts.
 */
app.route(
  "/webhooks",
  clickUpWebhookRoutes(db, config.encryptionKey, config.CLICKUP_WEBHOOK_SECRET),
);

const api = new Hono<Env>();
api.use("*", requireAuth);

api.get("/me", (c) => c.json(c.get("user")));

api.get("/hierarchy", async (c) => c.json(await getHierarchy(db)));

api.get("/members", async (c) => c.json(await listMembers(db)));

/** Task search across every list the mirror knows about. Backs the palette. */
api.get("/search", async (c) => c.json(await searchTasks(db, c.req.query("q") ?? "")));

/**
 * Identifies ids lifted out of a ClickUp URL, so a pasted ClickUp link can be
 * routed to whatever Rask view fits. The client sends candidates most-specific
 * first and gets back the first one that is anything.
 */
api.get("/resolve", async (c) => {
  const ids = (c.req.query("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 3);

  const found = await resolveRefs(db, ids);
  if (found) return c.json(found);

  // Nothing in the mirror. A /t/ URL is a task by construction, so ask ClickUp
  // once before giving up: it may live in a list nobody has opened yet. Only
  // real task ids work here, since GET /task/{id} needs custom_task_ids and a
  // team_id to accept a custom one and our client does not send them.
  const first = ids[0];
  if (c.req.query("remote") === "1" && first) {
    const client = await clientFor(c.get("user").id);
    const task = await client?.getTask(first).catch(() => null);
    if (task) {
      await ingestTasks(db, [task]);
      const refreshed = await resolveRefs(db, [task.id]);
      if (refreshed) return c.json(refreshed);
    }
  }

  return c.json({ kind: "unknown" } as const);
});

const taskFilters = z.object({
  list: z.string().optional(),
  space: z.string().optional(),
  assignee: z.string().optional(),
  status: z.string().optional(),
  tag: z.string().optional(),
  closed: z.enum(["0", "1"]).optional(),
  /**
   * The user's filter, as JSON: `[{field, op, values}, ...]`.
   *
   * JSON in a query parameter rather than a flat encoding of its own, because
   * this is exactly the shape ClickUp writes a view's filters in and inventing
   * a second spelling of it would mean two parsers and one of them being wrong.
   * `parseFilter` rejects a field it does not know rather than ignoring it.
   */
  filter: z.string().max(8000).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

api.get("/tasks", async (c) => {
  const query = taskFilters.safeParse(c.req.query());
  if (!query.success) return c.json({ error: z.prettifyError(query.error) }, 400);
  const f = query.data;

  let clauses: ReturnType<typeof parseFilter>;
  try {
    clauses = parseFilter(f.filter);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "bad filter" }, 400);
  }

  const limit = f.limit ?? 500;
  const rows = await listTasks(db, {
    listId: f.list,
    spaceId: f.space,
    assigneeId: f.assignee === "me" ? c.get("user").id : f.assignee,
    statuses: f.status ? f.status.split(",") : undefined,
    tag: f.tag,
    clauses,
    fieldIds: fieldIdsIn(clauses),
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

/**
 * The Custom Fields of one List that a filter can name.
 *
 * Its own route rather than part of the list payload: the filter menu is the
 * only thing that wants it, it is opened by a fraction of the people who open a
 * list, and the answer is the same for everyone looking at that list.
 */
api.get("/lists/:id/filter-fields", async (c) =>
  c.json(await listFilterFields(db, c.req.param("id"))),
);

/**
 * The tabs above a List.
 *
 * Answered from the mirror and re-read from ClickUp behind the response, the
 * same bargain as task detail. Unlike task detail there is no SSE push for the
 * result: somebody adding a view is a once-a-month event, and a tab bar that is
 * one navigation behind costs nothing next to a new event type that every
 * client has to understand.
 *
 * A List nobody has opened has no tabs to draw at all, so that one fetch is
 * worth waiting for.
 */
api.get("/lists/:id/views", async (c) => {
  const listId = c.req.param("id");
  const mirrored = await listViewsFor(db, listId);

  if (mirrored.length === 0) {
    await refreshListViews(c.get("user").id, listId);
    return c.json(await listViewsFor(db, listId));
  }

  void refreshListViews(c.get("user").id, listId);
  return c.json(mirrored);
});

/**
 * The tasks a view shows.
 *
 * The one read in the app that goes to ClickUp before it answers, and it has to:
 * a view's filters are ClickUp's to evaluate (`{field:"tag", op:"NOT ANY"}` and
 * a dozen operators besides), and reimplementing them over the mirror would be
 * rebuilding a filter engine that is wrong the first time somebody uses one we
 * had not met.
 *
 * What comes back is used as membership, not as data. `GET /view/{id}/task`
 * sends no `description` and no `text_content` and ignores
 * `include_markdown_description`, so ingesting it wholesale would blank the
 * description of every task in the view. Tasks the mirror has never seen are
 * ingested anyway — a row with no description beats a hole in the view, and the
 * list poll fills it in — and everything else is read from the mirror, which the
 * poll keeps current.
 */
api.get("/views/:id/tasks", async (c) => {
  const view = await findListView(db, c.req.param("id"));
  if (!view) return c.json({ error: "not found" }, 404);

  /*
   * The filter is read for one thing only: which Custom Field values to send.
   *
   * Applying its clauses here would shrink the membership set the browser keeps
   * for this view, so clearing a filter would mean asking ClickUp for the view
   * again — 1.8s a page — rather than showing rows already in hand. The rows
   * come back whole and the browser narrows them, which is also what the whole
   * ≤500-row set already allows it to do honestly.
   */
  let fieldIds: string[] = [];
  try {
    fieldIds = fieldIdsIn(parseFilter(c.req.query("filter")));
  } catch {
    return c.json({ error: "bad filter" }, 400);
  }

  const client = await clientFor(c.get("user").id);
  if (!client) return c.json({ error: "no ClickUp token" }, 409);

  let page: { tasks: ClickUpTask[]; truncated: boolean };
  try {
    page = await walkViewTasks(client, view.id);
  } catch (error) {
    // No mirrored fallback exists: without ClickUp there is no way to know
    // which tasks the view's filters keep. Say so rather than showing the
    // whole list and calling it a filtered view.
    return c.json(
      { error: error instanceof Error ? error.message : "ClickUp did not answer" },
      502,
    );
  }

  await ingestUnseen(page.tasks, view.listId);

  // Opening a view registers its list for polling, exactly like opening the list.
  await db
    .insert(syncCursors)
    .values({ scope: "list", scopeId: view.listId })
    .onConflictDoNothing();

  // `includeClosed`, always: ClickUp already applied the view's `show_closed`,
  // and filtering again here would drop rows the view deliberately keeps.
  const rows = await listTasks(db, {
    taskIds: page.tasks.map((task) => task.id),
    fieldIds,
    includeClosed: true,
    limit: VIEW_TASK_LIMIT,
  });
  c.header("X-Rask-Truncated", page.truncated ? "1" : "0");
  return c.json(rows);
});

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

/**
 * Checklist writes, all answering with the whole refreshed task detail.
 *
 * Same contract as comments and for the same reason: the task collection the
 * browser keeps carries no checklists, so there is no row for it to patch and
 * handing back the detail leaves it exactly in step with the mirror.
 */
api.post("/tasks/:id/checklists", async (c) => {
  const body = newChecklistInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const taskId = c.req.param("id");
  await createChecklist(db, { taskId, userId: c.get("user").id, checklist: body.data });
  return c.json(await getTaskDetail(db, taskId), 201);
});

api.patch("/checklists/:id", async (c) => {
  const body = checklistPatchInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const checklist = await findChecklist(db, c.req.param("id"));
  if (!checklist) return c.json({ error: "not found" }, 404);
  if (pending(checklist.id)) return c.json({ error: NOT_YET }, 409);

  await renameChecklist(db, { checklist, userId: c.get("user").id, name: body.data.name });
  return c.json(await getTaskDetail(db, checklist.taskId));
});

api.delete("/checklists/:id", async (c) => {
  const checklist = await findChecklist(db, c.req.param("id"));
  if (!checklist) return c.json({ error: "not found" }, 404);
  if (pending(checklist.id)) return c.json({ error: NOT_YET }, 409);

  await deleteChecklist(db, { checklist, userId: c.get("user").id });
  return c.json(await getTaskDetail(db, checklist.taskId));
});

api.post("/checklists/:id/items", async (c) => {
  const body = newChecklistItemInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const checklist = await findChecklist(db, c.req.param("id"));
  if (!checklist) return c.json({ error: "not found" }, 404);
  if (pending(checklist.id)) return c.json({ error: NOT_YET }, 409);

  await createChecklistItem(db, { checklist, userId: c.get("user").id, item: body.data });
  return c.json(await getTaskDetail(db, checklist.taskId), 201);
});

api.patch("/checklist-items/:id", async (c) => {
  const body = checklistItemPatchInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const item = await findChecklistItem(db, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  if (pending(item.id)) return c.json({ error: NOT_YET }, 409);

  await applyChecklistItemPatch(db, { item, userId: c.get("user").id, patch: body.data });
  return c.json(await getTaskDetail(db, item.taskId));
});

api.delete("/checklist-items/:id", async (c) => {
  const item = await findChecklistItem(db, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  if (pending(item.id)) return c.json({ error: NOT_YET }, 409);

  await deleteChecklistItem(db, { item, userId: c.get("user").id });
  return c.json(await getTaskDetail(db, item.taskId));
});

api.put("/tasks/:id/tags", async (c) => {
  const body = taskTagsInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  await setTaskTags(db, {
    taskId: c.req.param("id"),
    userId: c.get("user").id,
    tags: body.data.tags,
  });
  return c.json(await getTaskDetail(db, c.req.param("id")));
});

/**
 * The tags defined on a Space, straight from ClickUp.
 *
 * Not mirrored: the picker needs the full set including tags nobody has used
 * yet, and one request when someone opens the menu is cheaper than another
 * table to keep in sync.
 */
api.get("/spaces/:id/tags", async (c) => {
  const client = await clientFor(c.get("user").id);
  if (!client) return c.json({ error: "no ClickUp token" }, 409);
  const tags = await client.getSpaceTags(c.req.param("id")).catch(() => []);
  return c.json(tags.map((tag) => ({ name: tag.name, fg: tag.tag_fg, bg: tag.tag_bg })));
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
 * How many rows one view will send.
 *
 * The same cap the list route uses, for the same reason: the browser holds the
 * whole view in memory and filters it there. A view over a 5,696-task list says
 * `500+` in the header rather than truncating quietly.
 */
const VIEW_TASK_LIMIT = 500;

/** Re-reads a List's tabs. Failure is logged, never surfaced: the mirror answers. */
async function refreshListViews(userId: string, listId: string): Promise<void> {
  try {
    const client = await clientFor(userId);
    if (!client) return;
    await replaceListViews(db, listId, await client.getListViews(listId));
  } catch (error) {
    console.error("[views]", listId, error instanceof Error ? error.message : error);
  }
}

/** Walks a view's pages up to the cap, and says whether it stopped early. */
async function walkViewTasks(
  client: ClickUpClient,
  viewId: string,
): Promise<{ tasks: ClickUpTask[]; truncated: boolean }> {
  const collected: ClickUpTask[] = [];
  for await (const batch of client.iterateViewTasks(viewId)) {
    collected.push(...batch);
    if (collected.length > VIEW_TASK_LIMIT) {
      return { tasks: collected.slice(0, VIEW_TASK_LIMIT), truncated: true };
    }
  }
  return { tasks: collected, truncated: false };
}

/**
 * Mirrors only the tasks in a view that the mirror has never heard of.
 *
 * See the route: the view payload is thinner than a list page, so re-ingesting
 * a task we already hold would replace a real description with a null.
 */
async function ingestUnseen(batch: ClickUpTask[], listId: string): Promise<void> {
  if (batch.length === 0) return;
  const known = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      inArray(
        tasks.id,
        batch.map((task) => task.id),
      ),
    );
  const seen = new Set(known.map((row) => row.id));
  const unseen = batch.filter((task) => !seen.has(task.id));
  if (unseen.length > 0) await ingestTasks(db, unseen, { listId });
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
  /*
   * A thread whose parent predates the segments column has to be re-read even
   * when the counts agree.
   *
   * Without its segments, resolving a comment falls back to sending the flat
   * text and ClickUp replaces the body with it — deleting whatever image or
   * table made it worth keeping. Backfilling costs one request per thread,
   * once, and then the counts take over again.
   */
  const unbacked = await threadsMissingSegments(taskId);
  let threads = 0;

  for await (const page of client.iterateComments(taskId, { maxPages: COMMENT_PAGES })) {
    await ingestComments(db, taskId, page);

    for (const comment of page) {
      const counted = comment.reply_count === (mirrored.get(comment.id) ?? 0);
      if (counted && !unbacked.has(comment.id)) continue;
      if (threads++ >= THREADS_PER_REFRESH) return;
      await ingestReplies(db, taskId, comment.id, await client.getThreadedComments(comment.id));
    }
  }
}

/** Parents whose thread holds a comment mirrored before segments were stored. */
async function threadsMissingSegments(taskId: string): Promise<Set<string>> {
  const rows = await db
    .select({ parentId: comments.parentCommentId })
    .from(comments)
    .where(
      and(
        eq(comments.taskId, taskId),
        isNotNull(comments.parentCommentId),
        isNull(comments.segments),
      ),
    )
    .groupBy(comments.parentCommentId);
  return new Set(rows.map((row) => row.parentId ?? ""));
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
