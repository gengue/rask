import { describe, expect, test } from "bun:test";
import { ClickUpClient, ClickUpError } from "../src/client.ts";
import { RateLimiter } from "../src/rate-limit.ts";
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
