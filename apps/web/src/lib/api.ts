import { UPLOAD_FIELD } from "@rask/clickup-client/vocabulary";
import type { RemoteLookup } from "./clickup-url.ts";
import type { FieldWrite } from "./custom-fields.ts";
import { markSignedOut } from "./signed-out.ts";

/**
 * Typed wrapper over the Rask API.
 *
 * Same-origin in dev via Vite's proxy and in production because one process
 * serves both, so the session cookie rides along without any CORS ceremony.
 */

export interface Assignee {
  id: string;
  username: string | null;
  initials: string | null;
  color: string | null;
  avatar: string | null;
  /** Only the workspace directory carries this; task assignees do not. */
  email?: string | null;
}

export interface Tag {
  name: string;
  fg?: string | null;
  bg?: string | null;
}

export interface StatusDef {
  id?: string | null;
  status: string;
  color?: string | null;
  type?: string | null;
  orderindex?: number | null;
}

export interface Task {
  id: string;
  customId: string | null;
  name: string;
  status: string | null;
  statusColor: string | null;
  statusType: string | null;
  priority: number | null;
  dueDate: string | null;
  startDate: string | null;
  dateUpdated: string | null;
  dateCreated: string | null;
  listId: string;
  spaceId: string | null;
  parentId: string | null;
  tags: Tag[];
  url: string | null;
  listName: string | null;
  deletedAt: string | null;
  archived: boolean;
  assignees: Assignee[];
  /**
   * Values of the Custom Fields the active filter names, keyed by field id and
   * held as the raw JSON text the mirror stores — `"1"` for the second option
   * of a drop-down, which is what ClickUp puts there.
   *
   * Null when the query asked for none, which is not the same as `{}`. A row
   * carrying no values was never tested against a Custom Field clause, so
   * `lib/filters.ts` fails it rather than letting it through a `NOT ANY`.
   */
  customValues?: Record<string, string> | null;
}

/**
 * Why a task is in the inbox, when the reason is something somebody said.
 *
 * `kind` is ranked: a mention outranks a comment assigned to you, which
 * outranks anything else said on a task of yours. The server picks one comment
 * per task by that ranking and then by recency, so this is the strongest reason
 * to look rather than merely the latest.
 */
export interface InboxReason {
  taskId: string;
  commentId: string;
  kind: "mention" | "assigned" | "comment";
  authorId: string | null;
  authorName: string | null;
  authorAvatar: string | null;
  /** Already flattened and trimmed by the server. One line of a feed. */
  excerpt: string;
  /** When the comment on the row was written. */
  at: string | null;
  /**
   * When the newest notable comment on the task was written, ranked or not.
   *
   * What unread is measured from. `at` is the line being shown, and the two
   * differ whenever a stronger reason is older than the latest one — a mention
   * followed by somebody's "ok".
   */
  latestAt: string | null;
}

/** One feed entry somebody dismissed on its own, and when. */
export interface InboxRead {
  taskId: string;
  readAt: string;
}

/** A page of tasks, plus what was said on them. `TaskPage` is the half that
 *  goes into the shared collection. */
export interface InboxPage extends TaskPage {
  reasons: InboxReason[];
  reads: InboxRead[];
}

export interface Comment {
  id: string;
  parentCommentId: string | null;
  /** ClickUp's flat body. What the composer edits and what goes back upstream. */
  text: string | null;
  /**
   * The rich body — images, files, mentions, lists — rendered to markdown at
   * ingest. Null until ClickUp has answered, so render `markdown ?? text`.
   */
  markdown: string | null;
  /**
   * False when the body holds something ClickUp's edit endpoint would destroy —
   * an image, a file, a table. Those get an Open in ClickUp link instead of an
   * edit control, since PUT replaces the comment with whatever text we send.
   */
  editable: boolean;
  date: string | null;
  /** Set only when Rask rewrote the body; ClickUp has no edit timestamp. */
  editedAt: string | null;
  resolved: boolean;
  replyCount: number;
  userId: string | null;
  username: string | null;
  initials: string | null;
  color: string | null;
  avatar: string | null;
}

