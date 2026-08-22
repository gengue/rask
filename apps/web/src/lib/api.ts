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
  text: string | null;
  date: string | null;
  resolved: boolean;
  replyCount: number;
  userId: string | null;
  username: string | null;
  initials: string | null;
  color: string | null;
  avatar: string | null;
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
  comments: Comment[];
  customFields: CustomField[];
  statuses: StatusDef[];
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

  tasks(query: TaskQuery = {}): Promise<Task[]> {
    const params = new URLSearchParams();
    if (query.list) params.set("list", query.list);
    if (query.space) params.set("space", query.space);
    if (query.assignee) params.set("assignee", query.assignee);
    if (query.status) params.set("status", query.status);
    if (query.tag) params.set("tag", query.tag);
    if (query.closed) params.set("closed", "1");
    if (query.limit) params.set("limit", String(query.limit));
    return request<Task[]>(`/api/tasks?${params}`);
  },

  task: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),

  statuses: (listId: string) => request<StatusDef[]>(`/api/lists/${listId}/statuses`),

  patchTask: (id: string, patch: Record<string, unknown>) =>
    request<TaskDetail>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  createTask: (input: Record<string, unknown>) =>
    request<TaskDetail>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),

  comment: (taskId: string, text: string) =>
    request<{ ok: true }>(`/api/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  setField: (taskId: string, fieldId: string, value: unknown) =>
    request<{ ok: true }>(`/api/tasks/${taskId}/fields/${fieldId}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),

  resync: (listId: string) =>
    request<{ ok: true }>(`/api/lists/${listId}/resync`, { method: "POST" }),
};
