import { describe, expect, test } from "bun:test";
import { ClickUpClient, ClickUpError, WEBHOOK_TASK_EVENTS } from "../src/client.ts";
import { RateLimiter } from "../src/rate-limit.ts";
import checklistFixture from "./fixtures/checklist.json" with { type: "json" };
import taskFixture from "./fixtures/task.json" with { type: "json" };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Records every request and replays a queue of canned responses. */
function stubFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const queue = [...responses];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request: ${input}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as typeof globalThis.fetch;

  return { fetchImpl, calls };
}

function makeClient(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
  options: { token?: string } = {},
) {
  const { fetchImpl, calls } = stubFetch(responses);
  const client = new ClickUpClient({
    token: options.token ?? "oauth_abc",
    fetch: fetchImpl,
    // A limiter that never blocks, so tests don't depend on wall time.
    limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
    sleep: async () => {},
  });
  return { client, calls };
}

describe("auth header", () => {
  test("sends a personal key raw", async () => {
    const { client, calls } = makeClient([{ body: taskFixture }], { token: "pk_123" });
    await client.getTask("9hz");
    expect(calls[0]?.headers.authorization).toBe("pk_123");
  });

  test("sends an OAuth token with the Bearer prefix", async () => {
    const { client, calls } = makeClient([{ body: taskFixture }]);
    await client.getTask("9hz");
    expect(calls[0]?.headers.authorization).toBe("Bearer oauth_abc");
  });
});

describe("getTask", () => {
  test("parses ClickUp's string epochs into Dates", async () => {
    const { client } = makeClient([{ body: taskFixture }]);
    const task = await client.getTask("9hz");

    expect(task.id).toBe("9hz");
    expect(task.date_created).toEqual(new Date(1567780450202));
    expect(task.due_date).toEqual(new Date(1508369194377));
    expect(task.date_closed).toBeNull();
  });

  test("keeps nested references and custom field values", async () => {
    const { client } = makeClient([{ body: taskFixture }]);
    const task = await client.getTask("9hz");

    expect(task.list?.id).toBe("123");
    expect(task.space?.id).toBe("789");
    expect(task.status?.status).toBe("in progress");
    expect(task.assignees[0]?.id).toBe(183);
    expect(task.custom_fields[0]?.value).toBe("opt-2");
  });

  test("asks for the markdown body", async () => {
    const { client, calls } = makeClient([{ body: taskFixture }]);
    await client.getTask("9hz");
    expect(calls[0]?.url).toContain("include_markdown_description=true");
  });

  test("survives fields ClickUp adds later", async () => {
    const { client } = makeClient([{ body: { ...taskFixture, brand_new_field: { a: 1 } } }]);
    await expect(client.getTask("9hz")).resolves.toBeDefined();
  });

  test("throws when a required field is missing rather than returning a half task", async () => {
    const { name, ...withoutName } = taskFixture;
    const { client } = makeClient([{ body: withoutName }]);
    await expect(client.getTask("9hz")).rejects.toThrow(ClickUpError);
  });
});

describe("attachments", () => {
  test("parses the whole file, including the epoch and the stringified size", async () => {
    const { client } = makeClient([{ body: taskFixture }]);
    const [image, pdf] = (await client.getTask("9hz")).attachments ?? [];

    expect(image?.title).toBe("cold-start.png");
    expect(image?.mimetype).toBe("image/png");
    expect(image?.size).toBe(18080);
    expect(image?.date).toEqual(new Date(1787362173440));
    expect(image?.thumbnail_small).toContain("image_small.png");

    // Size and date come back as strings on some files and numbers on others.
    expect(pdf?.size).toBe(10916008);
    expect(pdf?.date).toEqual(new Date(1787298878760));
  });

  test("keeps the URL variants apart, since only one of them renders inline", async () => {
    const { client } = makeClient([{ body: taskFixture }]);
    const [image] = (await client.getTask("9hz")).attachments ?? [];

    expect(image?.url).toBe("https://t529.p.clickup-attachments.com/t529/0ed173fb/image.png");
    expect(image?.url_w_query).toBe(
      "https://t529.p.clickup-attachments.com/t529/0ed173fb/image.png?view=open",
    );
  });

  /*
   * The distinction the mirror depends on. `GET /task/{id}` always sends the
   * key; `GET /list/{id}/task` never does. A default of [] here would make a
   * list poll indistinguishable from ClickUp reporting an empty task.
   */
  test("is undefined when ClickUp omitted the key", async () => {
    const { attachments, ...withoutAttachments } = taskFixture;
    const { client } = makeClient([{ body: withoutAttachments }]);
    expect((await client.getTask("9hz")).attachments).toBeUndefined();
  });

  test("is an empty array when ClickUp says the task has none", async () => {
    const { client } = makeClient([{ body: { ...taskFixture, attachments: [] } }]);
    expect((await client.getTask("9hz")).attachments).toEqual([]);
  });
});

