import {
  ClickUpClient,
  type ClickUpTask,
  type ClickUpView,
  RateLimiter,
} from "@rask/clickup-client";
import { isPlaceholder } from "@rask/clickup-client/vocabulary";
import {
  comments,
  createDb,
  inboxReads,
  ingestComments,
  ingestReplies,
  ingestTasks,
  loadToken,
  replaceListViews,
  syncCursors,
  tasks,
  users,
  viewListId,
} from "@rask/schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { readUpload } from "./attachments.ts";
import { authRoutes, currentUser, type SessionUser } from "./auth.ts";
import { ChangeFeed } from "./changes.ts";
import { loadConfig } from "./config.ts";
import { fieldIdsIn, parseFilter } from "./filters.ts";
import {
  findListView,
  findViewMembership,
  getHierarchy,
  getTaskDetail,
  type ListViewRow,
  listFilterFields,
  listMembers,
  listTasks,
  listViewsFor,
  notableComments,
  resolveRefs,
  saveViewMembership,
  searchTasks,
  statusesForList,
} from "./queries.ts";
import { timeRoutes } from "./time.ts";
import { timesheetRoutes } from "./timesheet.ts";
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
  deleteTask,
  discardPendingComment,
  findChecklist,
  findChecklistItem,
  findComment,
  NOT_YET,
  newChecklistInput,
  newChecklistItemInput,
  newCommentInput,
  newTaskInput,
  renameChecklist,
  resolveCreatedTask,
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
  const client = new ClickUpClient({
    token: token.token,
    limiter: new RateLimiter(),
    baseUrl: config.CLICKUP_API_BASE,
  });
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
 * The detail a write just produced, answered to the caller and pushed to the
 * rest of that person's tabs.
 *
 * A comment or a checklist item moves its own `synced_at` and never the task's,
 * so the workspace feed — which watches `tasks.synced_at` — has nothing to
 * notice. The tab that wrote is fine, it gets the detail back in the response;
 * a second tab of the same person kept showing the conversation from before the
 * write until some later refresh happened to disagree. The rejection path
 * already pushes for exactly this reason, and this is the same thing when the
 * write works.
 *
 * One read, so the tab that asked and the tabs that did not are told the same
 * bytes. Other people's tabs still converge the slow way, through the poll.
 */
async function pushDetail(userId: string, taskId: string) {
  const detail = await getTaskDetail(db, taskId);
  if (detail) pushTo(userId, "task", detail);
  return detail;
}

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

/**
 * Marks the inbox read, up to now.
 *
 * One timestamp per user rather than a row per notification, because there are
 * no notifications to have rows: the inbox is a query over `tasks.date_updated`
 * and this is the only state it needs. Per-item read state would mean
 * materialising an event per change — see docs/architecture.md on why the
 * mirror stores state and not history.
 *
 * The instant comes from the server's clock, not the client's, so a browser
 * with a fast clock cannot mark unread things it never saw.
 */
api.post("/inbox/seen", async (c) => {
  const seenAt = new Date();
  const userId = c.get("user").id;

  await db.transaction(async (tx) => {
    await tx.update(users).set({ inboxSeenAt: seenAt }).where(eq(users.id, userId));
    /*
     * Every per-row dismissal is redundant the moment the watermark passes it,
     * so this is the sweep — no scheduled job, and no table that only ever
     * grows. Inside the transaction because the other order loses dismissals it
     * had no business touching: delete first, fail to move the watermark, and
     * rows somebody had cleared one at a time come back unread.
     */
    await tx.delete(inboxReads).where(eq(inboxReads.userId, userId));
  });

  return c.json({ inboxSeenAt: seenAt });
});

/**
 * Marks one feed entry read, leaving the rest of the inbox alone.
 *
 * Keyed by task because that is what a feed entry is: one row per task,
 * carrying at most one reason, so dismissing the mention and dismissing the row
 * are the same act. A comment posted after this is newer than `read_at` and
 * brings the row back, which is the point — this is "I have seen this", not
 * "never show me this task again".
 *
 * The instant is the server's, like the watermark's, and for the same reason:
 * the two are compared against each other.
 */
