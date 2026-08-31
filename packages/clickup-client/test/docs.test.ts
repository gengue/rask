import { describe, expect, test } from "bun:test";
import { ClickUpClient } from "../src/client.ts";
import { RateLimiter } from "../src/rate-limit.ts";

/**
 * The Docs endpoints, which are the only v3 calls in the client.
 *
 * What is worth pinning here is the wire, not the parsing. Every one of these
 * three query parameters is a silent-wrong when it goes missing: no
 * `parent_type` and the search answers with somebody else's Docs, no
 * `max_page_depth` and a nested page comes back named but empty, no
 * `content_format` and the body arrives as HTML that the markdown renderer
 * shows as source. None of those throw, and none of them look broken in a
 * screenshot of a one-page Doc.
 */

function makeClient(responses: Array<{ status?: number; body: unknown }>) {
  const calls: string[] = [];
  const sent: Array<{ method: string; body: unknown }> = [];
  const queue = [...responses];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    sent.push({
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
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

  return { client, calls, sent };
}

/** The shape the live workspace answers with, trimmed to what is read. */
const DOC = {
  id: "gh-96615",
  name: "Flights inbox",
  parent: { id: "86cb4ckva", type: 1 },
  date_created: 1_786_731_888_405,
  date_updated: 1_787_833_798_853,
  creator: 82_591_240,
  deleted: false,
};

describe("searchDocs", () => {
  test("asks v3 for one task's Docs, by the name of the parent type", async () => {
    const { client, calls } = makeClient([{ body: { docs: [DOC], next_cursor: null } }]);

    await client.searchDocs("529", { parentId: "86cb4ckva", parentType: "TASK" });

    const url = new URL(calls[0] ?? "");
    // `/api` comes from the base and `/v3` from the path, which is the whole
    // reason v3 needs no client of its own.
    expect(url.pathname).toBe("/api/v3/workspaces/529/docs");
    expect(url.searchParams.get("parent_id")).toBe("86cb4ckva");
    expect(url.searchParams.get("parent_type")).toBe("TASK");
  });

  /*
   * The value the vendored spec does not document.
   *
   * `PublicDocsParentDto` lists 4, 5, 6, 7 and 12 and omits 1, which is the
   * one every Doc written inside a task comes back with. A schema that
   * enumerated the documented set would reject the common case.
   */
  test("keeps a parent type the spec never mentions", async () => {
    const { client } = makeClient([{ body: { docs: [DOC] } }]);

    const [doc] = await client.searchDocs("529", { parentId: "86cb4ckva", parentType: "TASK" });

    expect(doc?.parent?.type).toBe(1);
    expect(doc?.parent?.id).toBe("86cb4ckva");
  });

  test("reads an answer with no docs key as no docs", async () => {
    const { client } = makeClient([{ body: { next_cursor: null } }]);
    expect(await client.searchDocs("529", { parentId: "t1", parentType: "TASK" })).toEqual([]);
  });
});

describe("getDocPages", () => {
  test("asks for every level, in markdown", async () => {
    const { client, calls } = makeClient([{ body: [] }]);

    await client.getDocPages("529", "gh-96615");

    const url = new URL(calls[0] ?? "");
    expect(url.pathname).toBe("/api/v3/workspaces/529/docs/gh-96615/pages");
    // -1 is "every level". The default walks one and returns the rest empty.
    expect(url.searchParams.get("max_page_depth")).toBe("-1");
    expect(url.searchParams.get("content_format")).toBe("text/md");
  });

  test("returns siblings in order_index order, which is sparse", async () => {
    const { client } = makeClient([
      {
        body: [
          { id: "b", name: "Second", content: "two", order_index: 3 },
          { id: "a", name: "First", content: "one", order_index: 1 },
        ],
      },
    ]);

    const pages = await client.getDocPages("529", "d1");

    expect(pages.map((page) => page.id)).toEqual(["a", "b"]);
  });

  /*
   * The workspace answered flat both times it was asked, but the spec declares
   * `pages` on a page and a sub-page that never renders is not a failure
   * anybody reports — it is a Doc that quietly looks shorter than it is.
   */
  test("flattens a sub-page into reading order rather than dropping it", async () => {
    const { client } = makeClient([
      {
        body: [
          {
            id: "parent",
            name: "Parent",
            content: "top",
            order_index: 1,
            pages: [{ id: "child", name: "Child", content: "nested", order_index: 1 }],
          },
          { id: "sibling", name: "Sibling", content: "after", order_index: 2 },
        ],
      },
    ]);

    const pages = await client.getDocPages("529", "d1");

    // Parent, then its child, then the next sibling: what the Doc reads like.
    expect(pages.map((page) => page.id)).toEqual(["parent", "child", "sibling"]);
    expect(pages.map((page) => page.content)).toEqual(["top", "nested", "after"]);
    // Flattened, not nested-and-also-listed: rendering both would print the
    // child's body twice.
    expect(pages.every((page) => !("pages" in page))).toBe(true);
  });

  /*
   * Flattening throws the shape away, and `parent_page_id` is all that is left
   * to rebuild it from — the reader indents by it and a new page is created as
   * a sibling under it. A nested child that arrived without one would draw flat
   * and file its siblings at the root of the Doc.
   */
  test("gives a nested child the parent the nesting implied", async () => {
    const { client } = makeClient([
      {
        body: [
          {
            id: "root",
            name: "Parent",
            order_index: 1,
            pages: [{ id: "child", name: "Child", order_index: 1 }],
          },
        ],
      },
    ]);

    const pages = await client.getDocPages("529", "d1");

    expect(pages.map((page) => [page.id, page.parent_page_id])).toEqual([
      ["root", null],
      ["child", "root"],
    ]);
  });

  test("leaves a parent ClickUp named alone", async () => {
    const { client } = makeClient([
      { body: [{ id: "a", name: "A", parent_page_id: "elsewhere", order_index: 1 }] },
    ]);

    const pages = await client.getDocPages("529", "d1");

    expect(pages[0]?.parent_page_id).toBe("elsewhere");
  });
});

describe("listAllDocs", () => {
  test("follows the cursor to the end and returns one flat set", async () => {
    const { client, calls } = makeClient([
      { body: { docs: [DOC, { ...DOC, id: "a" }], next_cursor: "page2" } },
      { body: { docs: [{ ...DOC, id: "b" }], next_cursor: null } },
    ]);

    const all = await client.listAllDocs("529");

    expect(all.map((doc) => doc.id)).toEqual(["gh-96615", "a", "b"]);
    // The first call carries no cursor; the second carries the one it was given.
    expect(new URL(calls[0] ?? "").searchParams.get("cursor")).toBeNull();
    expect(new URL(calls[1] ?? "").searchParams.get("cursor")).toBe("page2");
  });

  test("asks for every kind of Doc, not one parent type at a time", async () => {
    const { client, calls } = makeClient([{ body: { docs: [] } }]);

    await client.listAllDocs("529");

    // A `parent_type` here would be five walks for the answer one gives, and
    // the rows carry their own parent anyway.
    expect(new URL(calls[0] ?? "").searchParams.get("parent_type")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  /*
   * The cursor is ClickUp's, and the loop's exit depends on it eventually
   * coming back empty. A server that always answers with one would otherwise
   * spend the whole shared rate budget in a single sync.
   */
  test("stops rather than following a cursor that never ends", async () => {
    const endless = Array.from({ length: 200 }, () => ({
      body: { docs: [DOC], next_cursor: "always" },
    }));
    const { client, calls } = makeClient(endless);

    await client.listAllDocs("529");

    expect(calls.length).toBeLessThanOrEqual(50);
  });
});

describe("archived Docs", () => {
  /*
   * Both reads say it, so this asserts the index walk and the task search
   * together: `archived` and `deleted` default to false in the spec and today
   * on the live endpoint, but this is v3, whose documented enums have already
   * been short one value the workspace uses. An archived Doc that came back
   * anyway would be indexed as live — the list response omits the `archived`
   * field, so `mapDoc` reads it as false — and sit in the sidebar.
   */
  test("asks only for Docs that are neither archived nor deleted", async () => {
    const { client, calls } = makeClient([{ body: { docs: [] } }, { body: { docs: [] } }]);

    await client.listAllDocs("529");
    await client.searchDocs("529", { parentId: "86cb4ckva", parentType: "TASK" });

    for (const call of calls) {
      const query = new URL(call).searchParams;
      expect(query.get("archived")).toBe("false");
      expect(query.get("deleted")).toBe("false");
    }
    expect(calls).toHaveLength(2);
  });
});

describe("appendToDocPage", () => {
  /*
   * The mode is the whole safety property of this method, so it is the thing
   * worth pinning. `content_edit_mode` defaults to `replace` in the spec, which
   * means a body that forgets to say `append` does not fail — it silently
   * overwrites the page with the one paragraph somebody meant to add to it.
   * The only thing that undoes that is deleting the page, and no webhook would
   * have told Rask the page changed under it in the first place.
   */
  test("sends the block as an append, in markdown, and never as a replace", async () => {
    const { client, calls, sent } = makeClient([{ body: {} }]);

    await client.appendToDocPage("529", "gh-96615", "p1", "## November 7\n\nShipped.");

    expect(new URL(calls[0] ?? "").pathname).toBe("/api/v3/workspaces/529/docs/gh-96615/pages/p1");
    expect(sent[0]?.method).toBe("PUT");
    expect(sent[0]?.body).toEqual({
      content: "## November 7\n\nShipped.",
      content_edit_mode: "append",
      content_format: "text/md",
    });
  });

  /*
   * No `name` and no `sub_title`. Both are writable on this endpoint and both
   * default to `""` in the spec, so sending the object with either key present
   * and empty would rename the page to nothing as a side effect of adding a
   * paragraph to it.
   */
  test("touches nothing but the content", async () => {
    const { client, sent } = makeClient([{ body: {} }]);

    await client.appendToDocPage("529", "d1", "p1", "text");

    const body = sent[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["content", "content_edit_mode", "content_format"]);
  });

  test("throws on a refusal rather than reporting a write that did not happen", async () => {
    const { client } = makeClient([{ status: 403, body: { err: "no edit access" } }]);

    await expect(client.appendToDocPage("529", "d1", "p1", "text")).rejects.toThrow();
  });
});

describe("createDocPage", () => {
  const CREATED = { id: "p9", doc_id: "gh-96615", name: "November 21 - 2025", content: "" };

  test("posts the new page under the parent it was given", async () => {
    const { client, calls, sent } = makeClient([{ status: 201, body: CREATED }]);

    const page = await client.createDocPage("529", "gh-96615", {
      name: "November 21 - 2025",
      parentPageId: "root",
    });

    expect(new URL(calls[0] ?? "").pathname).toBe("/api/v3/workspaces/529/docs/gh-96615/pages");
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.body).toEqual({ name: "November 21 - 2025", parent_page_id: "root" });
    expect(page.id).toBe("p9");
  });

  /*
   * Absent, not null. `parent_page_id` is documented as simply missing on a
   * page at the root of a Doc, and this is the v3 surface — the one whose
   * parent-type enum turned out to be short a value the workspace uses. Sending
   * it a shape it never described is how that bites.
   */
  test("omits the parent entirely for a page at the Doc's root", async () => {
    const { client, sent } = makeClient([{ status: 201, body: CREATED }]);

    await client.createDocPage("529", "gh-96615", { name: "Top" });

    expect(sent[0]?.body).toEqual({ name: "Top" });
    expect(Object.keys(sent[0]?.body as object)).not.toContain("parent_page_id");
  });

  /*
   * `name`, `sub_title` and `content` all default to `""` upstream, so every
   * key present is a field being written. A body that carried `sub_title` empty
   * would blank the subtitle of a page as a side effect of naming it.
   */
  test("writes nothing it was not asked to write", async () => {
    const { client, sent } = makeClient([{ status: 201, body: CREATED }]);

    await client.createDocPage("529", "gh-96615", { name: "Top", parentPageId: "root" });

    expect(Object.keys(sent[0]?.body as object).sort()).toEqual(["name", "parent_page_id"]);
  });

  test("throws on a refusal rather than reporting a page that does not exist", async () => {
    const { client } = makeClient([{ status: 403, body: { err: "no edit access" } }]);

    await expect(client.createDocPage("529", "d1", { name: "Top" })).rejects.toThrow();
  });
});

/**
 * The one call in this client that destroys text, and the one endpoint that is
 * not in `openapi/clickup-v3.json` at all.
 *
 * Both halves are pinned because nothing else would catch either drifting. The
 * path has no spec entry to check it against — it was read off a live 204 —
 * and the 204 itself is unique here: every other endpoint answers with a body,
 * so `request` grew a branch for this one and a regression in it would look
 * like a delete that failed while the page was already gone.
 */
describe("deleteDocPage", () => {
  test("addresses the page on v3, and treats an empty 204 as the success it is", async () => {
    const { client, calls, sent } = makeClient([{ status: 204, body: undefined }]);

    await client.deleteDocPage("529", "gh-96615", "p1");

    expect(new URL(calls[0] ?? "").pathname).toBe("/api/v3/workspaces/529/docs/gh-96615/pages/p1");
    expect(sent[0]?.method).toBe("DELETE");
    expect(sent[0]?.body).toBeNull();
  });

  test("throws on a refusal rather than reporting a page that is still there", async () => {
    const { client } = makeClient([{ status: 403, body: { err: "no edit access" } }]);

    await expect(client.deleteDocPage("529", "gh-96615", "p1")).rejects.toThrow();
  });
});