describe("query serialization", () => {
  test("repeats array params with a [] suffix, the way ClickUp expects", async () => {
    const { client, calls } = makeClient([{ body: { tasks: [], last_page: true } }]);
    await client.getListTasks("123", { statuses: ["to do", "in progress"], assignees: [183, 42] });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.getAll("statuses[]")).toEqual(["to do", "in progress"]);
    expect(url.searchParams.getAll("assignees[]")).toEqual(["183", "42"]);
  });

  test("passes date_updated_gt through for incremental polling", async () => {
    const { client, calls } = makeClient([{ body: { tasks: [], last_page: true } }]);
    await client.getListTasks("123", { dateUpdatedGt: 1567780450202 });
    expect(new URL(calls[0]?.url ?? "").searchParams.get("date_updated_gt")).toBe("1567780450202");
  });

  test("omits undefined filters instead of sending the string 'undefined'", async () => {
    const { client, calls } = makeClient([{ body: { tasks: [], last_page: true } }]);
    await client.getListTasks("123");
    expect(calls[0]?.url).not.toContain("undefined");
  });
});

describe("pagination", () => {
  test("walks pages until ClickUp flags the last one", async () => {
    const { client, calls } = makeClient([
      { body: { tasks: [taskFixture], last_page: false } },
      { body: { tasks: [{ ...taskFixture, id: "9i0" }], last_page: true } },
    ]);

    const ids: string[] = [];
    for await (const page of client.iterateListTasks("123")) ids.push(...page.map((t) => t.id));

    expect(ids).toEqual(["9hz", "9i0"]);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("page")).toBe("0");
    expect(new URL(calls[1]?.url ?? "").searchParams.get("page")).toBe("1");
  });

  test("stops on an empty page even when last_page is absent", async () => {
    const { client, calls } = makeClient([{ body: { tasks: [] } }]);
    for await (const _ of client.iterateListTasks("123")) {
      // no pages expected
    }
    expect(calls).toHaveLength(1);
  });
});

describe("errors and retries", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    const { client, calls } = makeClient([
      {
        status: 429,
        body: { err: "Rate limit reached", ECODE: "OAUTH_098" },
        headers: { "x-ratelimit-reset": "1" },
      },
      { body: taskFixture },
    ]);

    const task = await client.getTask("9hz");
    expect(task.id).toBe("9hz");
    expect(calls).toHaveLength(2);
  });

  test("retries 5xx", async () => {
    const { client, calls } = makeClient([{ status: 502, body: {} }, { body: taskFixture }]);
    await client.getTask("9hz");
    expect(calls).toHaveLength(2);
  });

  test("does not retry a 401 and surfaces ClickUp's message", async () => {
    const { client, calls } = makeClient([
      { status: 401, body: { err: "Token invalid", ECODE: "OAUTH_025" } },
    ]);

    const error = (await client.getTask("9hz").catch((e: unknown) => e)) as ClickUpError;
    expect(error).toBeInstanceOf(ClickUpError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("OAUTH_025");
    expect(error.message).toContain("Token invalid");
    expect(calls).toHaveLength(1);
  });

  test("gives up after maxRetries", async () => {
    const { fetchImpl, calls } = stubFetch(
      Array.from({ length: 5 }, () => ({ status: 500, body: {} })),
    );
    const client = new ClickUpClient({
      token: "pk_1",
      fetch: fetchImpl,
      maxRetries: 2,
      sleep: async () => {},
      limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
    });

    await expect(client.getTask("9hz")).rejects.toThrow(ClickUpError);
    expect(calls).toHaveLength(3);
  });
});

