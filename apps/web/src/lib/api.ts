import { UPLOAD_FIELD } from "@rask/clickup-client/vocabulary";
import type { RemoteLookup } from "./clickup-url.ts";
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
  return { ...detail, ...taskHalf(live) };
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