/** A top-level comment with its thread. ClickUp threads are one level deep. */
export interface CommentThread extends Comment {
  replies: Comment[];
}

export interface CustomField {
  id: string;
  name: string;
  type: string;
  typeConfig: unknown;
  value: unknown;
}

/**
 * A file on a task.
 *
 * Both URLs point straight at ClickUp's attachment CDN, which is public: no
 * token, no signature, nothing for the API to proxy. They differ in what the
 * CDN says about them — `url` comes back as a download, `urlWithQuery` carries
 * the `?view=open` that makes it render in place. Images use the first, links
 * use the second.
 */
export interface Attachment {
  id: string;
  title: string | null;
  extension: string | null;
  mimetype: string | null;
  /** Bytes. */
  size: number | null;
  date: string | null;
  /**
   * ~80px on the long edge, which is a strip rather than a picture. Kept as the
   * fallback for a file ClickUp gave no medium render.
   */
  thumbnailSmall: string | null;
  /**
   * The one worth showing. A 533px render for a PDF or a video; for an image it
   * is the original file, which means the grid and the lightbox share a
   * download instead of fetching the same picture twice.
   */
  thumbnailMedium: string | null;
  url: string | null;
  urlWithQuery: string | null;
}

/**
 * What an upload answers with: the file, and the task as the mirror now holds
 * it.
 *
 * The attachment is named separately rather than left to be found inside the
 * detail, because the composer needs its URL to write a link and the re-read
 * that fills `detail.attachments` can land a moment late.
 */
export interface AttachmentUpload {
  attachment: Pick<Attachment, "id" | "title" | "url" | "urlWithQuery">;
  detail: TaskDetail;
}

/**
 * A ClickUp Doc that lives inside a task.
 *
 * A Doc is a stack of pages, and a one-page Doc is the common case — the panel
 * only shows page names once there is more than one of them.
 */
export interface Doc {
  id: string;
  name: string;
  /** ISO 8601. */
  updated: string | null;
  pages: DocPage[];
}

export interface DocPage {
  id: string;
  name: string;
  /** Markdown, rendered through the same sanitizer as a task description. */
  content: string;
  /** How deep the page sits. The list is flat and in reading order. */
  depth: number;
  /** The page's emoji, when it has one. */
  icon: string | null;
  /** Banner across the top of the page. A public ClickUp attachments URL. */
  cover: string | null;
  /** ISO 8601. */
  updated: string | null;
  /** ClickUp user ids, resolved against the workspace directory for faces. */
  authors: string[];
  contributors: string[];
}

export interface ChecklistItem {
  id: string;
  name: string;
  resolved: boolean;
  assigneeId: string | null;
  /** Set on an item nested under another. ClickUp's UI allows one level. */
  parentItemId: string | null;
}

/** One "did I do the four things" list inside a task. */
export interface Checklist {
  id: string;
  name: string;
  items: ChecklistItem[];
}

/** Enough of a task to draw one line of it and link to it. */
export interface TaskRef {
  id: string;
  customId: string | null;
  name: string;
  status: string | null;
  statusColor: string | null;
  statusType: string | null;
  listId: string;
  dueDate: string | null;
  timeEstimate: number | null;
  timeSpent: number | null;
  assignees: Assignee[];
}

export interface TaskDetail extends Task {
  description: string | null;
  creatorId: string | null;
  folderId: string | null;
  timeEstimate: number | null;
  /** Milliseconds tracked by everyone. The one mirrored trace of time tracking. */
  timeSpent: number | null;
  points: number | null;
  dateClosed: string | null;
  comments: CommentThread[];
  customFields: CustomField[];
  statuses: StatusDef[];
  attachments: Attachment[];
  checklists: Checklist[];
  subtasks: TaskRef[];
  /** The task this one hangs off, when it is a subtask. */
  parent: TaskRef | null;
}

/**
 * What a TaskDetail adds on top of a Task.
 *
 * Valued `true` for nothing but the exhaustiveness: a new field on TaskDetail
 * fails to compile until somebody says which half of the app owns it.
 */