describe("writes", () => {
  test("updateTask sends a PUT with only the changed fields", async () => {
    const { client, calls } = makeClient([{ body: taskFixture }]);
    await client.updateTask("9hz", { status: "done" });

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toContain("/v2/task/9hz");
    expect(calls[0]?.body).toEqual({ status: "done" });
  });

  test("createComment maps text to ClickUp's comment_text and defaults notify_all off", async () => {
    const { client, calls } = makeClient([{ body: { id: 456 } }]);
    const created = await client.createComment("9hz", { text: "on it" });

    expect(created.id).toBe("456");
    expect(calls[0]?.body).toEqual({
      comment_text: "on it",
      assignee: undefined,
      notify_all: false,
    });
  });

  test("custom field values go to their own endpoint", async () => {
    const { client, calls } = makeClient([{ body: {} }]);
    await client.setCustomFieldValue("9hz", "field-1", "opt-2");

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v2/task/9hz/field/field-1");
    expect(calls[0]?.body).toEqual({ value: "opt-2" });
  });
});

/**
 * Checklists.
 *
 * The vendored spec types the `checklists` array on a task as `object` and
 * nothing more, and it contradicts itself on the item's `assignee` — a user
 * object in one response, a bare id in another. The fixture is the shape the
 * Ventura workspace actually sends, which is the only reason we know the
 * `creator` field exists at all.
 */
describe("checklists", () => {
  test("parses a checklist off a task, items and all", async () => {
    const { client } = makeClient([{ body: { ...taskFixture, checklists: [checklistFixture] } }]);
    const task = await client.getTask("9hz");

    expect(task.checklists).toHaveLength(1);
    expect(task.checklists?.[0]?.name).toBe("Release steps");
    expect(task.checklists?.[0]?.items).toHaveLength(3);
    expect(task.checklists?.[0]?.creator).toBe("82591240");
    expect(task.checklists?.[0]?.date_created).toEqual(new Date(1787165200145));
  });

  test("accepts an item assignee as either a user object or a bare id", async () => {
    const { client } = makeClient([{ body: { ...taskFixture, checklists: [checklistFixture] } }]);
    const items = (await client.getTask("9hz")).checklists?.[0]?.items ?? [];

    expect(items[1]?.assignee).toMatchObject({ id: 183 });
    expect(items[2]?.assignee).toBe("183");
  });

  /**
   * The difference that matters: a list page omits the key entirely, and
   * defaulting it to `[]` would tell the mirror ClickUp had just said the task
   * has no checklists. Same trap as attachments.
   */
  test("is undefined when the payload never mentioned checklists", async () => {
    const { checklists: _dropped, ...withoutKey } = taskFixture;
    const { client } = makeClient([{ body: { tasks: [withoutKey], last_page: true } }]);
    const { tasks } = await client.getListTasks("777");

    expect(tasks[0]?.checklists).toBeUndefined();
  });

  test("creating one posts to the task and unwraps the response", async () => {
    const { client, calls } = makeClient([{ body: { checklist: checklistFixture } }]);
    const created = await client.createChecklist("9hz", { name: "Release steps" });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v2/task/9hz/checklist");
    expect(calls[0]?.body).toEqual({ name: "Release steps" });
    expect(created.id).toBe("f66e2c95-ab84-463b-8b5d-3754a97ec1e7");
  });

  test("ticking an item sends only what changed and answers with the whole list", async () => {
    const { client, calls } = makeClient([{ body: { checklist: checklistFixture } }]);
    const updated = await client.updateChecklistItem("cl-1", "item-1", { resolved: true });

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toContain("/v2/checklist/cl-1/checklist_item/item-1");
    expect(calls[0]?.body).toEqual({ resolved: true });
    expect(updated.items).toHaveLength(3);
  });

  test("adding an item posts to the checklist, not the task", async () => {
    const { client, calls } = makeClient([{ body: { checklist: checklistFixture } }]);
    await client.createChecklistItem("cl-1", { name: "Smoke test" });

    expect(calls[0]?.url).toContain("/v2/checklist/cl-1/checklist_item");
    expect(calls[0]?.body).toEqual({ name: "Smoke test", assignee: undefined });
  });

  test("deleting an item needs both ids in the path", async () => {
    const { client, calls } = makeClient([{ body: {} }]);
    await client.deleteChecklistItem("cl-1", "item-1");

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/v2/checklist/cl-1/checklist_item/item-1");
  });
});

/** Newest first, so the cursor for the next page is the *last* one you got. */
function comment(id: string, date: number, extra: Record<string, unknown> = {}) {
  return { id, comment_text: `c${id}`, date, ...extra };
}

