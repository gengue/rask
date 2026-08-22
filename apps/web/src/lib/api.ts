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
}

export interface Comment {
  id: string;
  parentCommentId: string | null;
  text: string | null;
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

/** What an id lifted out of a ClickUp URL turned out to be. */
export type ResolvedRef =
  | { kind: "task"; taskId: string; listId: string }
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

export const api = {
  me: () => request<Me>("/api/me"),
  hierarchy: () => request<Space[]>("/api/hierarchy"),
  members: () => request<Assignee[]>("/api/members"),

  async tasks(query: TaskQuery = {}): Promise<TaskPage> {
    const params = new URLSearchParams();
    if (query.list) params.set("list", query.list);
    if (query.space) params.set("space", query.space);
    if (query.assignee) params.set("assignee", query.assignee);
    if (query.status) params.set("status", query.status);
    if (query.tag) params.set("tag", query.tag);
    if (query.closed) params.set("closed", "1");
    if (query.limit) params.set("limit", String(query.limit));

    const response = await fetch(`/api/tasks?${params}`, {
      headers: { "Content-Type": "application/json" },
    });
    if (response.status === 401) {
      window.location.href = "/auth/clickup";
      throw new ApiError(401, "unauthenticated");
    }
    if (!response.ok) throw new ApiError(response.status, response.statusText);

    return {
      tasks: (await response.json()) as Task[],
      truncated: response.headers.get("X-Rask-Truncated") === "1",
    };
  },

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

  setField: (taskId: string, fieldId: string, value: unknown) =>
    request<{ ok: true }>(`/api/tasks/${taskId}/fields/${fieldId}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),

  resync: (listId: string) =>
    request<{ ok: true }>(`/api/lists/${listId}/resync`, { method: "POST" }),
};
