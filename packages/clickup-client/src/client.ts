import { z } from "zod";
import { RateLimiter } from "./rate-limit.ts";
import {
  accessTokenResponse,
  type ClickUpComment,
  type ClickUpCustomField,
  type ClickUpFolder,
  type ClickUpList,
  type ClickUpSpace,
  type ClickUpTask,
  type ClickUpTeam,
  type ClickUpUser,
  type ClickUpWebhook,
  clickUpComment,
  clickUpCustomField,
  clickUpFolder,
  clickUpList,
  clickUpSpace,
  clickUpTask,
  clickUpTeam,
  clickUpUser,
  clickUpWebhook,
  createdComment,
  taskPage,
  threadedCommentCreated,
} from "./schemas.ts";

export const CLICKUP_API_BASE = "https://api.clickup.com/api";

export class ClickUpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** True for 429 and 5xx: the same request may succeed later. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ClickUpError";
  }
}

export interface ClickUpClientOptions {
  token: string;
  /**
   * Personal keys go in the header raw (`pk_...`); OAuth access tokens need the
   * `Bearer ` prefix. Getting this backwards returns a bare 401 with no hint.
   */
  auth?: "oauth" | "personal";
  /** Share one limiter per token, never per client instance. */
  limiter?: RateLimiter;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  /** Attempts after a retryable failure. Each waits 2^n seconds, jittered. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

type QueryValue = string | number | boolean | undefined | null | Array<string | number>;
type Query = Record<string, QueryValue>;

export interface ListTasksParams {
  page?: number;
  archived?: boolean;
  includeClosed?: boolean;
  subtasks?: boolean;
  statuses?: string[];
  assignees?: Array<string | number>;
  tags?: string[];
  /** Epoch ms. The whole basis of incremental polling. */
  dateUpdatedGt?: number;
  orderBy?: "id" | "created" | "updated" | "due_date";
  reverse?: boolean;
}

export interface TeamTasksParams extends ListTasksParams {
  listIds?: string[];
  spaceIds?: string[];
}

export interface TaskPatch {
  name?: string;
  description?: string;
  markdown_content?: string;
  status?: string;
  priority?: number | null;
  due_date?: number | null;
  due_date_time?: boolean;
  start_date?: number | null;
  time_estimate?: number | null;
  archived?: boolean;
  assignees?: { add?: number[]; rem?: number[] };
}

export interface NewTask {
  name: string;
  description?: string;
  markdown_content?: string;
  status?: string;
  assignees?: number[];
  priority?: number | null;
  due_date?: number | null;
  tags?: string[];
  parent?: string;
}

export class ClickUpClient {
  readonly limiter: RateLimiter;