describe("comments", () => {
  test("walks pages with the oldest comment as the cursor", async () => {
    const { client, calls } = makeClient([
      { body: { comments: [comment("30", 300), comment("20", 200)] } },
      { body: { comments: [comment("10", 100)] } },
      { body: { comments: [] } },
    ]);

    const ids: string[] = [];
    for await (const page of client.iterateComments("9hz")) ids.push(...page.map((c) => c.id));

    expect(ids).toEqual(["30", "20", "10"]);

    const first = new URL(calls[0]?.url ?? "");
    expect(first.searchParams.get("start")).toBeNull();
    expect(first.searchParams.get("start_id")).toBeNull();

    // Page two resumes from the oldest of page one, not the newest.
    const second = new URL(calls[1]?.url ?? "");
    expect(second.searchParams.get("start")).toBe("200");
    expect(second.searchParams.get("start_id")).toBe("20");
  });

  test("stops at maxPages rather than walking a thousand-comment task", async () => {
    const { client, calls } = makeClient([
      { body: { comments: [comment("30", 300)] } },
      { body: { comments: [comment("20", 200)] } },
      { body: { comments: [comment("10", 100)] } },
    ]);

    const pages: number[] = [];
    for await (const page of client.iterateComments("9hz", { maxPages: 2 })) {
      pages.push(page.length);
    }

    expect(pages).toEqual([1, 1]);
    expect(calls).toHaveLength(2);
  });

  test("reads a thread from the reply endpoint", async () => {
    const { client, calls } = makeClient([{ body: { comments: [comment("41", 410)] } }]);
    const replies = await client.getThreadedComments("40");

    expect(replies.map((r) => r.id)).toEqual(["41"]);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/v2/comment/40/reply");
  });

  test("posts a reply to the parent comment, not the task", async () => {
    // The spec documents an empty object here, so parsing must not require an id.
    const { client, calls } = makeClient([{ body: {} }]);
    const created = await client.createThreadedComment("40", { text: "on it" });

    expect(created.id).toBeUndefined();
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v2/comment/40/reply");
    expect(calls[0]?.body).toEqual({
      comment_text: "on it",
      assignee: undefined,
      notify_all: false,
    });
  });

  test("updateComment always sends text and resolved together", async () => {
    // ClickUp treats both as required and blanks whatever is left out, so
    // resolving a comment has to carry its body back unchanged.
    const { client, calls } = makeClient([{ body: {} }]);
    await client.updateComment("40", { text: "unchanged", resolved: true });

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toContain("/v2/comment/40");
    expect(calls[0]?.body).toEqual({
      comment_text: "unchanged",
      resolved: true,
      assignee: undefined,
    });
  });

  test("deleteComment sends a DELETE with no body", async () => {
    const { client, calls } = makeClient([{ body: {} }]);
    await client.deleteComment("40");

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/v2/comment/40");
    expect(calls[0]?.body).toBeUndefined();
  });
});

describe("getWorkspaceHierarchy", () => {
  test("returns each space with its folders and folderless lists", async () => {
    const { client } = makeClient([
      { body: { spaces: [{ id: "789", name: "Engineering", statuses: [] }] } },
      { body: { folders: [{ id: "456", name: "Q3", lists: [{ id: "1", name: "Sprint" }] }] } },
      { body: { lists: [{ id: "2", name: "Inbox" }] } },
    ]);

    const tree = await client.getWorkspaceHierarchy("9001");

    expect(tree).toHaveLength(1);
    expect(tree[0]?.space.name).toBe("Engineering");
    expect(tree[0]?.folders[0]?.lists[0]?.name).toBe("Sprint");
    expect(tree[0]?.lists[0]?.name).toBe("Inbox");
  });
});

describe("list pages lie about checklists", () => {
  /**
   * GET /list/{id}/task sends `checklists: []` on every task, including tasks
   * that have two — only GET /task/{id} tells the truth. An empty array reads
   * as "this task has none", so the ingest deleted the real ones on every poll.
   */
  test("drops the empty array a list page sends", async () => {
    const { client } = makeClient([
      { body: { tasks: [{ ...taskFixture, checklists: [] }], last_page: true } },
    ]);

    const { tasks } = await client.getListTasks("123");
    expect(tasks[0] && "checklists" in tasks[0]).toBe(false);
  });

  test("drops it even when a list page claims to have one", async () => {
    const { client } = makeClient([
      {
        body: {
          tasks: [{ ...taskFixture, checklists: [{ id: "c1", name: "nope", items: [] }] }],
          last_page: true,
        },
      },
    ]);

    const { tasks } = await client.getListTasks("123");
    expect(tasks[0] && "checklists" in tasks[0]).toBe(false);
  });

  test("keeps what the task endpoint sends, which is the authority", async () => {
    const { client } = makeClient([
      { body: { ...taskFixture, checklists: [{ id: "c1", name: "real", items: [] }] } },
    ]);

    const task = await client.getTask("9hz");
    expect(task.checklists).toHaveLength(1);
  });
});