const DETAIL_ONLY: Record<Exclude<keyof TaskDetail, keyof Task>, true> = {
  description: true,
  creatorId: true,
  folderId: true,
  timeEstimate: true,
  timeSpent: true,
  points: true,
  dateClosed: true,
  comments: true,
  customFields: true,
  statuses: true,
  attachments: true,
  checklists: true,
  subtasks: true,
  parent: true,
};

/**
 * A live task row laid over a fetched detail, Task half only.
 *
 * The task collection is the source of truth for what the list also shows, so
 * the open panel takes its status and assignees from there rather than from the
 * snapshot it fetched. It is not the source of truth for the rest: the change
 * feed pushes whole details through the same collection, and `rowUpdateMode`
 * is `"full"`, so a row for an open task is carrying a copy of its conversation
 * from whenever the server last refreshed it. Spread naked, that copy wins over
 * the comment posted a second ago and the panel silently goes back in time.
 */
export function withLiveTask(detail: TaskDetail, live: Task): TaskDetail {
  return new Proxy(detail, {
    get(target, key, receiver) {
      if (typeof key !== "string" || key in DETAIL_ONLY) return Reflect.get(target, key, receiver);
      return Reflect.get(live, key);
    },
  });
}

/**
 * The Task half of a row, whatever shape it arrived in.
 *
 * The task collection holds Tasks, and the two writers must agree on what that
 * means. Rows from a list query carry the Task keys; the change feed's `task`
 * push carries a whole TaskDetail. Merged as-is, the push flips the row's key
 * set — thirteen detail keys appear — so no two writes of the same unchanged
 * task are ever deep-equal, and the collection's dedupe never applies. Every
 * change event rebuilds every visible row in the list, which is a blink on a
 * 30s clock while a task is open: the poll's push flips the row one way, the
 * next list frame flips it back.
 */
export function taskHalf(row: Task): Task {
  const half: Partial<TaskDetail> = { ...row };
  for (const key of Object.keys(DETAIL_ONLY) as (keyof TaskDetail)[]) delete half[key];
  return half as Task;
}

/** A task match from the palette's workspace-wide search. */
export interface SearchHit {
  id: string;
  customId: string | null;
  name: string;
  status: string | null;
  statusColor: string | null;
  statusType: string | null;
  listId: string;
  listName: string | null;
}

export interface Me {
  id: string;
  username: string | null;
  email: string | null;
  initials: string | null;
  color: string | null;
  avatar: string | null;
  teamId: string;
  /** ISO instant of the last inbox visit. Everything newer is unread. */
  inboxSeenAt: string;
}

/** A Doc in the tree: a name and somewhere to click. Contents come later. */
export interface DocRef {
  id: string;
  name: string;
}

export interface ListRef {
  id: string;
  name: string;
  /** Docs written inside this List. Usually empty; the node stays a leaf then. */
  docs: DocRef[];
}

export interface Space {
  id: string;
  name: string;
  folders: Array<{ id: string; name: string; lists: ListRef[]; docs: DocRef[] }>;
  lists: ListRef[];
  docs: DocRef[];
}

/**
 * The tree, plus the Docs that hang off the Workspace rather than any Space.
 *
 * ClickUp keeps those outside the tree too, and there are more of them than
 * every other kind put together — so they get their own section rather than
 * being dropped for want of a node.
 */
export interface Hierarchy {
  spaces: Space[];
  docs: DocRef[];
}

/**
 * One tab above a list.
 *
 * Deliberately not the whole ClickUp view. `GET /view/{id}/task` applies the
 * view's filters upstream, so the rules never reach the browser and there is
 * nothing here to evaluate — see the `list_views` table for the full argument.
 * `groupField` is ClickUp's own vocabulary and is mapped in `lib/clickup-views.ts`,
 * where the fallback for a field Rask cannot group by is visible.
 */
export interface ListView {
  id: string;
  listId: string;
  name: string;
  /** list, board, calendar, gantt, form, conversation, … Not an enum: ClickUp adds types. */
  type: string;
  /** The tab ClickUp opens the list on. */
  isDefault: boolean;
  groupField: string | null;
  /**
   * ClickUp's own "show closed tasks" for this view — a display setting, not a
   * filter. `GET /view/{id}/task` returns the closed rows either way, so this
   * only ever seeds Rask's toggle; see `applyView` in lib/clickup-views.ts.
   */
  showClosed: boolean;
  /** Forms only, and the only address at which one can be filled in. */
  publicUrl: string | null;
}

