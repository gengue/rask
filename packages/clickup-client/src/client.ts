import { z } from "zod";
import { type CommentSegment, toCommentSegments } from "./mentions.ts";
import { RateLimiter } from "./rate-limit.ts";
import {
  accessTokenResponse,
  type ClickUpChecklist,
  type ClickUpComment,
  type ClickUpCustomField,
  type ClickUpFolder,
  type ClickUpList,
  type ClickUpSpace,
  type ClickUpTag,
  type ClickUpTask,
  type ClickUpTeam,
  type ClickUpUser,
  type ClickUpView,
  type ClickUpWebhook,
  checklistResponse,
  clickUpComment,
  clickUpCustomField,
  clickUpFolder,
  clickUpList,
  clickUpSpace,
  clickUpTag,
  clickUpTask,
  clickUpTeam,
  clickUpUser,
  clickUpWebhook,
  createdComment,
  listViewsResponse,
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
  /**
   * Makes the new task a subtask of this one.
   *
   * The spec is explicit that the parent has to live in the List named in the
   * path, and that it may itself be a subtask. Passing a parent from another
   * list is a 400, not a move.
   */
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

  // --- Views --------------------------------------------------------------

  /**
   * Every view on a List, by orderindex.
   *
   * ClickUp splits the answer into `views` (saved) and `required_views` (the
   * built-in List and Board, plus a null for every built-in the List does not
   * have). Both share one `orderindex` sequence, so they are merged and sorted
   * here rather than by every caller. `default_view` names the tab ClickUp
   * opens the List on; it is a differently shaped copy of a row already in the
   * merged list, so only its id comes back.
   *
   * Orderindex is not the order ClickUp's own tab bar uses — the chat view and
   * the default view are lifted to the front of it. That belongs to whatever
   * draws tabs, and it lives in the API's read model. What this owes its caller
   * is one deterministic list.
   *
   * The same shape exists at `/space/{id}/view`, `/folder/{id}/view` and
   * `/team/{id}/view`. Lists are what Rask navigates, so only that one is here.
   */
  getListViews(listId: string): Promise<{ views: ClickUpView[]; defaultViewId: string | null }> {
    return this.request(listViewsResponse, "GET", `/v2/list/${listId}/view`).then((r) => {
      const merged = new Map<string, ClickUpView>();
      for (const view of [...Object.values(r.required_views), ...r.views]) {
        if (view) merged.set(view.id, view);
      }
      return {
        views: [...merged.values()].sort(byOrderindex),
        defaultViewId: r.default_view?.id ?? null,
      };
    });
  }

  /**
   * One page of the tasks a view shows, with the view's own filters already
   * applied by ClickUp.
   *
   * This is the reason views are worth mirroring at all: reimplementing
   * `{field:"tag", op:"NOT ANY", values:[...]}` against the local mirror would
   * be rebuilding ClickUp's filter engine, and it would be wrong the first time
   * somebody used an operator we had not met.
   *
   * The payload is thinner than `GET /list/{id}/task`: no `description`, no
   * `text_content`, and `include_markdown_description` is ignored. Treat it as
   * "which tasks", not as a fresh copy of them.
   */
  getViewTasks(
    viewId: string,
    params: { page?: number } = {},
  ): Promise<{ tasks: ClickUpTask[]; lastPage: boolean }> {
    return this.request(taskPage, "GET", `/v2/view/${viewId}/task`, {
      // `page` is required on this endpoint, unlike the list one.
      query: { page: params.page ?? 0 },
    }).then((r) => ({
      tasks: r.tasks.map(withoutListPageLies),
      lastPage: r.last_page ?? r.tasks.length === 0,
    }));
  }

  /** Walks every page of a view. Stops on the first page ClickUp flags as last. */
  async *iterateViewTasks(viewId: string): AsyncGenerator<ClickUpTask[]> {
    for (let page = 0; ; page++) {
      const { tasks, lastPage } = await this.getViewTasks(viewId, { page });
      if (tasks.length > 0) yield tasks;
      if (lastPage || tasks.length === 0) return;
    }
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
    }).then((r) => ({
      tasks: r.tasks.map(withoutListPageLies),
      lastPage: r.last_page ?? r.tasks.length === 0,
    }));
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

  // --- Tags ---------------------------------------------------------------

  /** Every tag defined on a Space. Tags are per-Space, not per-workspace. */
  getSpaceTags(spaceId: string): Promise<ClickUpTag[]> {
    return this.request(
      z.looseObject({ tags: z.array(clickUpTag) }),
      "GET",
      `/v2/space/${spaceId}/tag`,
    ).then((r) => r.tags);
  }

  /**
   * Tags are added and removed one at a time, by name, and the endpoints have
   * no body. There is no "set the tags to this list" call, so the caller has to
   * work out the difference itself.
   */
  async addTag(taskId: string, tagName: string): Promise<void> {
    await this.request(
      z.unknown(),
      "POST",
      `/v2/task/${taskId}/tag/${encodeURIComponent(tagName)}`,
    );
  }

  async removeTag(taskId: string, tagName: string): Promise<void> {
    await this.request(
      z.unknown(),
      "DELETE",
      `/v2/task/${taskId}/tag/${encodeURIComponent(tagName)}`,
    );
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
        ...commentBody(input.text),
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
        ...commentBody(input.text),
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
    input: {
      text: string;
      resolved: boolean;
      assignee?: number;
      /**
       * ClickUp's own body, to send back untouched.
       *
       * PUT replaces the comment, and `text` is only its flattening, so a
       * comment holding a screenshot or a table loses it unless the original
       * segments go back instead. Pass these whenever the body is not the thing
       * being changed.
       */
      segments?: CommentSegment[] | null;
    },
  ): Promise<void> {
    const body = input.segments?.length ? { comment: input.segments } : commentBody(input.text);

    await this.request(z.unknown(), "PUT", `/v2/comment/${commentId}`, {
      body: { ...body, resolved: input.resolved, assignee: input.assignee },
    });
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.request(z.unknown(), "DELETE", `/v2/comment/${commentId}`);
  }

  // --- Checklists ---------------------------------------------------------

  /*
   * Checklists only ever arrive on `GET /task/{id}`, never on a list page, and
   * every write below answers with the whole checklist rather than the row it
   * touched. That is what lets the caller ingest the response instead of
   * refetching the task after ticking a box.
   */

  createChecklist(taskId: string, input: { name: string }): Promise<ClickUpChecklist> {
    return this.request(checklistResponse, "POST", `/v2/task/${taskId}/checklist`, {
      body: { name: input.name },
    }).then((r) => r.checklist);
  }

  /** Renames a checklist, or reorders it. `position` is 0-based from the top. */
  async updateChecklist(
    checklistId: string,
    input: { name?: string; position?: number },
  ): Promise<void> {
    await this.request(z.unknown(), "PUT", `/v2/checklist/${checklistId}`, { body: input });
  }

  async deleteChecklist(checklistId: string): Promise<void> {
    await this.request(z.unknown(), "DELETE", `/v2/checklist/${checklistId}`);
  }

  createChecklistItem(
    checklistId: string,
    input: { name: string; assignee?: number },
  ): Promise<ClickUpChecklist> {
    return this.request(checklistResponse, "POST", `/v2/checklist/${checklistId}/checklist_item`, {
      body: { name: input.name, assignee: input.assignee },
    }).then((r) => r.checklist);
  }

  /**
   * Ticks, renames, assigns or re-nests one line item.
   *
   * Unlike the comment endpoint this is a genuine patch: fields left out keep
   * their value, so ticking a box does not have to send the name back.
   */
  updateChecklistItem(
    checklistId: string,
    itemId: string,
    input: { name?: string; resolved?: boolean; assignee?: number | null; parent?: string | null },
  ): Promise<ClickUpChecklist> {
    return this.request(
      checklistResponse,
      "PUT",
      `/v2/checklist/${checklistId}/checklist_item/${itemId}`,
      { body: input },
    ).then((r) => r.checklist);
  }

  async deleteChecklistItem(checklistId: string, itemId: string): Promise<void> {
    await this.request(
      z.unknown(),
      "DELETE",
      `/v2/checklist/${checklistId}/checklist_item/${itemId}`,
    );
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

  /**
   * The webhooks on a Workspace, with their health.
   *
   * Scoped to the token, not to the Workspace: the spec says it "returns
   * webhooks created by the authenticated user", so asking with a different
   * token than the one that created a webhook answers as if it did not exist.
   * That is why the mirror records which user registered each one — see
   * `webhooks.user_id` — rather than round-robining like every other read.
   */
  getWebhooks(teamId: string): Promise<ClickUpWebhook[]> {
    return this.request(
      z.looseObject({ webhooks: z.array(clickUpWebhook) }),
      "GET",
      `/v2/team/${teamId}/webhook`,
    ).then((r) => r.webhooks);
  }

  /**
   * Changes a webhook's endpoint, events or status. How a suspended webhook is
   * brought back: ClickUp stops delivering at `fail_count` 100 and only a
   * `status: "active"` update starts it again.
   *
   * All three fields are required even when one is changing, so the caller has
   * to send back what it already knows. `events` is typed as a string in the
   * vendored spec, with `"*"` as the example, while the create endpoint takes
   * an array — so both shapes are allowed through here rather than guessed at.
   */
  updateWebhook(
    webhookId: string,
    input: { endpoint: string; events: string[] | "*"; status: "active" },
  ): Promise<ClickUpWebhook> {
    return this.request(
      z.looseObject({ id: z.string(), webhook: clickUpWebhook.optional() }),
      "PUT",
      `/v2/webhook/${webhookId}`,
      { body: { endpoint: input.endpoint, events: input.events, status: input.status } },
    ).then((r) => r.webhook ?? clickUpWebhook.parse({ id: r.id }));
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request(z.unknown(), "DELETE", `/v2/webhook/${webhookId}`);
  }
}

