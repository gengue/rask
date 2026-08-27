import { z } from "zod";
import { type CommentSegment, toCommentSegments } from "./mentions.ts";
import { RateLimiter } from "./rate-limit.ts";
import {
  accessTokenResponse,
  type ClickUpAttachmentUpload,
  type ClickUpChecklist,
  type ClickUpComment,
  type ClickUpCustomField,
  type ClickUpFolder,
  type ClickUpList,
  type ClickUpSpace,
  type ClickUpTag,
  type ClickUpTask,
  type ClickUpTeam,
  type ClickUpTimeEntry,
  type ClickUpUser,
  type ClickUpView,
  type ClickUpWebhook,
  checklistResponse,
  clickUpAttachmentUpload,
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
  runningTimeEntryResponse,
  taskPage,
  threadedCommentCreated,
  timeEntriesResponse,
  timeEntryResponse,
  viewResponse,
} from "./schemas.ts";

/**
 * How many pages of a view are asked for at once.
 *
 * A page of a view on one List comes back in about half a second. A page of a
 * view that spans a Workspace takes five to twenty-five, because ClickUp is
 * scanning every list under it rather than one — measured against `7-529-1`,
 * and true of a Workspace view with no filters at all, so it is the level that
 * costs, not the query. Asked for one after another, the 500-row cap is
 * seventeen of those in a row and nobody waits that long.
 *
 * ClickUp says which page is the last only by answering it, so a round asks
 * for four and learns it from whichever comes back flagged. That overshoots by
 * up to three requests on the last round — cheap against a 100/minute budget,
 * and they are the empty ones that cost ClickUp nothing to answer.
 */
