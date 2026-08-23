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
    ]);

    const seen: string[] = [];
    for await (const page of client.iterateViewTasks("gh-96335")) {
      for (const task of page) seen.push(task.id);
    }

    expect(seen).toEqual(["9hz", "9i0"]);
    expect(calls.map((call) => new URL(call.url).searchParams.get("page"))).toEqual(["0", "1"]);
  });
});