/**
 * The events Rask subscribes to.
 *
 * Deliberately not `"*"`. Every delivery costs a `GET /task/{id}` to find out
 * what changed, and Rask mirrors tasks — a Goal or a Space event would be
 * fetched and thrown away, and would still count against the webhook's health
 * if our endpoint choked on it.
 *
 * The specific `task*Updated` events overlap with `taskUpdated`, which is fine
 * and is why they are all here. ClickUp sends several per change rather than
 * choosing one: creating a single task produced `taskCreated`,
 * `taskStatusUpdated` and `taskUpdated`, three deliveries within 300ms. The
 * receiver coalesces by task id, so that was three deliveries, one queue row
 * and one `GET /task/{id}`.
 *
 * Comment events are absent. Ingest re-reads the task, and a task payload
 * carries no comments; the conversation is refreshed when somebody opens the
 * task, exactly as it was before webhooks existed. Subscribing would buy a
 * delivery that changes nothing.
 */
export const WEBHOOK_TASK_EVENTS = [
  "taskCreated",
  "taskUpdated",
  "taskDeleted",
  "taskStatusUpdated",
  "taskPriorityUpdated",
  "taskAssigneeUpdated",
  "taskDueDateUpdated",
  "taskTagUpdated",
  "taskMoved",
  "taskTimeEstimateUpdated",
] as const;

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