api.post("/inbox/read", async (c) => {
  const body = inboxReadInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const readAt = new Date();
  await db
    .insert(inboxReads)
    .values({ userId: c.get("user").id, taskId: body.data.taskId, readAt })
    .onConflictDoUpdate({
      target: [inboxReads.userId, inboxReads.taskId],
      // Always forward. A second dismissal after a new comment has to cover the
      // new comment rather than restate the instant of the first one.
      set: { readAt },
    });

  return c.json({ taskId: body.data.taskId, readAt });
});

/**
 * The window the inbox draws, tasks and reasons together.
 *
 * Its own route rather than a parameter on `GET /api/tasks`, because it answers
 * a different question and returns a different shape. A feed entry is a task
 * *and why it is here*, and the why is a comment — a join no other view wants
 * to pay for, on a route every list read goes through.
 *
 * One round trip on purpose. The tasks have to reach the browser's collection
 * for the unread count and the live updates to work at all, and the reasons are
 * useless without them, so splitting this in two would mean a feed that renders
 * twice: once as bare rows, once with what people said.
 */
api.get("/inbox", async (c) => {
  const query = inboxQuery.safeParse(c.req.query());
  if (!query.success) return c.json({ error: z.prettifyError(query.error) }, 400);

  const userId = c.get("user").id;
  const since = new Date(query.data.since);
  const limit = query.data.limit ?? 500;

  const [reasons, changed, reads] = await Promise.all([
    notableComments(db, userId, since, limit),
    listTasks(db, { assigneeId: userId, includeClosed: true, updatedSince: since, limit }),
    /*
     * Sent rather than applied, so the other scope can still show what you
     * dismissed. Filtering these out here would make "mark as read"
     * indistinguishable from "delete", which is the door the window scope
     * exists to keep open.
     */
    db
      .select({ taskId: inboxReads.taskId, readAt: inboxReads.readAt })
      .from(inboxReads)
      .where(eq(inboxReads.userId, userId)),
  ]);

  const truncated = changed.length > limit;
  if (truncated) changed.length = limit;

  /*
   * Tasks somebody commented on that are not already in the window.
   *
   * A mention reaches you on a task you have never touched and whose own mtime
   * may not have moved, so the first query cannot find it. Fetched by id rather
   * than by widening that query, because "these exact rows" is what the mirror
   * is fastest at and the set is bounded by the reasons above it.
   */
  const have = new Set(changed.map((task) => task.id));
  const missing = [...new Set(reasons.map((r) => r.taskId))].filter((id) => !have.has(id));
  const extra = missing.length
    ? await listTasks(db, { taskIds: missing, includeClosed: true, limit: missing.length })
    : [];

  return c.json({ tasks: [...changed, ...extra], reasons, reads, truncated });
});

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

  /*
   * Nothing in the mirror, so spend one ClickUp request — but only when the URL
   * said what the id was.
   *
   * `remote` is the browser passing on what the routing words in the address
   * meant: `/t/` heads a task, `/v/l/` heads a view. Both can name something
   * real that the mirror has never held — a task in a list nobody opened, or a
   * view hanging off a Workspace, which `list_views` is keyed by a List and so
   * cannot hold at all. Every other shape gets no request: a miss there is the
   * answer, and asking would only spend a round trip to confirm it.
   *
   * Only the first candidate either way. The rest are the routing context the
   * id was found in ("529", "v"), and asking about those is two more requests
   * to learn what the mirror already said.
   */
  const first = ids[0];
  const remote = c.req.query("remote");
  if (!first || (remote !== "task" && remote !== "view")) {
    return c.json({ kind: "unknown" } as const);
  }

  const client = await clientFor(c.get("user").id);

  if (remote === "task") {
    // Only real task ids work here: GET /task/{id} needs custom_task_ids and a
    // team_id to accept a custom one, and our client does not send them.
    const task = await client?.getTask(first).catch(() => null);
    if (task) {
      await ingestTasks(db, [task]);
      const refreshed = await resolveRefs(db, [task.id]);
      if (refreshed) return c.json(refreshed);
    }
    return c.json({ kind: "unknown" } as const);
  }

  const view = await client?.getView(first).catch(() => null);
  if (view) {
    const row = remoteView(view);
    return c.json({ kind: "view", viewId: row.id, listId: row.listId, name: row.name } as const);
  }

  return c.json({ kind: "unknown" } as const);
});