/**
 * Webhook lifecycle.
 *
 * Endpoint and parameter names come from the vendored spec — GetWebhooks,
 * CreateWebhook, UpdateWebhook, DeleteWebhook — and these tests are what keeps
 * them from drifting back into guesses. The registration logic in the worker
 * cannot be trusted about "is there already one of these" if the call it asks
 * with is shaped wrong.
 */
describe("webhooks", () => {
  const webhook = {
    id: "4b67ac88-e506-4a29-9d42-26e504e3435e",
    endpoint: "https://rask.example/webhooks/clickup",
    events: ["taskUpdated"],
    secret: "O94IM25S7PXBPYTMNXLLET230SRP0S89",
    health: { status: "active", fail_count: 0 },
  };

  test("creates one scoped to a single list", async () => {
    const { client, calls } = makeClient([{ body: { id: webhook.id, webhook } }]);

    await client.createWebhook("9011", {
      endpoint: webhook.endpoint,
      events: ["taskUpdated", "taskDeleted"],
      listId: "901300000001",
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v2/team/9011/webhook");
    // ClickUp types the scope ids as integers, unlike every other id it sends.
    expect(calls[0]?.body).toEqual({
      endpoint: webhook.endpoint,
      events: ["taskUpdated", "taskDeleted"],
      list_id: 901300000001,
    });
  });

  test("returns the secret, which ClickUp only ever sends at creation", async () => {
    const { client } = makeClient([{ body: { id: webhook.id, webhook } }]);

    const created = await client.createWebhook("9011", {
      endpoint: webhook.endpoint,
      events: ["taskUpdated"],
    });

    expect(created.secret).toBe(webhook.secret);
  });

  test("survives a create response that is only an id", async () => {
    // The spec's own example nests the webhook. A registration that threw on a
    // response that did not would leave a live webhook nobody owns.
    const { client } = makeClient([{ body: { id: webhook.id } }]);

    const created = await client.createWebhook("9011", {
      endpoint: webhook.endpoint,
      events: ["taskUpdated"],
    });

    expect(created.id).toBe(webhook.id);
    expect(created.secret ?? null).toBeNull();
  });

  test("lists them with their health", async () => {
    const failing = { ...webhook, health: { status: "failing", fail_count: 5 } };
    const { client, calls } = makeClient([{ body: { webhooks: [failing] } }]);

    const [found] = await client.getWebhooks("9011");

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/v2/team/9011/webhook");
    expect(found?.health).toEqual({ status: "failing", fail_count: 5 });
  });

  test("reactivates a suspended one, sending back all three required fields", async () => {
    const { client, calls } = makeClient([{ body: { id: webhook.id, webhook } }]);

    await client.updateWebhook(webhook.id, {
      endpoint: webhook.endpoint,
      events: ["taskUpdated"],
      status: "active",
    });

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toContain(`/v2/webhook/${webhook.id}`);
    // The spec marks endpoint, events and status all required, even when only
    // the status is changing. A partial body is a 400, not a patch.
    expect(calls[0]?.body).toEqual({
      endpoint: webhook.endpoint,
      events: ["taskUpdated"],
      status: "active",
    });
  });

  test("deletes one", async () => {
    const { client, calls } = makeClient([{ body: {} }]);

    await client.deleteWebhook(webhook.id);

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain(`/v2/webhook/${webhook.id}`);
  });

  test("subscribes to task events rather than the wildcard", async () => {
    // `"*"` would deliver Goal and Space events that cost a read-back and
    // change nothing, and would count our shrugs against the webhook's health.
    const events: readonly string[] = WEBHOOK_TASK_EVENTS;
    expect(events).toContain("taskUpdated");
    expect(events).toContain("taskDeleted");
    expect(events).not.toContain("*");
    for (const event of events) expect(event.startsWith("task")).toBe(true);
  });
});
