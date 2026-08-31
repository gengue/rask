import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ClickUpClient, RateLimiter } from "@rask/clickup-client";
import { createTestDb, docs as docsTable, tasks, users } from "@rask/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { SessionUser } from "../src/auth.ts";
import { docsRoutes } from "../src/docs.ts";

/**
 * `GET /tasks/:id/docs`, against a stubbed ClickUp.
 *
 * The route is a read, so what is worth testing is what it refuses and what it
 * turns a failure into. It takes a task id from the caller and spends the
 * caller's own ClickUp budget on it, which is why an unmirrored id has to stop
 * here; and it forwards nothing of ClickUp's status, because a 401 handed
 * through would sign the person out of Rask over an expanded section.
 */

const db = createTestDb();

const TEAM = "529";
const ME = "api-docs-user";
const TASK = "api-docs-task";
const LIST = "api-docs-list";

const USER: SessionUser = {
  id: ME,
  username: "Ada",
  email: "ada@example.com",
  initials: "A",
  color: null,
  avatar: null,
  teamId: TEAM,
  inboxSeenAt: new Date(0),
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stub(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const queue = [...responses];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected ClickUp request: ${input}`);
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
    // No retries: a 401 here is the test, and three backoffs of it is just slow.
    maxRetries: 0,
  });

  return { client, calls };
}

function mount(client: ClickUpClient | null) {
  const app = new Hono<{ Variables: { user: SessionUser } }>();
  app.use("*", async (c, next) => {
    c.set("user", USER);
    await next();
  });
  app.route("/", docsRoutes({ db, clientFor: async () => client }));
  return app;
}

const DOC = {
  id: "gh-96615",
  name: "Flights inbox",
  parent: { id: TASK, type: 1 },
  date_created: 1_786_731_888_405,
  date_updated: 1_787_833_798_853,
  deleted: false,
};

const OPEN_DOC = "api-docs-open";

beforeEach(async () => {
  await db.delete(docsTable).where(eq(docsTable.id, OPEN_DOC));
  await db.delete(tasks).where(eq(tasks.id, TASK));
  await db.delete(users).where(eq(users.id, ME));
  await db.insert(users).values({ id: ME, username: "Ada" });
  await db.insert(tasks).values({ id: TASK, listId: LIST, name: "Book the flight" });
});

afterAll(async () => {
  await db.delete(docsTable).where(eq(docsTable.id, OPEN_DOC));
  await db.delete(tasks).where(eq(tasks.id, TASK));
  await db.delete(users).where(eq(users.id, ME));
});

test("assembles each Doc with its pages", async () => {
  const { client, calls } = stub([
    { body: { docs: [DOC] } },
    {
      body: [
        { id: "p1", name: "Status quo", content: "# One", order_index: 1 },
        { id: "p2", name: "Proposal", content: "# Two", order_index: 3 },
      ],
    },
  ]);

  const response = await mount(client).request(`/tasks/${TASK}/docs`);
  const body = (await response.json()) as {
    docs: Array<{ id: string; name: string; updated: string; pages: Array<{ name: string }> }>;
  };

  expect(response.status).toBe(200);
  expect(body.docs).toHaveLength(1);
  expect(body.docs[0]?.name).toBe("Flights inbox");
  // ISO, like every other instant this API sends — not the epoch ClickUp gave.
  expect(body.docs[0]?.updated).toBe("2026-08-27T12:29:58.853Z");
  expect(body.docs[0]?.pages.map((page) => page.name)).toEqual(["Status quo", "Proposal"]);

  // The search is scoped to this task and nothing else, or the panel fills
  // with Docs from across the workspace.
  expect(calls[0]?.url).toContain(`parent_id=${TASK}`);
  expect(calls[0]?.url).toContain("parent_type=TASK");
});

test("costs one request when the task has no Docs", async () => {
  const { client, calls } = stub([{ body: { docs: [] } }]);

  const response = await mount(client).request(`/tasks/${TASK}/docs`);

  expect(await response.json()).toEqual({ docs: [] });
  expect(calls).toHaveLength(1);
});

test("names an unnamed Doc rather than rendering a blank heading", async () => {
  const { client } = stub([{ body: { docs: [{ ...DOC, name: "  " }] } }, { body: [] }]);

  const body = (await (await mount(client).request(`/tasks/${TASK}/docs`)).json()) as {
    docs: Array<{ name: string }>;
  };

  expect(body.docs[0]?.name).toBe("Doc");
});

describe("what it refuses to ask ClickUp about", () => {
  test("answers empty for a task ClickUp has never seen", async () => {
    const { client, calls } = stub([]);

    const response = await mount(client).request("/tasks/tmp_abc/docs");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ docs: [] });
    // A placeholder id would 404 upstream: not worth the request.
    expect(calls).toHaveLength(0);
  });

  test("404s an id the mirror does not hold, without spending a request", async () => {
    const { client, calls } = stub([]);

    const response = await mount(client).request("/tasks/someone-elses-task/docs");

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("409s when the account has no ClickUp token", async () => {
    const response = await mount(null).request(`/tasks/${TASK}/docs`);
    expect(response.status).toBe(409);
  });
});

/*
 * A 401 from ClickUp means Rask's stored token went bad, not that this
 * person's Rask session ended — and the browser signs itself out on a 401 of
 * its own. Forwarding the status would log somebody out for expanding a
 * section.
 */
test("turns a ClickUp 401 into a 502", async () => {
  const { client } = stub([{ status: 401, body: { err: "Token invalid" } }]);

  const response = await mount(client).request(`/tasks/${TASK}/docs`);

  expect(response.status).toBe(502);
});

test("turns a failed page read into a 502, not a half-rendered Doc", async () => {
  const { client } = stub([{ body: { docs: [DOC] } }, { status: 500, body: { err: "boom" } }]);

  const response = await mount(client).request(`/tasks/${TASK}/docs`);

  expect(response.status).toBe(502);
});

/**
 * `GET /docs/:id`, which is how the sidebar opens one.
 *
 * The split it exists to enforce: the name and the parent come from the
 * mirrored index, and only the pages are read live. A route that asked ClickUp
 * for the Doc as well would be a second request for something already known,
 * on every open.
 */
describe("GET /docs/:id", () => {
  const mirrored = () =>
    db.insert(docsTable).values({
      id: OPEN_DOC,
      teamId: TEAM,
      name: "AI Release notes",
      parentId: "90157146054",
      parentType: 4,
      dateUpdated: new Date(1_787_833_798_853),
    });

  test("reads the pages live and the rest from the index", async () => {
    await mirrored();
    const { client, calls } = stub([
      {
        body: [
          {
            id: "p1",
            name: "AI Release notes",
            content: "# Top",
            order_index: 1,
            pages: [{ id: "p2", name: "October 24", content: "# Later", order_index: 1 }],
          },
        ],
      },
    ]);

    const response = await mount(client).request(`/docs/${OPEN_DOC}`);
    const body = (await response.json()) as {
      doc: { name: string; updated: string; pages: Array<{ name: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.doc.name).toBe("AI Release notes");
    expect(body.doc.updated).toBe("2026-08-27T12:29:58.853Z");
    // Nested upstream, flat here, parent before child.
    expect(body.doc.pages.map((page) => page.name)).toEqual(["AI Release notes", "October 24"]);
    // One request: the whole Doc arrives at once, however many pages it has.
    expect(calls).toHaveLength(1);
  });

  test("404s a Doc the index does not hold, without spending a request", async () => {
    const { client, calls } = stub([]);

    const response = await mount(client).request("/docs/gh-not-mirrored");

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  /*
   * Scoped to the caller's workspace. Doc ids are guessable — "gh-" and five
   * digits — and without this, one belonging to another team would be fetched
   * on this caller's token and read back to them.
   */
  test("404s a Doc that belongs to another workspace", async () => {
    await db.insert(docsTable).values({
      id: OPEN_DOC,
      teamId: "some-other-team",
      name: "Not yours",
      parentType: 4,
    });
    const { client, calls } = stub([]);

    const response = await mount(client).request(`/docs/${OPEN_DOC}`);

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("turns a ClickUp failure into a 502", async () => {
    await mirrored();
    const { client } = stub([{ status: 401, body: { err: "Token invalid" } }]);

    const response = await mount(client).request(`/docs/${OPEN_DOC}`);

    expect(response.status).toBe(502);
  });
});

/**
 * What the page list carries beyond its text.
 *
 * All four of these are silent when they go wrong. A missing depth flattens a
 * Doc's shape into 25 siblings; a cover object with no image renders an
 * `<img src="">` band across the top of the page; an author who is also a
 * contributor draws the same face twice and reads as two people.
 */
describe("page presentation", () => {
  const open = async (pages: unknown) => {
    await db.insert(docsTable).values({ id: OPEN_DOC, teamId: TEAM, name: "Doc", parentType: 4 });
    const { client } = stub([{ body: pages }]);
    const body = (await (await mount(client).request(`/docs/${OPEN_DOC}`)).json()) as {
      doc: { pages: Array<Record<string, unknown>> };
    };
    return body.doc.pages;
  };

  test("keeps the nesting the pages arrived in, as a depth per page", async () => {
    const pages = await open([
      {
        id: "root",
        name: "AI Release notes",
        order_index: 1,
        pages: [
          { id: "child", name: "October 24", parent_page_id: "root", order_index: 1 },
          {
            id: "grandchild",
            name: "Detail",
            parent_page_id: "child",
            order_index: 1,
            pages: [],
          },
        ],
      },
    ]);

    // Depth is walked from `parent_page_id`, not counted from where the page
    // sat in the nesting: "Detail" arrived beside "October 24" and names it as
    // its parent, so it is a level deeper.
    expect(pages.map((page) => [page.name, page.depth])).toEqual([
      ["AI Release notes", 0],
      ["October 24", 1],
      ["Detail", 2],
    ]);
  });

  test("reads the emoji off the avatar and drops the prefix", async () => {
    const pages = await open([{ id: "p", name: "October", avatar: { value: "emoji::🎃" } }]);
    expect(pages[0]?.icon).toBe("🎃");
  });

  /*
   * Removing a cover in ClickUp leaves the object behind with only a position
   * in it. Six of the eight covers on the release-notes Doc are that.
   */
  test("a cover with no image is no cover", async () => {
    const pages = await open([
      { id: "p", name: "March", cover: { position: { x: null, y: 50_000_000 } } },
    ]);
    expect(pages[0]?.cover).toBeNull();
  });

  test("does not list an author again among the contributors", async () => {
    const pages = await open([
      { id: "p", name: "Notes", authors: [2462555], contributors: [2462555, 82787256] },
    ]);

    expect(pages[0]?.authors).toEqual(["2462555"]);
    expect(pages[0]?.contributors).toEqual(["82787256"]);
  });

  /* The chain comes from ClickUp, and a cycle in it would hang the request. */
  test("survives a parent chain that points at itself", async () => {
    const pages = await open([{ id: "p", name: "Loop", parent_page_id: "p" }]);
    expect(pages[0]?.depth).toBe(10);
  });
});

/**
 * `POST /docs/:docId/pages/:pageId/append`, the one write in this module.
 *
 * This is a write that can lose somebody's text if it is ever the wrong kind of
 * write, so what is pinned here is that it stays the safe kind. An append
 * carries only the new block: it cannot overwrite an edit made in ClickUp's own
 * editor while the page sat open, and there is no webhook for a Doc that would
 * have told Rask about one. The moment the mode reaching ClickUp is `replace`,
 * that guarantee is gone and nothing else in the system notices.
 *
 * The guard is the other half. The Doc id comes from the caller and decides
 * what this server writes on the caller's token, so an id the index does not
 * hold has to stop before a request leaves.
 */
describe("POST /docs/:docId/pages/:pageId/append", () => {
  const mirrored = () =>
    db.insert(docsTable).values({
      id: OPEN_DOC,
      teamId: TEAM,
      name: "AI Release notes",
      parentType: 4,
    });

  const append = (client: ClickUpClient | null, body: unknown, docId = OPEN_DOC) =>
    mount(client).request(`/docs/${docId}/pages/p1/append`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /*
   * The assertion this whole route exists for. `content_edit_mode` defaults to
   * `replace` upstream, so a body that stops saying `append` does not fail —
   * it replaces a 154 000-character Doc page with one paragraph, and there is
   * no delete-page endpoint to undo it with.
   */
  test("appends, and never replaces", async () => {
    await mirrored();
    const { client, calls } = stub([{ body: {} }]);

    const response = await append(client, { content: "## November 7\n\nShipped." });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toContain(`/v3/workspaces/${TEAM}/docs/${OPEN_DOC}/pages/p1`);
    expect(calls[0]?.body).toEqual({
      content: "## November 7\n\nShipped.",
      content_edit_mode: "append",
      content_format: "text/md",
    });
  });

  test("404s a Doc the index does not hold, without spending a request", async () => {
    const { client, calls } = stub([]);

    const response = await append(client, { content: "text" }, "gh-not-mirrored");

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  /*
   * The same workspace scoping the read has, and it matters more here: without
   * it a guessable Doc id belonging to another team would be *written to* on
   * this caller's token.
   */
  test("404s a Doc that belongs to another workspace", async () => {
    await db.insert(docsTable).values({
      id: OPEN_DOC,
      teamId: "some-other-team",
      name: "Not yours",
      parentType: 4,
    });
    const { client, calls } = stub([]);

    const response = await append(client, { content: "text" });

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  /*
   * Archived Docs never reach the index — `DOC_LIVE_ONLY` keeps them out of
   * both reads — so the guard above already refuses a write aimed at one. This
   * pins that the refusal is free rather than a round trip.
   */
  test("404s an archived Doc, because the index never held it", async () => {
    const { client, calls } = stub([]);

    const response = await append(client, { content: "text" }, "gh-archived");

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  /*
   * ClickUp accepts an empty content and answers 200 having done nothing, which
   * reads to the person as a write that silently vanished.
   */
  test("400s an empty entry without asking ClickUp", async () => {
    await mirrored();
    const { client, calls } = stub([]);

    expect((await append(client, { content: "" })).status).toBe(400);
    expect((await append(client, {})).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  /*
   * A refusal is the person's to read: "you do not have edit access to this
   * Doc" is what they will actually hit, and it is not something a retry fixes.
   */
  test("turns a ClickUp refusal into a 422 carrying its message", async () => {
    await mirrored();
    const { client } = stub([{ status: 403, body: { err: "You do not have edit access" } }]);

    const response = await append(client, { content: "text" });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(422);
    expect(body.error).toContain("You do not have edit access");
  });

  /*
   * The one status that must never come back out. A 401 from ClickUp means
   * Rask's stored token has gone bad; the browser reads a 401 of its own as its
   * session ending and signs the person out over an entry they tried to add.
   */
  test("turns a ClickUp 401 into a 502, never a 401", async () => {
    await mirrored();
    const { client } = stub([{ status: 401, body: { err: "Token invalid" } }]);

    expect((await append(client, { content: "text" })).status).toBe(502);
  });

  test("502s a ClickUp outage", async () => {
    await mirrored();
    const { client } = stub([{ status: 500, body: { err: "boom" } }]);

    expect((await append(client, { content: "text" })).status).toBe(502);
  });

  test("409s when the session has no ClickUp token", async () => {
    await mirrored();

    expect((await append(null, { content: "text" })).status).toBe(409);
  });
});

/**
 * `POST /docs/:docId/pages`, the second additive write.
 *
 * A create cannot lose anything by construction — it addresses a page that does
 * not exist yet — so what is pinned here is the guard and the body. The guard
 * is the same one the append has, and it matters for the same reason: a Doc id
 * arrives from the caller and decides what this server writes on the caller's
 * token.
 *
 * The body is the half that is easy to get quietly wrong. `name`, `sub_title`
 * and `content` all default to `""` upstream, so any key present is a field
 * being written, and `parent_page_id` has to be absent rather than null for a
 * page at the Doc's root.
 */
describe("POST /docs/:docId/pages", () => {
  const mirrored = () =>
    db.insert(docsTable).values({
      id: OPEN_DOC,
      teamId: TEAM,
      name: "AI Release notes",
      parentType: 4,
    });

  const CREATED = { id: "p9", doc_id: OPEN_DOC, name: "November 21 - 2025", content: "" };

  const create = (client: ClickUpClient | null, body: unknown, docId = OPEN_DOC) =>
    mount(client).request(`/docs/${docId}/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("creates the page under the parent the reader named, and answers its id", async () => {
    await mirrored();
    const { client, calls } = stub([{ status: 201, body: CREATED }]);

    const response = await create(client, { name: "November 21 - 2025", parentId: "root" });
    const body = (await response.json()) as { id: string };

    expect(response.status).toBe(201);
    expect(body.id).toBe("p9");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain(`/v3/workspaces/${TEAM}/docs/${OPEN_DOC}/pages`);
    expect(calls[0]?.body).toEqual({ name: "November 21 - 2025", parent_page_id: "root" });
  });

  test("omits the parent for a page at the Doc's root", async () => {
    await mirrored();
    const { client, calls } = stub([{ status: 201, body: CREATED }]);

    await create(client, { name: "Top" });

    expect(calls[0]?.body).toEqual({ name: "Top" });
  });

  test("404s a Doc the index does not hold, without spending a request", async () => {
    const { client, calls } = stub([]);

    const response = await create(client, { name: "Top" }, "gh-not-mirrored");

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("404s a Doc that belongs to another workspace", async () => {
    await db.insert(docsTable).values({
      id: OPEN_DOC,
      teamId: "some-other-team",
      name: "Not yours",
      parentType: 4,
    });
    const { client, calls } = stub([]);

    const response = await create(client, { name: "Top" });

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  /*
   * ClickUp accepts an empty name and stores a page called "", which the index
   * then draws as a row with nothing in it and no way to tell which page it is.
   */
  test("400s a nameless page without asking ClickUp", async () => {
    await mirrored();
    const { client, calls } = stub([]);

    expect((await create(client, { name: "" })).status).toBe(400);
    expect((await create(client, { name: "   " })).status).toBe(400);
    expect((await create(client, {})).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("turns a ClickUp refusal into a 422 carrying its message", async () => {
    await mirrored();
    const { client } = stub([{ status: 403, body: { err: "You do not have edit access" } }]);

    const response = await create(client, { name: "Top" });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(422);
    expect(body.error).toContain("You do not have edit access");
  });

  test("turns a ClickUp 401 into a 502, never a 401", async () => {
    await mirrored();
    const { client } = stub([{ status: 401, body: { err: "Token invalid" } }]);

    expect((await create(client, { name: "Top" })).status).toBe(502);
  });

  test("409s when the session has no ClickUp token", async () => {
    await mirrored();

    expect((await create(null, { name: "Top" })).status).toBe(409);
  });
});

/**
 * A nested page's depth, which is what the index indents by.
 *
 * `getDocPages` flattens, and `parent_page_id` is all that survives the
 * flattening to say what the shape was. A sub-page that arrives nested and
 * carries no `parent_page_id` of its own would come out at depth 0 and draw as
 * a sibling of the page it lives inside — a Doc that quietly looks flatter than
 * it is. The client fills the parent in from the nesting; this is the half of
 * that which the browser actually sees.
 */
describe("nested page depth", () => {
  test("indents a child that only the nesting identified as one", async () => {
    await db.insert(docsTable).values({ id: OPEN_DOC, teamId: TEAM, name: "Doc", parentType: 4 });
    const { client } = stub([
      {
        body: [
          {
            id: "root",
            name: "AI Release notes",
            order_index: 1,
            pages: [{ id: "nov", name: "November 7", order_index: 1 }],
          },
        ],
      },
    ]);

    const body = (await (await mount(client).request(`/docs/${OPEN_DOC}`)).json()) as {
      doc: { pages: Array<{ id: string; depth: number }> };
    };

    expect(body.doc.pages.map((page) => [page.id, page.depth])).toEqual([
      ["root", 0],
      ["nov", 1],
    ]);
  });
});