/**
 * `since` is epoch milliseconds, bounded by the largest instant a Date can
 * hold. Past it `new Date(n)` is an Invalid Date, which reaches the driver and
 * comes back as a 500 — and a malformed query parameter is the one thing a
 * validated boundary owes a 400.
 *
 * The client sends the instant rather than the server reading `inbox_seen_at`
 * for it, because the page and the unread badge ask for two different windows
 * off the same route: the page shows a few days of history, the badge only what
 * arrived since the last visit.
 */
const inboxReadInput = z.object({ taskId: z.string().min(1).max(64) });

const inboxQuery = z.object({
  since: z.coerce.number().int().positive().max(8.64e15),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
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

  // Before the read, not after it: the first ask for a list is also the only
  // one the mirror cannot answer, and `registerList` is what fills it.
  if (f.list) await registerList(c.get("user").id, f.list, f.closed === "1");

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
 * One view's definition: its name, its type, and how it wants to be grouped.
 *
 * The tab bar reads views a List at a time and never needs this. A view opened
 * by its own address does: there is no tab bar above it to have carried the
 * name and the grouping down, so the route asks for the one view it is showing.
 */
api.get("/views/:id", async (c) => {
  const view = await viewFor(c.get("user").id, c.req.param("id"));
  return view ? c.json(view) : c.json({ error: "not found" }, 404);
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
  const userId = c.get("user").id;
  const view = await viewFor(userId, c.req.param("id"));
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

  /*
   * The last walk's answer, painted first; the fresh one arrives over SSE.
   *
   * This is task detail's bargain applied to the one read that used to block on
   * ClickUp: answer from what is remembered, repair behind the response. The
   * membership is the only thing remembered — the rows still come from the
   * mirror below, which the poll keeps current — and the filter stays out of
   * the key because membership never depends on it; `fieldIds` applies at the
   * mirror read on both paths.
   *
   * The age gate is for a membership nobody has walked in a day: stale rows
   * self-correct in seconds, but a week-old set painted while ClickUp is down
   * would stand indefinitely, claiming to be the view. Today's 502 was at least
   * honest, so past the gate the walk blocks again.
   */
  const remembered = await findViewMembership(db, view.id, userId);
  if (remembered && Date.now() - remembered.syncedAt.getTime() < VIEW_MEMBERSHIP_MAX_AGE_MS) {
    // Still the claim, even on a hit: the cursor row can be gone while the
    // membership survived — a rebuilt sync table — and a list somebody opens
    // daily would otherwise never be polled again.
    if (view.listId) await registerList(userId, view.listId, true);

    void revalidateView(userId, view);

    const rows = await listTasks(db, {
      taskIds: remembered.taskIds,
      fieldIds,
      includeClosed: true,
      limit: VIEW_TASK_LIMIT,
    });
    c.header("X-Rask-Truncated", remembered.truncated ? "1" : "0");
    return c.json(rows);
  }

  const client = await clientFor(userId);
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

  /*
   * Opening a view registers its list, exactly like opening the list — and by
   * the same call, because registering is also claiming. A view is a subset its
   * filters chose, so a row written here without the fill would leave the list
   * route reading a mirror holding that subset and nothing else. Which is how
   * somebody arrives: a ClickUp URL is a view's URL, so the pasted link lands
   * on the tab and the sidebar entry is the second thing clicked.
   *
   * Before `ingestUnseen` and not after, so the thick payload wins. A row this
   * fills carries a description; the view payload does not, and `ingestTasks`
   * skips a row whose `date_updated` has not moved — so a thin row written
   * first would keep its null description until somebody edited the task.
   *
   * Skipped for a view that has no single list. A Workspace-level view spans
   * every list in the workspace, so there is no one list here to register —
   * registering the first task's would poll one arbitrary list and call the
   * other forty covered.
   */
  if (view.listId) await registerList(userId, view.listId, true);

  await ingestUnseen(page.tasks, view.listId);

  // After `ingestUnseen`, never before: a membership committed ahead of the
  // rows it names would, on a crash between the two, leave every later hit
  // rendering holes for ids the mirror has never seen.
  await saveViewMembership(db, {
    viewId: view.id,
    userId,
    taskIds: page.tasks.map((task) => task.id),
    truncated: page.truncated,
  });

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

/**
 * What a placeholder task turned into.
 *
 * A browser can be showing `?task=tmp_…` when the outbox drains and the
 * placeholder dies; this is how it follows the task to its real id instead of
 * being left holding a snapshot no write can address. See `resolveCreatedTask`.
 */
api.get("/tasks/:id/resolved", async (c) =>
  c.json(await resolveCreatedTask(db, c.req.param("id"))),
);

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

api.delete("/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  // Nothing to address upstream yet: ClickUp has not assigned an id, so a
  // DELETE would 404 and the outbox row would fail for a task that only ever
  // existed in this browser.
  if (isPlaceholder(taskId)) return c.json({ error: NOT_YET }, 409);

  const deleted = await deleteTask(db, { taskId, userId: c.get("user").id });
  if (!deleted) return c.json({ error: "not found" }, 404);

  // A subtask is also a line in its parent's detail, and the parent's own row
  // did not move — same reason the create route pushes it. The change feed
  // cannot repair this one at all: it carries rows, and this row is a tombstone
  // the browser drops rather than a parent it re-reads.
  if (deleted.parentId) await pushDetail(c.get("user").id, deleted.parentId);

  // The tombstone reaches every other client through the feed within the
  // second; the caller gets told plainly so it can drop the row now.
  return c.json({ deleted: true });
});

api.post("/tasks", async (c) => {
  const body = newTaskInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const id = await createTask(db, { userId: c.get("user").id, task: body.data });
  // The new row reaches every client through the feed, but a subtask is also a
  // line in its parent's detail, and the parent's own row did not move.
  if (body.data.parentId) await pushDetail(c.get("user").id, body.data.parentId);
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
  return c.json(await pushDetail(c.get("user").id, taskId), 201);
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
  if (isPlaceholder(comment.id)) {
    return c.json({ error: "this comment has not reached ClickUp yet" }, 409);
  }

  await applyCommentPatch(db, { comment, userId: c.get("user").id, patch: body.data });
  return c.json(await pushDetail(c.get("user").id, comment.taskId));
});

api.delete("/comments/:id", async (c) => {
  const comment = await findComment(db, c.req.param("id"));
  if (!comment) return c.json({ error: "not found" }, 404);
  if (comment.userId !== c.get("user").id) {
    return c.json({ error: "you can only delete your own comments" }, 403);
  }

  const userId = c.get("user").id;
  if (isPlaceholder(comment.id)) await discardPendingComment(db, { comment, userId });
  else await deleteComment(db, { comment, userId });

  return c.json(await pushDetail(userId, comment.taskId));
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
  return c.json(await pushDetail(c.get("user").id, taskId), 201);
});

api.patch("/checklists/:id", async (c) => {
  const body = checklistPatchInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const checklist = await findChecklist(db, c.req.param("id"));
  if (!checklist) return c.json({ error: "not found" }, 404);
  if (isPlaceholder(checklist.id)) return c.json({ error: NOT_YET }, 409);

  await renameChecklist(db, { checklist, userId: c.get("user").id, name: body.data.name });
  return c.json(await pushDetail(c.get("user").id, checklist.taskId));
});

api.delete("/checklists/:id", async (c) => {
  const checklist = await findChecklist(db, c.req.param("id"));
  if (!checklist) return c.json({ error: "not found" }, 404);
  if (isPlaceholder(checklist.id)) return c.json({ error: NOT_YET }, 409);

  await deleteChecklist(db, { checklist, userId: c.get("user").id });
  return c.json(await pushDetail(c.get("user").id, checklist.taskId));
});

api.post("/checklists/:id/items", async (c) => {
  const body = newChecklistItemInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const checklist = await findChecklist(db, c.req.param("id"));
  if (!checklist) return c.json({ error: "not found" }, 404);
  if (isPlaceholder(checklist.id)) return c.json({ error: NOT_YET }, 409);

  await createChecklistItem(db, { checklist, userId: c.get("user").id, item: body.data });
  return c.json(await pushDetail(c.get("user").id, checklist.taskId), 201);
});

api.patch("/checklist-items/:id", async (c) => {
  const body = checklistItemPatchInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  const item = await findChecklistItem(db, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  if (isPlaceholder(item.id)) return c.json({ error: NOT_YET }, 409);

  await applyChecklistItemPatch(db, { item, userId: c.get("user").id, patch: body.data });
  return c.json(await pushDetail(c.get("user").id, item.taskId));
});

api.delete("/checklist-items/:id", async (c) => {
  const item = await findChecklistItem(db, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  if (isPlaceholder(item.id)) return c.json({ error: NOT_YET }, 409);

  await deleteChecklistItem(db, { item, userId: c.get("user").id });
  return c.json(await pushDetail(c.get("user").id, item.taskId));
});

/**
 * Uploads a file to a task.
 *
 * The one write in the app that does not go through the outbox. A queue row is
 * JSON and a file is bytes, so queueing this would mean a staging table holding
 * blobs in Postgres — and ClickUp's own client is not optimistic about uploads
 * either, it shows a progress bar. So this waits for ClickUp, and a refusal is
 * a message against the file that failed rather than a row that appears and
 * vanishes two seconds later.
 */
api.post("/tasks/:id/attachments", async (c) => {
  const taskId = c.req.param("id");
  // Nothing upstream to attach to yet, and the CDN URL a comment would link to
  // does not exist until ClickUp holds the file.
  if (isPlaceholder(taskId)) return c.json({ error: NOT_YET }, 409);

  // Before the body, not after: a request with no token behind it should not
  // cost 25MB of buffer to refuse.
  const client = await clientFor(c.get("user").id);
  if (!client) return c.json({ error: "no ClickUp token" }, 409);

  const upload = await readUpload(c.req.raw);
  if (!upload.ok) return c.json({ error: upload.error }, upload.status);

  let uploaded: { id: string; url: string | null };
  try {
    const created = await client.createTaskAttachment(taskId, upload.file);
    uploaded = { id: created.id, url: created.url ?? null };
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "upload failed" }, 502);
  }

  /*
   * The mirror learns about the file by re-reading the task, the same way it
   * learns about everything else: the upload response carries no size, no
   * mimetype and no `url_w_query`, so storing it would write a row the next
   * poll has to correct. Comments are not worth re-reading for a file.
   */
  await refreshTask(c.get("user").id, taskId, { comments: false });

  const detail = await getTaskDetail(db, taskId);
  // Only reachable if the re-read failed on a task the mirror never held, in
  // which case there is nothing to answer with and saying so beats a null the
  // client has to branch on.
  if (!detail) return c.json({ error: "not found" }, 404);

  const mirrored = detail.attachments.find((row) => row.id === uploaded.id);
  return c.json(
    {
      attachment: {
        id: uploaded.id,
        title: mirrored?.title ?? upload.file.name,
        // Both, because which one a comment links to is the browser's call, and
        // both fall back to the upload's own URL for the window where the
        // re-read has not landed.
        url: mirrored?.url ?? uploaded.url,
        urlWithQuery: mirrored?.urlWithQuery ?? uploaded.url,
      },
      detail,
    },
    201,
  );
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

/*
 * `mirror` is optional and means "store this instead of what ClickUp is sent".
 * Only a People field needs it — that one goes up as a delta — and leaving it
 * out means the two are the same value. It is `unknown` for the same reason
 * `value` is: what a Custom Field holds is the field type's business, and the
 * browser is the side that knows the type.
 */
const customFieldInput = z.object({ value: z.unknown(), mirror: z.unknown() });

api.put("/tasks/:id/fields/:fieldId", async (c) => {
  const body = customFieldInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

  await setCustomField(db, {
    taskId: c.req.param("id"),
    fieldId: c.req.param("fieldId"),
    userId: c.get("user").id,
    value: body.data.value,
    mirror: body.data.mirror,
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
      // Clearing the cursor is the whole resync: the read that follows has
      // nothing to resume from and takes the list end to end. `lastRunAt` goes
      // with it so the worker treats this as a list nobody has read and picks
      // it up in seconds — waiting up to ten minutes for the next poll is not
      // what anyone means by pressing resync.
      set: { lastUpdatedAt: null, lastRunAt: null, failures: 0, lastError: null },
    });
  return c.json({ ok: true }, 202);
});

/*
 * Time tracking, in a module of its own.
 *
 * Mounted on `api` and not `app`, like everything else that needs a session:
 * `auth.test.ts` walks the route table and asserts anything outside a five-name
 * allow-list answers 401.
 */
api.route(
  "/",
  timeRoutes({
    db,
    clientFor,
    pushTo,
    refreshTask: (userId, taskId, options) => refreshTask(userId, taskId, options),
  }),
);

api.route(
  "/timesheet",
  timesheetRoutes({
    db,
    clientFor,
    // The sheet only needs the task row: paying for a comment walk per
    // unknown task is waste, and a comment-insert failure there would abort
    // the refresh before ingestTasks ran — leaving the sheet on "…" forever
    // for tasks whose conversations it never asked about.
    repairTask: (userId, taskId) => refreshTask(userId, taskId, { comments: false }),
  }),
);

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

/**
 * A view, from the mirror if it is there and from ClickUp if it is not.
 *
 * The mirror holds the views of every List somebody has opened, which is every
 * view the tab bar can reach. It does not hold — and by its key cannot hold —
 * the ones that hang off a Workspace, a Space or a Folder. Those only ever
 * arrive by id, out of a pasted URL, so this is where the miss turns into one
 * request instead of a 404.
 *
 * Not written back: `list_views.list_id` is the table's key and these have no
 * List to key them by. So the miss is remembered here instead, briefly: opening
 * a container view resolves it twice in a row — `GET /views/:id` for the
 * definition, then `/views/:id/tasks` for the rows, which only fires once the
 * first has answered — and without the memo both misses go to ClickUp,
 * serially, ahead of the five-page walk the tasks route is about to pay for.
 *
 * Keyed by view and not by user: a definition is a name, a type and a grouping,
 * the same for everyone ClickUp lets in. Failures are not remembered — a `null`
 * memoized during a ClickUp wobble would hold "not found" for a minute.
 */
const REMOTE_VIEW_TTL_MS = 60_000;
const remoteViews = new Map<string, { row: ListViewRow; at: number }>();

async function viewFor(userId: string, viewId: string): Promise<ListViewRow | null> {
  const mirrored = await findListView(db, viewId);
  if (mirrored) return mirrored;

  const cached = remoteViews.get(viewId);
  if (cached) {
    if (Date.now() - cached.at < REMOTE_VIEW_TTL_MS) return cached.row;
    remoteViews.delete(viewId);
  }

  const client = await clientFor(userId);
  const view = await client?.getView(viewId).catch(() => null);
  if (!view) return null;

  const row = remoteView(view);
  remoteViews.set(viewId, { row, at: Date.now() });
  return row;
}

/**
 * A view ClickUp answered for, as the row the rest of Rask reads.
 *
 * `parent.type` is the whole point: it says which level the view lives at, and
 * only a List-level one has a list to attribute rows to. `isDefault` is false
 * by construction — being the default is a property of a container's tab bar,
 * and a view reached by its own address has no tab bar above it.
 */
function remoteView(view: ClickUpView): ListViewRow {
  return {
    id: view.id,
    listId: viewListId(view),
    name: view.name,
    type: view.type,
    isDefault: false,
    groupField: view.grouping?.field ?? null,
    showClosed: view.filters?.show_closed ?? false,
    publicUrl: view.public_url ?? null,
  };
}

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

/**
 * How long a read will wait for the first page of a list nobody has opened.
 *
 * There is a floor under being late and no floor under being stuck: the
 * worker's cold pass runs every three seconds, so waiting much longer than that
 * buys nothing the browser was not about to get anyway. Being stuck is real —
 * one `ClickUpClient` per user serializes every caller through one rate limiter,
 * and a 429 makes it sleep until the window resets, so without a deadline a
 * list opened behind a saved view's five-page walk holds the request open for
 * as long as that takes.
 */
const COLD_FILL_MS = 4_000;

/**
 * Marks a List worth polling, and fills it if nobody has opened it before.
 *
 * The registration is the cursor row: the worker polls the lists in
 * `sync_cursors` and no others, so a list nobody has looked at is never read.
 * Both routes that can be somebody's first sight of a list come through here,
 * because the row is also the claim — whichever writes it decides the list is
 * accounted for, and one that registered without filling would leave the next
 * read answering from a mirror that has nothing in it.
 *
 * The fill is the part that was missing. Reads are answered from the mirror,
 * and the mirror has nothing for a list it has never synced, so the first open
 * returned an empty page — which the browser draws as "Nothing here", a claim
 * rather than a wait. The worker's cold pass corrects it within seconds and SSE
 * pushes the rows into the open tab, but "within seconds" is a long time to be
 * told a list is empty, and it is why opening a list and then clicking one of
 * its tabs looked like the tab was the thing that worked.
 *
 * So one page is fetched here, the same bargain `GET /lists/:id/views` already
 * makes for the tab bar. One page and not the list: the cold pass walks the
 * rest with the cursor bookkeeping this deliberately does not touch.
 *
 * The page is the list's own newest, not the caller's query. `includeClosed` is
 * passed because a first page of 100 closed tasks is the same empty screen this
 * exists to avoid, but a status or assignee filter is not: those are the
 * mirror's to apply, and a list opened with one still narrows to nothing until
 * the cold pass lands. Rarer than the bare open, and it costs one round trip to
 * make it rarer still rather than one per clause.
 *
 * Failure is logged, never surfaced: the mirror answers. The list is registered
 * either way, so the worst case is the empty screen with the cold pass still on
 * its way.
 */
async function registerList(userId: string, listId: string, includeClosed: boolean): Promise<void> {
  // The cursor row is the registration and the claim in one statement: a row
  // coming back from `onConflictDoNothing` means nobody had asked for this list
  // before, with no window between the question and the answer for a second
  // request to decide the same thing and fetch a second time.
  const [claimed] = await db
    .insert(syncCursors)
    .values({ scope: "list", scopeId: listId })
    .onConflictDoNothing()
    .returning({ id: syncCursors.scopeId });
  if (!claimed) return;

  await Promise.race([fillList(userId, listId, includeClosed), Bun.sleep(COLD_FILL_MS)]);
}

/** The fetch half of `registerList`, separated only so the deadline can race it. */
async function fillList(userId: string, listId: string, includeClosed: boolean): Promise<void> {
  try {
    const client = await clientFor(userId);
    if (!client) return;
    const page = await client.getListTasks(listId, {
      includeClosed,
      subtasks: true,
      orderBy: "updated",
    });
    await ingestTasks(db, page.tasks, { listId, teamId: config.CLICKUP_TEAM_ID });
  } catch (error) {
    console.error("[cold]", listId, error instanceof Error ? error.message : error);
  }
}

/**
 * How old a remembered membership can be and still be worth painting first.
 *
 * Generous on purpose: within the window a stale set self-corrects seconds
 * later over SSE, so the only cost of age is a brief flash of last week's
 * rows. The ceiling exists for the failure mode — ClickUp unreachable, no
 * revalidation landing — where a very old set would otherwise stand forever
 * while claiming to be the view.
 */
const VIEW_MEMBERSHIP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Re-walks a view behind a response already answered, and pushes what changed.
 *
 * The same shape as `refreshTask`: the route paints from what is remembered,
 * this repairs it, and the `view` SSE event carries the fresh membership to
 * the tabs of the person who asked. Ids only — the rows travel on the `tasks`
 * feed, which `ingestUnseen` wakes for anything the mirror had not seen.
 *
 * Single-flighted per view and user: three tabs opening one view queue three
 * revalidations behind one rate limiter, and the second and third would walk
 * ClickUp to learn what the first just wrote down.
 *
 * Failure is logged, never surfaced. The remembered membership stands, which
 * is exactly what it is for.
 */
const viewRevalidations = new Map<string, Promise<void>>();

function revalidateView(userId: string, view: ListViewRow): Promise<void> {
  const key = `${view.id}|${userId}`;
  const running = viewRevalidations.get(key);
  if (running) return running;

  const walk = (async () => {
    try {
      const client = await clientFor(userId);
      if (!client) return;
      const page = await walkViewTasks(client, view.id);
      await ingestUnseen(page.tasks, view.listId);
      const ids = page.tasks.map((task) => task.id);
      await saveViewMembership(db, {
        viewId: view.id,
        userId,
        taskIds: ids,
        truncated: page.truncated,
      });
      pushTo(userId, "view", { viewId: view.id, ids, truncated: page.truncated });
    } catch (error) {
      console.error("[view]", view.id, error instanceof Error ? error.message : error);
    } finally {
      viewRevalidations.delete(key);
    }
  })();

  viewRevalidations.set(key, walk);
  return walk;
}

/**
 * Walks a view's pages up to the cap, and says whether it stopped early.
 *
 * Deduplicated, because pages are read from a live view: a task that moves
 * while the walk is in flight can sit on two pages at once, and a batch that
 * names one id twice makes `ingestTasks`'s multi-row upsert refuse the whole
 * insert ("cannot affect row a second time") — which would silently drop
 * every task the walk found, not just the doubled one.
 */
async function walkViewTasks(
  client: ClickUpClient,
  viewId: string,
): Promise<{ tasks: ClickUpTask[]; truncated: boolean }> {
  const collected: ClickUpTask[] = [];
  const seen = new Set<string>();
  for await (const batch of client.iterateViewTasks(viewId)) {
    for (const task of batch) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      collected.push(task);
    }
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
async function ingestUnseen(batch: ClickUpTask[], listId: string | null): Promise<void> {
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
  // `listId` is a fallback, not an assertion: `GET /view/{id}/task` echoes each
  // task's own list back, which is the only thing that makes a view spanning
  // forty lists ingestable at all. It is passed for the views that have one so
  // a payload that ever omits the list still lands somewhere right.
  if (unseen.length > 0) await ingestTasks(db, unseen, { listId: listId ?? undefined });
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

async function refreshTask(
  userId: string,
  taskId: string,
  options: { comments?: boolean } = {},
): Promise<void> {
  try {
    if (isPlaceholder(taskId)) return;
    const client = await clientFor(userId);
    if (!client) return;

    const [task] = await Promise.all([
      client.getTask(taskId),
      // Skipped by the upload path: a file says nothing about the conversation,
      // and re-reading it costs a page of comments plus a request per thread
      // whose count moved, out of the uploader's own rate budget.
      options.comments === false ? null : refreshComments(client, taskId),
    ]);
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

/*
 * Exported so a test can walk the route table.
 *
 * `apps/api/test/auth.test.ts` asserts every route outside a five-name
 * allow-list answers 401, which is the check that catches a route registered on
 * `app` instead of `api` and therefore silently public. It used to get at this
 * by mocking Hono's constructor.
 */
export { app };

// Only when run, not when imported. A test that imports this file to read its
// routes should not announce a server that is not listening.
if (import.meta.main) {
  console.log(`[api] listening on http://localhost:${config.API_PORT}`);
}

export default { port: config.API_PORT, fetch: app.fetch, idleTimeout: 120 };