/**
 * A view with no orderindex sorts after every view that has one — ClickUp
 * always sends it, so a missing one means a shape nobody has seen and the safe
 * place for it is the end. The id breaks ties so two reads of the same List do
 * not disagree.
 */
function byOrderindex(a: ClickUpView, b: ClickUpView): number {
  const left = a.orderindex ?? Number.MAX_SAFE_INTEGER;
  const right = b.orderindex ?? Number.MAX_SAFE_INTEGER;
  return left - right || a.id.localeCompare(b.id);
}

/**
 * How a comment's body is carried.
 *
 * With no mentions it goes as `comment_text` and ClickUp does its own
 * formatting. With mentions it has to go as the structured `comment` array, or
 * the tag posts as literal characters and notifies nobody.
 *
 * Only the body: the surrounding fields differ per endpoint. UpdateComment, for
 * one, takes no `notify_all`.
 */
function commentBody(text: string): { comment: CommentSegment[] } | { comment_text: string } {
  const segments = toCommentSegments(text);
  return segments ? { comment: segments } : { comment_text: text };
}

/**
 * Drops the fields a list page claims to have and does not.
 *
 * `GET /list/{id}/task` and its siblings send `checklists: []` on every task,
 * including tasks that have two. Only `GET /task/{id}` tells the truth. Left
 * alone, an empty array reads as "this task has no checklists" and the ingest
 * deletes the real ones on every poll — so it is removed here, where the lie
 * is, rather than guarded for at each place that stores it.
 *
 * `attachments` is the same story and needs no help: the list endpoints omit it
 * entirely, which already means "no opinion".
 */
function withoutListPageLies<T extends { checklists?: unknown }>(task: T): T {
  if (!("checklists" in task)) return task;
  const { checklists: _dropped, ...rest } = task;
  return rest as T;
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
