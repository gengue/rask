import { describe, expect, test } from "bun:test";
import { ClickUpClient } from "../src/client.ts";
import { RateLimiter } from "../src/rate-limit.ts";
import viewsFixture from "./fixtures/list-views.json" with { type: "json" };
import taskFixture from "./fixtures/task.json" with { type: "json" };

/**
 * The view endpoints, against a trimmed capture of list 901516038590 in the
 * Ventura workspace — the one the tab bar was built from. It has two saved
 * boards, a saved list, a conversation, two forms, and the two built-ins.
 *
 * The published schema for GetListViews documents `views` and nothing else, so
 * everything the response actually carries — the `required_views` map with its
 * nulls, the differently shaped `default_view` — is pinned here rather than
 * trusted.
 */

interface Call {
  url: string;
  method: string;
}

function makeClient(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const queue = [...responses];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request: ${input}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const client = new ClickUpClient({
    token: "pk_test",
    fetch: fetchImpl,
    limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
    sleep: async () => {},
  });
  return { client, calls };
}

describe("getListViews", () => {
  test("merges the built-in views into the saved ones, in one orderindex sequence", async () => {
    const { client } = makeClient([{ body: viewsFixture }]);
    const { views } = await client.getListViews("901516038590");

    expect(views.map((view) => [view.orderindex, view.type, view.name])).toEqual([
      [1, "board", "Board"],
      [2, "board", "Ventura AI"],
      [3, "board", "All"],
      [4, "list", "Ventura AI list"],
      [5, "list", "All"],
      [7, "conversation", "AI Tasks"],
      [8, "form", "AI wish form"],
      [9, "form", "vAI Feedback Form"],
    ]);
  });

  test("drops the null entries required_views carries for absent built-ins", async () => {
    const { client } = makeClient([{ body: viewsFixture }]);
    const { views } = await client.getListViews("901516038590");

    // The fixture's map has twelve keys and ten of them are null.
    expect(views.filter((view) => view.type === "calendar")).toEqual([]);
    expect(views).toHaveLength(8);
  });

  test("reports the default view by id, not by re-parsing its differently shaped copy", async () => {
    const { client } = makeClient([{ body: viewsFixture }]);
    const { views, defaultViewId } = await client.getListViews("901516038590");

    // `default_view.type` is the number 2 where every other copy says "board".
    expect(defaultViewId).toBe("gh-84055");
    expect(views.find((view) => view.id === defaultViewId)?.type).toBe("board");
  });

  test("keeps the grouping field and the show_closed flag", async () => {
    const { client } = makeClient([{ body: viewsFixture }]);
    const { views } = await client.getListViews("901516038590");
    const saved = views.find((view) => view.id === "gh-96335");

    expect(saved?.grouping?.field).toBe("status");
    expect(saved?.filters?.show_closed).toBe(false);
    // The rule list is carried but never evaluated locally; see getViewTasks.
    expect(saved?.filters?.fields).toHaveLength(2);
  });

  test("gives a form the address it is published at", async () => {
    const { client } = makeClient([{ body: viewsFixture }]);
    const { views } = await client.getListViews("901516038590");

    expect(views.find((view) => view.id === "gh-91895")?.public_url).toContain("forms.clickup.com");
    // Absent rather than null on everything that is not a form.
    expect(views.find((view) => view.id === "gh-96335")?.public_url).toBeUndefined();
  });

  test("survives a view type ClickUp adds later", async () => {
    const invented = { ...viewsFixture.views[0], id: "gh-new", type: "whiteboard" };
    const { client } = makeClient([
      { body: { ...viewsFixture, views: [...viewsFixture.views, invented] } },
    ]);

    const { views } = await client.getListViews("901516038590");
    expect(views.find((view) => view.id === "gh-new")?.type).toBe("whiteboard");
  });

  test("sorts a view with no orderindex last rather than first", async () => {
    const { orderindex: _dropped, ...unordered } = viewsFixture.views[0] as Record<string, unknown>;
    const { client } = makeClient([
      { body: { ...viewsFixture, views: [{ ...unordered, id: "gh-late" }] } },
    ]);

    const { views } = await client.getListViews("901516038590");
    expect(views.at(-1)?.id).toBe("gh-late");
  });
});