/**
 * One view, whatever it hangs off.
 *
 * `ListView` above is a tab in a List's tab bar, and a tab always has a List.
 * A view reached by its own address may not: ClickUp lets a view hang off a
 * Workspace, a Space or a Folder, and those draw rows from every list under
 * the container rather than one. Null listId is that case, and it is the only
 * difference between the two.
 */
export interface View extends Omit<ListView, "listId"> {
  listId: string | null;
}

/** What an id lifted out of a ClickUp URL turned out to be. */
export type ResolvedRef =
  | { kind: "task"; taskId: string; listId: string }
  | { kind: "view"; viewId: string; listId: string | null; name: string }
  | { kind: "list"; listId: string; name: string }
  | { kind: "folder"; folderId: string; name: string }
  | { kind: "space"; spaceId: string; name: string }
  | { kind: "doc"; docId: string; name: string }
  | { kind: "unknown" };

export interface TaskQuery {
  list?: string;
  space?: string;
  assignee?: string;
  status?: string;
  tag?: string;
  closed?: boolean;
  limit?: number;
  /**
   * The user's filter, already serialised by `lib/filters.ts`.
   *
   * Sent as a string rather than as clauses so this layer never has to know
   * that a date bucket has to be resolved against the browser's clock before it
   * crosses the wire.
   */
  filter?: string;
  /** Custom Field ids whose values the rows should carry, for the columns. */
  fields?: string[];
}

/** One Custom Field of a list that a filter can name, with its options. */
export interface FilterField {
  id: string;
  name: string;
  type: string;
  options: Array<{ value: string; label: string; color: string | null }>;
}

/** One Custom Field the column picker can offer, of any type. */
export interface DisplayField {
  id: string;
  name: string;
  type: string;
  /** ClickUp's own shape, verbatim — `formatFieldValue` reads it. */
  typeConfig: unknown;
  /** Whether this list already uses it. The server sorts these first. */
  usedHere: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A list response plus whether the server had more rows than it sent. */
export interface TaskPage {
  tasks: Task[];
  truncated: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData writes its own Content-Type, boundary included. Naming JSON here
  // would send a header the server cannot split the parts with.
  const form = init?.body instanceof FormData;
  const response = await fetch(path, {
    ...init,
    headers: { ...(form ? {} : { "Content-Type": "application/json" }), ...init?.headers },
  });

  if (response.status === 401) {
    // The session is gone. The shell swaps to the sign-in page; bouncing
    // straight to ClickUp left a refused sign-in with nowhere to land.
    markSignedOut();
    throw new ApiError(401, "unauthenticated");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? response.statusText);
  }

  return response.json() as Promise<T>;
}

/**
 * A list of tasks plus the header saying whether the server held more.
 *
 * Separate from `request` because the count is carried out of band: the body is
 * a bare array, and a wrapper object would mean every consumer unwrapping one.
 */
async function requestPage(path: string): Promise<TaskPage> {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" } });

  if (response.status === 401) {
    markSignedOut();
    throw new ApiError(401, "unauthenticated");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? response.statusText);
  }

  return {
    tasks: (await response.json()) as Task[],
    truncated: response.headers.get("X-Rask-Truncated") === "1",
  };
}

/**
 * One tracked interval, already normalised by the API.
 *
 * `running` is a field rather than something derived here: ClickUp signals a
 * live timer with a negative duration, and that rule is kept on the server so
 * exactly one place has to know it.
 */
export interface TimeEntry {
  id: string;
  taskId: string | null;
  taskName: string | null;
  user: Assignee | null;
  /** Epoch milliseconds. A live counter is `now - start`, never a stored total. */
  start: number | null;
  end: number | null;
  /** Null while running. */
  durationMs: number | null;
  running: boolean;
  description: string;
  billable: boolean;
}

/** A manual entry on its way in: the interval the person says already happened. */
export interface NewTimeEntry {
  start: number;
  durationMs: number;
  description?: string;
}