  private readonly token: string;
  private readonly auth: "oauth" | "personal";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClickUpClientOptions) {
    this.token = options.token;
    this.auth = options.auth ?? (options.token.startsWith("pk_") ? "personal" : "oauth");
    this.baseUrl = options.baseUrl ?? CLICKUP_API_BASE;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.limiter = options.limiter ?? new RateLimiter();
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // --- HTTP ---------------------------------------------------------------

  private url(path: string, query?: Query): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      // ClickUp expects repeated `key[]=` for every array param. See the
      // parameter descriptions in openapi/clickup-v2.json.
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T extends z.ZodType>(
    schema: T,
    method: string,
    path: string,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<z.infer<T>> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = {
      Authorization: this.auth === "oauth" ? `Bearer ${this.token}` : this.token,
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let lastError: ClickUpError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.acquire();

      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      this.limiter.syncFromHeaders(response.headers);

      if (response.ok) {
        const json = await response.json();
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          throw new ClickUpError(
            response.status,
            `Unexpected ${method} ${path} response: ${z.prettifyError(parsed.error)}`,
          );
        }
        return parsed.data;
      }

      lastError = await toError(response, method, path);

      if (!lastError.retryable || attempt === this.maxRetries) break;

      if (response.status === 429) {
        // The limiter already knows how long to hold everything back; acquire()
        // on the next pass will block for us. No extra sleep needed.
        this.limiter.blockUntilReset(response.headers.get("x-ratelimit-reset"));
      } else {
        await this.sleep(backoffMs(attempt));
      }
    }

    throw lastError ?? new ClickUpError(0, `${method} ${path} failed`);
  }

  // --- Auth ---------------------------------------------------------------

  /** Exchanges an OAuth redirect `code` for an access token. No auth header. */
  static async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
  }): Promise<string> {
    const doFetch = input.fetch ?? globalThis.fetch;
    const response = await doFetch(`${input.baseUrl ?? CLICKUP_API_BASE}/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
      }),
    });
    if (!response.ok) throw await toError(response, "POST", "/v2/oauth/token");
    return accessTokenResponse.parse(await response.json()).access_token;
  }

  getAuthorizedUser(): Promise<ClickUpUser> {
    return this.request(z.looseObject({ user: clickUpUser }), "GET", "/v2/user").then(
      (r) => r.user,
    );
  }

  getAuthorizedTeams(): Promise<ClickUpTeam[]> {
    return this.request(z.looseObject({ teams: z.array(clickUpTeam) }), "GET", "/v2/team").then(
      (r) => r.teams,
    );
  }

  // --- Hierarchy ----------------------------------------------------------

  getSpaces(teamId: string): Promise<ClickUpSpace[]> {
    return this.request(
      z.looseObject({ spaces: z.array(clickUpSpace) }),
      "GET",
      `/v2/team/${teamId}/space`,
      { query: { archived: false } },
    ).then((r) => r.spaces);
  }

  getFolders(spaceId: string): Promise<ClickUpFolder[]> {
    return this.request(
      z.looseObject({ folders: z.array(clickUpFolder) }),
      "GET",
      `/v2/space/${spaceId}/folder`,
      { query: { archived: false } },
    ).then((r) => r.folders);
  }

  /** Lists that live directly under a Space, with no Folder in between. */
  getFolderlessLists(spaceId: string): Promise<ClickUpList[]> {
    return this.request(
      z.looseObject({ lists: z.array(clickUpList) }),
      "GET",
      `/v2/space/${spaceId}/list`,
      { query: { archived: false } },
    ).then((r) => r.lists);
  }

  /**
   * Spaces, their folders, and every list, in one call tree.
   *
   * Costs 1 + 2n requests for n spaces (folders come with their lists inlined,
   * folderless lists need their own call). At 100 req/min that is fine for a
   * workspace with fewer than ~45 spaces; past that it needs to be chunked.
   */
  async getWorkspaceHierarchy(
    teamId: string,
  ): Promise<Array<{ space: ClickUpSpace; folders: ClickUpFolder[]; lists: ClickUpList[] }>> {
    const spaces = await this.getSpaces(teamId);
    return Promise.all(
      spaces.map(async (space) => {
        const [folders, lists] = await Promise.all([
          this.getFolders(space.id),
          this.getFolderlessLists(space.id),
        ]);
        return { space, folders, lists };
      }),
    );
  }

  getListCustomFields(listId: string): Promise<ClickUpCustomField[]> {
    return this.request(
      z.looseObject({ fields: z.array(clickUpCustomField) }),
      "GET",
      `/v2/list/${listId}/field`,
    ).then((r) => r.fields);
  }

  // --- Tasks --------------------------------------------------------------

  getTask(taskId: string): Promise<ClickUpTask> {
    return this.request(clickUpTask, "GET", `/v2/task/${taskId}`, {
      query: { include_markdown_description: true, include_subtasks: false },
    });
  }

  /** One page of a list's tasks. `page` is zero-based; ~100 tasks per page. */
  getListTasks(
    listId: string,
    params: ListTasksParams = {},
  ): Promise<{ tasks: ClickUpTask[]; lastPage: boolean }> {
    return this.request(taskPage, "GET", `/v2/list/${listId}/task`, {
      query: {
        ...taskQuery(params),
        // Rask renders markdown, so always ask for the markdown body.
        include_markdown_description: true,
      },
    }).then((r) => ({ tasks: r.tasks, lastPage: r.last_page ?? r.tasks.length === 0 }));
  }

  /** Walks every page of a list. Stops on the first page ClickUp flags as last. */
  async *iterateListTasks(
    listId: string,
    params: ListTasksParams = {},
  ): AsyncGenerator<ClickUpTask[]> {
    for (let page = params.page ?? 0; ; page++) {
      const { tasks, lastPage } = await this.getListTasks(listId, { ...params, page });
      if (tasks.length > 0) yield tasks;
      if (lastPage || tasks.length === 0) return;
    }
  }

  /** Cross-list task query. This is what backs My Tasks. */
  getTeamTasks(
    teamId: string,
    params: TeamTasksParams = {},
  ): Promise<{ tasks: ClickUpTask[]; lastPage: boolean }> {
    return this.request(taskPage, "GET", `/v2/team/${teamId}/task`, {
      query: {
        ...taskQuery(params),
        list_ids: params.listIds,
        space_ids: params.spaceIds,
        include_markdown_description: true,
      },
    }).then((r) => ({ tasks: r.tasks, lastPage: r.last_page ?? r.tasks.length === 0 }));
  }

  createTask(listId: string, input: NewTask): Promise<ClickUpTask> {
    return this.request(clickUpTask, "POST", `/v2/list/${listId}/task`, { body: input });
  }

  updateTask(taskId: string, patch: TaskPatch): Promise<ClickUpTask> {
    return this.request(clickUpTask, "PUT", `/v2/task/${taskId}`, { body: patch });
  }

  /** Custom Field values have their own endpoint; `updateTask` ignores them. */
  async setCustomFieldValue(taskId: string, fieldId: string, value: unknown): Promise<void> {
    await this.request(z.unknown(), "POST", `/v2/task/${taskId}/field/${fieldId}`, {
      body: { value },
    });
  }

  // --- Comments -----------------------------------------------------------

  /** Newest first, 25 per page. `start`/`start_id` come from the oldest one you got. */
  getComments(
    taskId: string,
    cursor?: { start: number; startId: string },
  ): Promise<ClickUpComment[]> {
    return this.request(
      z.looseObject({ comments: z.array(clickUpComment) }),
      "GET",
      `/v2/task/${taskId}/comment`,
      { query: { start: cursor?.start, start_id: cursor?.startId } },
    ).then((r) => r.comments);
  }

  /**
   * Every comment on a task, oldest page last.
   *
   * ClickUp pages this endpoint with `start` (the `date` of the oldest comment
   * you already have) and `start_id` (its id) rather than a page number, so it
   * cannot be walked in parallel. `maxPages` is the caller's budget: a task
   * with a thousand comments is not worth forty requests to mirror in full.
   */
  async *iterateComments(
    taskId: string,
    options: { maxPages?: number } = {},
  ): AsyncGenerator<ClickUpComment[]> {
    const maxPages = options.maxPages ?? 4;
    let cursor: { start: number; startId: string } | undefined;

    for (let page = 0; page < maxPages; page++) {
      const batch = await this.getComments(taskId, cursor);
      if (batch.length === 0) return;
      yield batch;

      // Comments come back newest first, so the cursor is the last element.
      const oldest = batch[batch.length - 1];
      if (!oldest?.date) return;
      cursor = { start: oldest.date.getTime(), startId: oldest.id };
    }
  }

  /** The replies under one comment. Not paginated: ClickUp returns the thread. */
  getThreadedComments(commentId: string): Promise<ClickUpComment[]> {
    return this.request(
      z.looseObject({ comments: z.array(clickUpComment) }),
      "GET",
      `/v2/comment/${commentId}/reply`,
    ).then((r) => r.comments);
  }

  createComment(
    taskId: string,
    input: { text: string; assignee?: number; notifyAll?: boolean },
  ): Promise<{ id: string }> {
    return this.request(createdComment, "POST", `/v2/task/${taskId}/comment`, {
      body: {
        comment_text: input.text,
        assignee: input.assignee,
        notify_all: input.notifyAll ?? false,
      },
    });
  }

  /**
   * Replies to a comment. Same body as a task comment.
   *
   * The spec documents an empty object as the response where the task-comment
   * version returns an id, so the id is optional here and callers refetch the
   * thread instead of trusting it.
   */
  createThreadedComment(
    commentId: string,
    input: { text: string; assignee?: number; notifyAll?: boolean },
  ): Promise<{ id?: string }> {
    return this.request(threadedCommentCreated, "POST", `/v2/comment/${commentId}/reply`, {
      body: {
        comment_text: input.text,
        assignee: input.assignee,
        notify_all: input.notifyAll ?? false,
      },
    });
  }

  /**
   * Edits a comment. Also how a comment is resolved or assigned.
   *
   * ClickUp treats `comment_text` and `resolved` as required, so a caller that
   * only wants to resolve still has to send the body back unchanged. Sending a
   * partial body silently blanks the comment.
   */
  async updateComment(
    commentId: string,
    input: { text: string; resolved: boolean; assignee?: number },
  ): Promise<void> {
    await this.request(z.unknown(), "PUT", `/v2/comment/${commentId}`, {
      body: {
        comment_text: input.text,
        resolved: input.resolved,
        assignee: input.assignee,
      },
    });
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.request(z.unknown(), "DELETE", `/v2/comment/${commentId}`);
  }

  // --- Webhooks -----------------------------------------------------------

  createWebhook(
    teamId: string,
    input: { endpoint: string; events: string[]; spaceId?: string; listId?: string },
  ): Promise<ClickUpWebhook> {
    return this.request(
      z.looseObject({ id: z.string(), webhook: clickUpWebhook.optional() }),
      "POST",
      `/v2/team/${teamId}/webhook`,
      {
        body: {
          endpoint: input.endpoint,
          events: input.events,
          space_id: input.spaceId ? Number(input.spaceId) : undefined,
          list_id: input.listId ? Number(input.listId) : undefined,
        },
      },
    ).then((r) => r.webhook ?? clickUpWebhook.parse({ id: r.id }));
  }
}

// --- helpers --------------------------------------------------------------

function taskQuery(params: ListTasksParams): Query {
  return {
    page: params.page,
    archived: params.archived,
    include_closed: params.includeClosed ?? true,
    subtasks: params.subtasks,
    statuses: params.statuses,
    assignees: params.assignees,
    tags: params.tags,
    date_updated_gt: params.dateUpdatedGt,
    order_by: params.orderBy,
    reverse: params.reverse,
  };
}

/** Full jitter, capped at 30s. Keeps a fleet of workers from retrying in lockstep. */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(30_000, 1000 * 2 ** attempt);
}

async function toError(response: Response, method: string, path: string): Promise<ClickUpError> {
  const body = await response.text().catch(() => "");
  let message = body.slice(0, 300);
  let code: string | undefined;
  try {
    const json = JSON.parse(body) as { err?: string; ECODE?: string };
    if (json.err) message = json.err;
    code = json.ECODE;
  } catch {
    // Non-JSON error body (Cloudflare pages, HTML 502s). Keep the raw text.
  }
  return new ClickUpError(
    response.status,
    `${method} ${path} -> ${response.status} ${message}`,
    code,
    response.status === 429 || response.status >= 500,
  );
}