describe("getViewTasks", () => {
  test("always sends the page parameter, which this endpoint requires", async () => {
    const { client, calls } = makeClient([{ body: { tasks: [taskFixture], last_page: true } }]);
    await client.getViewTasks("gh-96335");

    expect(calls[0]?.url).toContain("/v2/view/gh-96335/task");
    expect(calls[0]?.url).toContain("page=0");
  });

  test("parses the tasks with the same schema as a list page", async () => {
    const { client } = makeClient([{ body: { tasks: [taskFixture], last_page: true } }]);
    const { tasks, lastPage } = await client.getViewTasks("gh-96335", { page: 2 });

    expect(tasks[0]?.id).toBe("9hz");
    expect(lastPage).toBe(true);
  });

  test("walks pages until ClickUp flags the last one", async () => {
    const { client, calls } = makeClient([
      { body: { tasks: [taskFixture], last_page: false } },
      { body: { tasks: [{ ...taskFixture, id: "9i0" }], last_page: true } },
      { body: { tasks: [], last_page: true } },
      { body: { tasks: [], last_page: true } },
    ]);

    const seen: string[] = [];
    for await (const page of client.iterateViewTasks("gh-96335")) {
      for (const task of page) seen.push(task.id);
    }

    expect(seen).toEqual(["9hz", "9i0"]);
    // One round of four, not two waits in a row: a page of a Workspace view
    // costs five to twenty-five seconds, so the round is the unit that matters.
    expect(calls.map((call) => new URL(call.url).searchParams.get("page"))).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);
  });

  test("keeps going past a full round, and keeps the pages in order", async () => {
    const page = (id: string, last: boolean) => ({
      body: { tasks: [{ ...taskFixture, id }], last_page: last },
    });
    const { client, calls } = makeClient([
      page("a0", false),
      page("a1", false),
      page("a2", false),
      page("a3", false),
      page("b0", false),
      page("b1", true),
      { body: { tasks: [], last_page: true } },
      { body: { tasks: [], last_page: true } },
    ]);

    const seen: string[] = [];
    for await (const batch of client.iterateViewTasks("gh-96335")) {
      for (const task of batch) seen.push(task.id);
    }

    // `Promise.all` keeps a round's answers in the order they were asked for,
    // which is what lets a caller cap at 500 rows and take the first 500.
    expect(seen).toEqual(["a0", "a1", "a2", "a3", "b0", "b1"]);
    expect(calls.length).toBe(8);
  });

  test("a view with nothing in it is one round, not one request forever", async () => {
    const empty = { body: { tasks: [], last_page: true } };
    const { client, calls } = makeClient([empty, empty, empty, empty]);

    const seen: string[] = [];
    for await (const batch of client.iterateViewTasks("gh-3144"))
      seen.push(...batch.map((t) => t.id));

    expect(seen).toEqual([]);
    expect(calls.length).toBe(4);
  });
});

/**
 * The real `7-529-1` from the Ventura workspace: the "IT over due date tasks"
 * view that sits on the Workspace rather than on any list, which is the shape
 * `GET /list/{id}/view` can never return and a pasted URL can.
 */
const workspaceView = {
  id: "7-529-1",
  name: "IT over due date tasks",
  type: "list",
  parent: { id: "529", type: 7 },
  grouping: { field: "assignee", dir: 1 },
  filters: {
    op: "AND",
    fields: [{ field: "dueDate", op: "EQ", values: [{ op: "overdue" }] }],
    show_closed: false,
  },
};

describe("getView", () => {
  test("reads one view by id, whatever it hangs off", async () => {
    const { client, calls } = makeClient([{ body: { view: workspaceView } }]);
    const view = await client.getView("7-529-1");

    expect(view.name).toBe("IT over due date tasks");
    expect(view.parent).toEqual({ id: "529", type: 7 });
    expect(view.grouping?.field).toBe("assignee");
    expect(view.filters?.show_closed).toBe(false);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v2/view/7-529-1");
  });
});