/** One task × one day of the timesheet week. Null where nothing was tracked. */
export interface TimesheetDay {
  durationMs: number;
  running: boolean;
}

/**
 * One row of the timesheet: every interval the week held against one task.
 *
 * Status and location are mirror data, not entry data — ClickUp's payload
 * carries neither, and the row reads poorly without them.
 */
export interface TimesheetRow {
  taskId: string;
  taskName: string;
  status: string | null;
  statusColor: string | null;
  statusType: string | null;
  location: string | null;
  /** Seven cells, Sunday first; null where the day has no tracking. */
  days: Array<TimesheetDay | null>;
  totalMs: number;
}

export const api = {
  me: () => request<Me>("/api/me"),

  /** Marks the inbox read up to the server's clock, and reports that instant. */
  markInboxSeen: () => request<{ inboxSeenAt: string }>("/api/inbox/seen", { method: "POST" }),

  /** The feed window: the tasks in it and, where there is one, what was said. */
  inbox: (since: number) => request<InboxPage>(`/api/inbox?since=${since}&limit=500`),

  /** Marks one entry read without touching the rest of the inbox. */
  markTaskRead: (taskId: string) =>
    request<InboxRead>("/api/inbox/read", {
      method: "POST",
      body: JSON.stringify({ taskId }),
    }),
  hierarchy: () => request<Hierarchy>("/api/hierarchy"),
  members: () => request<Assignee[]>("/api/members"),

  tasks(query: TaskQuery = {}): Promise<TaskPage> {
    const params = new URLSearchParams();
    if (query.list) params.set("list", query.list);
    if (query.space) params.set("space", query.space);
    if (query.assignee) params.set("assignee", query.assignee);
    if (query.status) params.set("status", query.status);
    if (query.tag) params.set("tag", query.tag);
    if (query.closed) params.set("closed", "1");
    if (query.limit) params.set("limit", String(query.limit));
    if (query.filter) params.set("filter", query.filter);
    if (query.fields?.length) params.set("fields", query.fields.join(","));

    return requestPage(`/api/tasks?${params}`);
  },

  /** The Custom Fields of a list that a filter can name. Read when the menu opens. */
  filterFields: (listId: string) => request<FilterField[]>(`/api/lists/${listId}/filter-fields`),

  /** Every Custom Field the column picker can offer for a list — all types. */
  displayFields: (listId: string) => request<DisplayField[]>(`/api/lists/${listId}/display-fields`),

  /** The tabs above a list, in ClickUp's own order. */
  views: (listId: string) => request<ListView[]>(`/api/lists/${listId}/views`),

  /**
   * The tasks one view shows.
   *
   * The view's filters are ClickUp's to evaluate, so the first open of a view
   * waits for ClickUp — the one read in the app that does. Every open after
   * that answers from the membership the server remembered and the fresh set
   * follows over the `view` SSE event, so this only fails against ClickUp when
   * the server has nothing remembered to answer with.
   */
  viewTasks: (viewId: string, filter = "", fields: string[] = []) => {
    const params = new URLSearchParams();
    if (filter) params.set("filter", filter);
    if (fields.length) params.set("fields", fields.join(","));
    const query = params.toString();
    return requestPage(`/api/views/${viewId}/tasks${query ? `?${query}` : ""}`);
  },

  /**
   * One view by id, for a view opened at its own address.
   *
   * `views(listId)` above answers the tab bar, which needs a List to ask about.
   * This one takes the view id straight out of the URL, which is all a
   * Workspace-level view ever comes with.
   */
  view: (viewId: string) => request<View>(`/api/views/${viewId}`),

  task: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),

  /**
   * Uploads one file to a task and answers with the refreshed detail.
   *
   * Not optimistic, unlike every other write: the file has to reach ClickUp
   * before it has a URL, and a placeholder attachment nobody can open is worse
   * than a second of waiting.
   */
  uploadAttachment(taskId: string, file: File): Promise<AttachmentUpload> {
    const form = new FormData();
    form.append(UPLOAD_FIELD, file, file.name);
    return request<AttachmentUpload>(`/api/tasks/${taskId}/attachments`, {
      method: "POST",
      body: form,
    });
  },

  search: (query: string) => request<SearchHit[]>(`/api/search?q=${encodeURIComponent(query)}`),

  /**
   * Candidates go most-specific first; the server answers with the first hit.
   *
   * `remote` is what the URL's own routing words said the id is, and it is the
   * server's permission to spend one ClickUp request when the mirror misses.
   * Null means the shape never said, so a miss is the answer.
   */
  resolve(ids: string[], remote: RemoteLookup): Promise<ResolvedRef> {
    const params = new URLSearchParams({ ids: ids.join(",") });
    if (remote) params.set("remote", remote);
    return request<ResolvedRef>(`/api/resolve?${params}`);
  },

  statuses: (listId: string) => request<StatusDef[]>(`/api/lists/${listId}/statuses`),

  patchTask: (id: string, patch: Record<string, unknown>) =>
    request<TaskDetail>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  createTask: (input: Record<string, unknown>) =>
    request<TaskDetail>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),

  /**
   * What a `tmp_` placeholder turned into once the outbox shipped its create.
   *
   * `id` is the real ClickUp id, `pending` means the create is still queued.
   * Both null/false for a create that was rejected or never existed.
   */
  resolveCreated: (taskId: string) =>
    request<{ id: string | null; pending: boolean }>(`/api/tasks/${taskId}/resolved`),

  /**
   * Deletes a task, and its subtasks with it.
   *
   * Answers with a flag rather than the detail every other write returns: there
   * is no task left to describe. Subtasks go too, because ClickUp takes them.
   */
  deleteTask: (id: string) => request<{ deleted: true }>(`/api/tasks/${id}`, { method: "DELETE" }),

  /**
   * Every comment write answers with the whole task detail, because the task
   * collection carries no comments and there is nothing to patch into.
   */
  comment: (taskId: string, input: { text: string; parentId?: string; clientId: string }) =>
    request<TaskDetail>(`/api/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  patchComment: (commentId: string, patch: { text?: string; resolved?: boolean }) =>
    request<TaskDetail>(`/api/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteComment: (commentId: string) =>
    request<TaskDetail>(`/api/comments/${commentId}`, { method: "DELETE" }),

  setTags: (taskId: string, tags: string[]) =>
    request<TaskDetail>(`/api/tasks/${taskId}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    }),

  spaceTags: (spaceId: string) => request<Tag[]>(`/api/spaces/${spaceId}/tags`),

  /**
   * Checklist writes answer with the whole task detail, like comment writes and
   * for the same reason: the task collection carries no checklists.
   */
  createChecklist: (taskId: string, input: { name: string; clientId: string }) =>
    request<TaskDetail>(`/api/tasks/${taskId}/checklists`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  renameChecklist: (checklistId: string, name: string) =>
    request<TaskDetail>(`/api/checklists/${checklistId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  deleteChecklist: (checklistId: string) =>
    request<TaskDetail>(`/api/checklists/${checklistId}`, { method: "DELETE" }),

  createChecklistItem: (checklistId: string, input: { name: string; clientId: string }) =>
    request<TaskDetail>(`/api/checklists/${checklistId}/items`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  patchChecklistItem: (itemId: string, patch: { name?: string; resolved?: boolean }) =>
    request<TaskDetail>(`/api/checklist-items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteChecklistItem: (itemId: string) =>
    request<TaskDetail>(`/api/checklist-items/${itemId}`, { method: "DELETE" }),

  setField: (taskId: string, fieldId: string, write: FieldWrite) =>
    request<{ ok: true }>(`/api/tasks/${taskId}/fields/${fieldId}`, {
      method: "PUT",
      // `mirror` spelled out rather than left off: the two differ only for a
      // People field, and the server storing `undefined` would mean guessing.
      body: JSON.stringify({
        value: write.value,
        mirror: write.mirror === undefined ? write.value : write.mirror,
      }),
    }),

  resync: (listId: string) =>
    request<{ ok: true }>(`/api/lists/${listId}/resync`, { method: "POST" }),

  /**
   * Time tracking, which does not come from the mirror.
   *
   * These are the only calls in the app that wait on ClickUp for a write. The
   * running timer is one row per person that changes only when they act, so it
   * is read live rather than mirrored; see `apps/api/src/time.ts`.
   */
  runningTimer: () => request<{ entry: TimeEntry | null }>("/api/timer"),

  startTimer: (taskId: string) =>
    request<{ started: TimeEntry; stopped: TimeEntry | null }>("/api/timer", {
      method: "POST",
      body: JSON.stringify({ taskId }),
    }),

  stopTimer: () => request<{ stopped: TimeEntry | null }>("/api/timer", { method: "DELETE" }),

  timeEntries: (taskId: string) =>
    request<{ entries: TimeEntry[] }>(`/api/tasks/${taskId}/time-entries`),

  /**
   * The Docs written inside a task, contents and all.
   *
   * Live from ClickUp like the entries above, and for the same reason: nothing
   * in Rask filters or sorts by a Doc, so mirroring one would be upkeep with no
   * reader. Costs a request per Doc, so the panel only asks when expanded.
   */
  taskDocs: (taskId: string) => request<{ docs: Doc[] }>(`/api/tasks/${taskId}/docs`),

  /**
   * One Doc, contents included.
   *
   * The name and the parent come from the mirrored index; only the pages are
   * read live. Costs one ClickUp request no matter how many pages the Doc has.
   */
  doc: (docId: string) => request<{ doc: Doc }>(`/api/docs/${docId}`),

  /**
   * Adds a block to the end of a page.
   *
   * Append and never replace, which is the route's name rather than an argument
   * here: a request that carries only the new block cannot overwrite what
   * somebody else wrote in ClickUp's editor while this page was open, and there
   * is no webhook for a Doc that would let us notice if it did.
   *
   * Answers nothing worth reading. The caller refetches the Doc, which is the
   * only way to see what ClickUp actually stored.
   */
  appendDocPage: (docId: string, pageId: string, content: string) =>
    request<{ ok: true }>(`/api/docs/${docId}/pages/${pageId}/append`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  /**
   * A new, empty page in a Doc.
   *
   * `parentId` is the page it hangs off — the reader sends the page whose "+"
   * was pressed, so the new one lands inside it. Omitted puts it at the Doc's
   * root, which is what the header button sends.
   *
   * Worth knowing before changing this: `parent_page_id` is write-once. v3 has
   * no move endpoint and no delete endpoint, so a page filed in the wrong place
   * cannot be put right from Rask at all.
   *
   * Answers the new page's id and nothing else, because a page has no place in
   * the Doc's shape until the Doc is read again. The caller refetches and then
   * has something to select.
   */
  createDocPage: (docId: string, input: { name: string; parentId?: string }) =>
    request<{ id: string }>(`/api/docs/${docId}/pages`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  createTimeEntry: (taskId: string, entry: NewTimeEntry) =>
    request<{ entry: TimeEntry }>(`/api/tasks/${taskId}/time-entries`, {
      method: "POST",
      body: JSON.stringify(entry),
    }),

  patchTimeEntry: (
    entryId: string,
    patch: { description?: string; billable?: boolean; span?: { start: number; end: number } },
  ) =>
    request<{ entry: TimeEntry }>(`/api/time-entries/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /** `taskId` only tells the server which task to re-read; the delete does not need it. */
  deleteTimeEntry: (entryId: string, taskId: string) =>
    request<{ ok: true }>(`/api/time-entries/${entryId}?taskId=${encodeURIComponent(taskId)}`, {
      method: "DELETE",
    }),

  /**
   * The week grid: this person's entries, grouped by task and local day.
   *
   * `tz` is the browser's own `-getTimezoneOffset()` in minutes — Sunday
   * boundary arithmetic is the server's job, but whose Sunday is the
   * browser's to say. `weekAnchor` is any instant inside the wanted week;
   * today seeds it for the current one.
   */
  timesheet: (weekAnchor: number) =>
    request<{
      start: number;
      end: number;
      now: number;
      rows: TimesheetRow[];
    }>(
      `/api/timesheet/week?tz=${encodeURIComponent(String(-new Date().getTimezoneOffset()))}` +
        `&start=${encodeURIComponent(String(weekAnchor))}`,
    ),
};