const VIEW_PAGE_BATCH = 4;

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
    /*
     * FormData is sent as it is and names its own Content-Type.
     *
     * Stringifying it would upload the string "[object FormData]"; naming the
     * type here would send a boundary the parts were never split on. fetch
     * writes both correctly when we write neither, on every retry attempt.
     */
    const form = options.body instanceof FormData;
    if (options.body !== undefined && !form) headers["Content-Type"] = "application/json";

    let lastError: ClickUpError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.acquire();

      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: form ? (options.body as FormData) : JSON.stringify(options.body),
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
   * One view, by id, whatever it hangs off.
   *
   * The container endpoints above only reach views Rask already knows the
   * container of. A view id pasted out of a ClickUp URL comes with no such
   * context — and if it belongs to a Workspace, a Space or a Folder there is no
   * container Rask mirrors views for at all. This is the one call that answers
   * for any of them, and `parent.type` on the result says which it was.
   */
  getView(viewId: string): Promise<ClickUpView> {
    return this.request(viewResponse, "GET", `/v2/view/${viewId}`).then((r) => r.view);
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

  /**
   * Walks every page of a view, four at a time.
   *
   * Pages come out in order and a round is only as slow as its slowest page,
   * which is the whole point: see `VIEW_PAGE_BATCH`. Stops on the round that
   * contains the page ClickUp flagged as last, so the pages after it inside
   * that round are fetched and thrown away rather than waited for one by one.
   */
  async *iterateViewTasks(viewId: string): AsyncGenerator<ClickUpTask[]> {
    for (let page = 0; ; page += VIEW_PAGE_BATCH) {
      const round = await Promise.all(
        Array.from({ length: VIEW_PAGE_BATCH }, (_, offset) =>
          this.getViewTasks(viewId, { page: page + offset }),
        ),
      );

      for (const { tasks } of round) {
        if (tasks.length > 0) yield tasks;
      }

      if (round.some((result) => result.lastPage || result.tasks.length === 0)) return;
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

  /**
   * Deletes a task. ClickUp answers with an empty body.
   *
   * Reversible only from ClickUp's own Trash, which this app does not read, so
   * the caller is the last place a person can be asked whether they meant it.
   */
  async deleteTask(taskId: string): Promise<void> {
    await this.request(z.unknown(), "DELETE", `/v2/task/${taskId}`);
  }

  /** Custom Field values have their own endpoint; `updateTask` ignores them. */
  async setCustomFieldValue(taskId: string, fieldId: string, value: unknown): Promise<void> {
    await this.request(z.unknown(), "POST", `/v2/task/${taskId}/field/${fieldId}`, {
      body: { value },
    });
  }

  /**
   * Clearing one is its own verb.
   *
   * Every variant the POST body accepts is a value of some type — a string, a
   * number, an array, a `{add, rem}` — and none of them is none. Posting
   * `{ value: null }` at it is refused, which reaches the author as "ClickUp
   * rejected your change" for a field they only meant to empty.
   */
  async deleteCustomFieldValue(taskId: string, fieldId: string): Promise<void> {
    await this.request(z.unknown(), "DELETE", `/v2/task/${taskId}/field/${fieldId}`);
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

  // --- Time tracking ------------------------------------------------------

  /*
   * The timer running for the token's owner right now, or null.
   *
   * No `assignee` parameter: ClickUp answers this endpoint for the token's own
   * owner by design, and passing the id explicitly is a 403 TEAMM_002 on an
   * OAuth token even when it names that same owner. `assignee` stays a
   * parameter so callers read as intentional, but it does not travel.
   */
  getRunningTimeEntry(teamId: string, _assignee: string): Promise<ClickUpTimeEntry | null> {
    return this.request(
      runningTimeEntryResponse,
      "GET",
      `/v2/team/${teamId}/time_entries/current`,
    ).then((r) => r.data ?? null);
  }

  /** Starts a timer for the token's owner. ClickUp stamps the start, not us. */
  startTimeEntry(teamId: string, input: { taskId: string }): Promise<ClickUpTimeEntry> {
    return this.request(timeEntryResponse, "POST", `/v2/team/${teamId}/time_entries/start`, {
      body: { tid: input.taskId },
    }).then((r) => r.data);
  }

  /**
   * Records an interval that already happened, as ClickUp's own "manual" entry.
   *
   * `start` plus `duration` rather than `start` plus `end`: the endpoint takes
   * either, but `duration` is what the caller actually knows ("I worked 90
   * minutes") and deriving an `end` from it here would be a second place to get
   * the arithmetic wrong.
   */
  createTimeEntry(
    teamId: string,
    input: { taskId: string; start: number; durationMs: number; description?: string },
  ): Promise<ClickUpTimeEntry> {
    return this.request(timeEntryResponse, "POST", `/v2/team/${teamId}/time_entries`, {
      body: {
        tid: input.taskId,
        start: input.start,
        duration: input.durationMs,
        description: input.description,
      },
    }).then((r) => r.data);
  }

  /** Stops whatever is running for the token's owner. Errors when nothing is. */
  stopTimeEntry(teamId: string): Promise<ClickUpTimeEntry> {
    return this.request(timeEntryResponse, "POST", `/v2/team/${teamId}/time_entries/stop`).then(
      (r) => r.data,
    );
  }

  /**
   * Entries over a date window.
   *
   * The date window has to be spelled out every time, because ClickUp's
   * default is the last 30 days and a week-old sheet would come back looking
   * empty. `taskId` and `assignee` are each optional and each scopes the
   * answer, but they must not travel together as a list: on an OAuth token a
   * comma-joined `assignee` is a 403 TIMEENTRY_059, while a single id is
   * accepted everywhere — a task-scoped call without the parameter answers
   * with every entry on the task (what the entries panel wants), and an
   * assignee-scoped one without `task_id` answers with that person's entries
   * across the workspace (what the timesheet week asks for).
   */
  getTimeEntries(
    teamId: string,
    params: {
      taskId?: string;
      assignee?: string;
      startDate: number;
      endDate: number;
    },
  ): Promise<ClickUpTimeEntry[]> {
    return this.request(timeEntriesResponse, "GET", `/v2/team/${teamId}/time_entries`, {
      query: {
        task_id: params.taskId,
        assignee: params.assignee,
        start_date: params.startDate,
        end_date: params.endDate,
      },
    }).then((r) => r.data ?? []);
  }

  /**
   * Edits one entry.
   *
   * `tags` is a required field on this endpoint even when the caller only wants
   * to move a duration, and getting it wrong empties the entry's tags with no
   * error. `tag_action: "add"` over an empty array is the no-op that satisfies
   * the requirement, and it is applied here rather than at the call sites so
   * that none of them can forget.
   *
   * `start` and `end` travel together or not at all — the spec says so — which
   * is why they are one optional pair in the input rather than two fields.
   */
  updateTimeEntry(
    teamId: string,
    entryId: string,
    patch: { description?: string; billable?: boolean; span?: { start: number; end: number } },
  ): Promise<ClickUpTimeEntry> {
    const body: Record<string, unknown> = { tags: [], tag_action: "add" };
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.billable !== undefined) body.billable = patch.billable;
    if (patch.span) {
      body.start = patch.span.start;
      body.end = patch.span.end;
      body.duration = patch.span.end - patch.span.start;
    }

    return this.request(timeEntryResponse, "PUT", `/v2/team/${teamId}/time_entries/${entryId}`, {
      body,
    }).then((r) => r.data);
  }

  /** Removes an entry. ClickUp has no undo for this. */
  async deleteTimeEntry(teamId: string, entryId: string): Promise<void> {
    await this.request(z.unknown(), "DELETE", `/v2/team/${teamId}/time_entries/${entryId}`);
  }

  // --- Attachments --------------------------------------------------------

  /**
   * Uploads a file to a task.
   *
   * The only multipart request Rask makes, and the field really is named
   * `attachment` (see openapi/clickup-v2.json). One file per call: the spec
   * types the field as an array, but the response describes a single
   * attachment, so sending several would leave no way to name what came back.
   *
   * What it answers with is thinner than the task's own attachment list, so
   * the caller re-reads the task rather than mirroring this.
   */
  createTaskAttachment(taskId: string, file: File): Promise<ClickUpAttachmentUpload> {
    const form = new FormData();
    form.append("attachment", file, file.name);
    return this.request(clickUpAttachmentUpload, "POST", `/v2/task/${taskId}/attachment`, {
      body: form,
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
  "taskTimeTrackedUpdated",
  /*
   * The two comment events, which are the only way a conversation reaches the
   * mirror without somebody opening the task.
   *
   * Polling cannot stand in for these. `GET /list/{id}/task` carries no
   * comments, so discovering one by polling would mean a
   * `GET /task/{id}/comment` for every task that changed — a second request per
   * change, against a 100-a-minute budget, to find out that most of them had
   * nothing to say. A comment event costs one request and only when there is
   * something to read.
   *
   * The price is that with no webhook there are no comment notifications at
   * all. That is a visible, recoverable state — the health loop registers and
   * reactivates — rather than a silent one.
   */
  "taskCommentPosted",
  "taskCommentUpdated",
] as const;

/** Events that mean the task's conversation moved, not just the task. */
export const WEBHOOK_COMMENT_EVENTS: readonly string[] = [
  "taskCommentPosted",
  "taskCommentUpdated",
];

export function isCommentEvent(event: string): boolean {
  return WEBHOOK_COMMENT_EVENTS.includes(event);
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
