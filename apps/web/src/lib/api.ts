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
  assignees: Assignee[];
}

export interface TaskDetail extends Task {
  description: string | null;
  creatorId: string | null;
  folderId: string | null;
  timeEstimate: number | null;
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
}

export interface Space {
  id: string;
  name: string;
  folders: Array<{ id: string; name: string; lists: Array<{ id: string; name: string }> }>;
  lists: Array<{ id: string; name: string }>;
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
  /** Whether the rows ClickUp returns for this view already include closed ones. */
  showClosed: boolean;
  /** Forms only, and the only address at which one can be filled in. */
  publicUrl: string | null;
}

/** What an id lifted out of a ClickUp URL turned out to be. */
export type ResolvedRef =
  | { kind: "task"; taskId: string; listId: string }
  | { kind: "view"; viewId: string; listId: string; name: string }
  | { kind: "list"; listId: string; name: string }
  | { kind: "folder"; folderId: string; name: string }
  | { kind: "space"; spaceId: string; name: string }
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
}

/** One Custom Field of a list that a filter can name, with its options. */
export interface FilterField {
  id: string;
  name: string;
  type: string;
  options: Array<{ value: string; label: string; color: string | null }>;
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
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (response.status === 401) {
    // The session is gone. Bounce to ClickUp rather than showing an empty app.
    window.location.href = "/auth/clickup";
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
    window.location.href = "/auth/clickup";
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

export const api = {
  me: () => request<Me>("/api/me"),
  hierarchy: () => request<Space[]>("/api/hierarchy"),
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

    return requestPage(`/api/tasks?${params}`);
  },

  /** The Custom Fields of a list that a filter can name. Read when the menu opens. */
  filterFields: (listId: string) => request<FilterField[]>(`/api/lists/${listId}/filter-fields`),

  /** The tabs above a list, in ClickUp's own order. */
  views: (listId: string) => request<ListView[]>(`/api/lists/${listId}/views`),

  /**
   * The tasks one view shows.
   *
   * The server asks ClickUp, because the view's filters are ClickUp's to
   * evaluate. That makes this the one read in the app that is not answered from
   * the mirror alone, and the one that fails when ClickUp is unreachable.
   */
  viewTasks: (viewId: string, filter = "") =>
    requestPage(
      `/api/views/${viewId}/tasks${filter ? `?filter=${encodeURIComponent(filter)}` : ""}`,
    ),

  task: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),

  search: (query: string) => request<SearchHit[]>(`/api/search?q=${encodeURIComponent(query)}`),

  /** Candidates go most-specific first; the server answers with the first hit. */
  resolve(ids: string[], remote: boolean): Promise<ResolvedRef> {
    const params = new URLSearchParams({ ids: ids.join(",") });
    if (remote) params.set("remote", "1");
    return request<ResolvedRef>(`/api/resolve?${params}`);
  },

  statuses: (listId: string) => request<StatusDef[]>(`/api/lists/${listId}/statuses`),

  patchTask: (id: string, patch: Record<string, unknown>) =>
    request<TaskDetail>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  createTask: (input: Record<string, unknown>) =>
    request<TaskDetail>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),

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

  setField: (taskId: string, fieldId: string, value: unknown) =>
    request<{ ok: true }>(`/api/tasks/${taskId}/fields/${fieldId}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),

  resync: (listId: string) =>
    request<{ ok: true }>(`/api/lists/${listId}/resync`, { method: "POST" }),
};
