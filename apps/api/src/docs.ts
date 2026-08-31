import type { ClickUpClient, ClickUpDoc, ClickUpDocPage } from "@rask/clickup-client";
import { docPageIcon } from "@rask/clickup-client";
import { isPlaceholder } from "@rask/clickup-client/vocabulary";
import { type Db, docs, tasks } from "@rask/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "./auth.ts";
import { upstream } from "./upstream.ts";

/**
 * The Docs written inside a task, read live from ClickUp.
 *
 * Not mirrored, for the reason time tracking is not: the mirror earns its keep
 * on rows the whole workspace reads, sorts and filters, and a Doc is none of
 * those — nothing in Rask groups by it or searches it. Mirroring would cost two
 * tables, an ingest, a poll cursor and a reconcile pass, and ClickUp emits no
 * webhook for a Doc at all, so every one of those would be paid to keep a body
 * of text fresh that one person reads once. Live is two requests, and they are
 * only spent when somebody expands the section.
 *
 * This is also the only place Rask touches ClickUp's v3 API. See
 * `searchDocs` for why that needs no separate client.
 *
 * The two writes here — appending to a page, and creating one — go straight
 * through to ClickUp rather than into the outbox, for a reason that follows
 * from all of the above. The outbox exists so a write can be *shown* before it
 * lands: the mirror is updated and a row queued in one transaction, and the
 * browser paints from the mirror. No Doc body is mirrored, so there is nothing
 * to paint optimistically and nothing for the worker to repair when ClickUp
 * refuses — and the outbox's retry would append the same paragraph twice, which
 * is the argument `time.ts` makes about starting the same timer twice. So they
 * wait for ClickUp, as the attachment upload does.
 *
 * Both are additive, and that is the design rather than a coincidence. An
 * append carries only the new block and a create addresses a page that does not
 * exist yet, so neither has a stale copy of anything in flight and neither can
 * overwrite what somebody wrote in ClickUp's own editor in the meantime — which
 * matters because there is no webhook for a Doc to tell us they did.
 * `docs/doc-editing.md` has the rest, including what whole-body replace is
 * waiting on.
 */

type Env = { Variables: { user: SessionUser } };

export interface DocsDeps {
  db: Db;
  clientFor: (userId: string) => Promise<ClickUpClient | null>;
}

/** One page of a Doc, with its body already in markdown. */
export interface DocPageDto {
  id: string;
  name: string;
  /** Markdown. Empty for a page somebody created and never wrote in. */
  content: string;
  /**
   * How deep this page sits, 0 for a top-level one.
   *
   * The pages arrive flat and in reading order; this is what lets an index
   * redraw the shape they came in. Sent as a number rather than a nested array
   * because every consumer walks them in order anyway, and a tree would mean
   * two ways to say the same thing.
   */
  depth: number;
  /**
   * The page this one hangs off, or null at the root of the Doc.
   *
   * `depth` says how far in to indent it; this says what it is indented *under*,
   * which is what a new sibling needs to be created with. The two are not the
   * same answer: depth is derived and collapses to 0 for a parent the walk
   * never saw, and creating a page under "whatever was at depth 0" would put it
   * somewhere nobody pointed at.
   */
  parentId: string | null;
  /** The page's emoji, when it has one. */
  icon: string | null;
  /** Banner across the top of the page. A public ClickUp attachments URL. */
  cover: string | null;
  /** ISO 8601, like every other instant this API sends. */
  updated: string | null;
  /** ClickUp user ids: who wrote it, and who has edited it since. */
  authors: string[];
  contributors: string[];
}

export interface DocDto {
  id: string;
  name: string;
  /** ISO 8601, or null on a Doc ClickUp gave no update time. */
  updated: string | null;
  pages: DocPageDto[];
}

/**
 * The page list, flat and in reading order, each one knowing how deep it sits
 * and what it sits under.
 *
 * Depth is walked from `parent_page_id` rather than counted while flattening,
 * so a page whose parent ClickUp did not include still lands somewhere sane:
 * unknown parent means depth 0, at the top, rather than lost. The cap is there
 * because the chain comes from ClickUp and a cycle in it would hang the
 * request.
 *
 * `parentId` is that same field passed through untouched, and the two are not
 * interchangeable: depth is derived and collapses to 0 for a parent the walk
 * never saw, so creating a page under "whatever was at depth 0" would file it
 * somewhere nobody pointed at.
 */
function toPages(pages: ClickUpDocPage[]): DocPageDto[] {
  const parentOf = new Map(pages.map((page) => [page.id, page.parent_page_id ?? null]));

  const depthOf = (id: string): number => {
    let depth = 0;
    let parent = parentOf.get(id) ?? null;
    while (parent && depth < 10) {
      depth++;
      parent = parentOf.get(parent) ?? null;
    }
    return depth;
  };

  return pages.map((page) => ({
    id: page.id,
    name: page.name?.trim() || "Untitled",
    content: page.content ?? "",
    depth: depthOf(page.id),
    parentId: page.parent_page_id ?? null,
    icon: docPageIcon(page),
    cover: page.cover?.image_url ?? null,
    updated: page.date_updated?.toISOString() ?? null,
    authors: (page.authors ?? []).map(String),
    /*
     * Minus the authors. ClickUp lists a person in both when they wrote the
     * page and came back to it, and a header that draws the same face twice
     * reads as two people having worked on it.
     */
    contributors: (page.contributors ?? [])
      .map(String)
      .filter((id) => !(page.authors ?? []).map(String).includes(id)),
  }));
}

function toDto(doc: ClickUpDoc, pages: ClickUpDocPage[]): DocDto {
  return {
    // ClickUp allows an unnamed Doc and shows it as "Doc". Naming it here
    // rather than in the panel keeps the fallback in one place.
    name: doc.name?.trim() || "Doc",
    id: doc.id,
    updated: doc.date_updated?.toISOString() ?? null,
    pages: toPages(pages),
  };
}

/**
 * What an append is allowed to carry.
 *
 * Capped at a comment rather than at a description: this is one entry being
 * added to a page, not the page. Empty is refused because ClickUp accepts it
 * and answers 200 having done nothing, which reads to the user as a write that
 * silently failed.
 */
const appendInput = z.object({ content: z.string().trim().min(1).max(50_000) });

/**
 * What a new page is allowed to carry.
 *
 * A name and where to hang it, and nothing else. The body a page is born with
 * is left to the append route: one endpoint per shape of change means a page
 * cannot be created and overwritten in the same request, and there is nothing
 * here that has to decide between the two.
 *
 * An empty name is refused because ClickUp accepts one and stores a page called
 * "" that the index then draws as a blank row.
 */
const newPageInput = z.object({
  name: z.string().trim().min(1).max(255),
  /** The page the new one hangs off. Absent makes it a page at the Doc's root. */
  parentId: z.string().min(1).optional(),
});

export function docsRoutes(deps: DocsDeps) {
  const { db, clientFor } = deps;
  const app = new Hono<Env>();

  /**
   * Whether this caller is allowed to write to this Doc at all.
   *
   * The id arrives from the caller and decides what this server writes on the
   * caller's token, so it is checked against the mirrored index before a
   * request leaves — the same guard the reads make, scoped to the workspace for
   * the same reason: Doc ids are guessable, "gh-" and five digits, and without
   * the team check one belonging to somebody else would be written to.
   *
   * It refuses an archived Doc for free. `DOC_LIVE_ONLY` keeps archived and
   * deleted Docs out of both reads, so one never reaches the index.
   */
  const writable = async (docId: string, teamId: string): Promise<boolean> => {
    const [row] = await db
      .select({ id: docs.id })
      .from(docs)
      .where(and(eq(docs.id, docId), eq(docs.teamId, teamId)))
      .limit(1);
    return row !== undefined;
  };

  /**
   * Every Doc on one task, contents included.
   *
   * One request to find them, then one per Doc for its pages, in parallel.
   * Almost every task has none — that is one request and an empty array — and
   * the tasks that do have one have exactly one.
   *
   * The task is checked against the mirror before any of that, for the reason
   * the time routes check theirs: the id arrives from the caller and decides
   * what this server then asks ClickUp about on the caller's token.
   */
  app.get("/tasks/:id/docs", async (c) => {
    const user = c.get("user");
    const taskId = c.req.param("id");

    // A task ClickUp has never seen holds no Docs, and asking would 404.
    if (isPlaceholder(taskId)) return c.json({ docs: [] });

    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!task) return c.json({ error: "not found" }, 404);

    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    try {
      const docs = await client.searchDocs(user.teamId, {
        parentId: taskId,
        parentType: "TASK",
      });

      const withPages = await Promise.all(
        docs.map(async (doc) => toDto(doc, await client.getDocPages(user.teamId, doc.id))),
      );

      return c.json({ docs: withPages });
    } catch (error) {
      /*
       * Never the status ClickUp gave. A 401 from there means Rask's stored
       * token has gone bad, and the browser reads a 401 of its own as its
       * session ending and signs the person out of Rask over a section they
       * expanded. The timesheet answers the same way for the same reason.
       */
      const message = error instanceof Error ? error.message : "ClickUp call failed";
      return c.json({ error: message }, 502);
    }
  });

  /**
   * One Doc by id, contents included.
   *
   * The id is checked against the mirrored index rather than passed through,
   * for the reason the task route checks its task: it decides what this server
   * fetches on the caller's token. The index is also what supplies the name —
   * `GET /docs/{id}` would say the same thing for another request.
   *
   * Only the pages are live. That split is the whole design: the index is
   * cheap, shared and refreshed with the hierarchy; the body is read once by
   * one person and never stored.
   */
  app.get("/docs/:id", async (c) => {
    const user = c.get("user");
    const docId = c.req.param("id");

    const [row] = await db
      .select({ id: docs.id, name: docs.name, dateUpdated: docs.dateUpdated })
      .from(docs)
      .where(and(eq(docs.id, docId), eq(docs.teamId, user.teamId)))
      .limit(1);
    if (!row) return c.json({ error: "not found" }, 404);

    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    try {
      const pages = await client.getDocPages(user.teamId, row.id);
      const doc: DocDto = {
        id: row.id,
        name: row.name,
        updated: row.dateUpdated?.toISOString() ?? null,
        pages: toPages(pages),
      };
      return c.json({ doc });
    } catch (error) {
      const message = error instanceof Error ? error.message : "ClickUp call failed";
      return c.json({ error: message }, 502);
    }
  });

  /**
   * Adds a block to the end of a page.
   *
   * A route that can only append, rather than a PUT carrying the mode it wants.
   * The name is the safety property: there is no string a client can send that
   * turns this into a replace, and replace is the one that loses text — both
   * somebody's concurrent edit, since a Doc has no webhook to warn us, and
   * whatever the markdown round trip cannot spell. ClickUp says that second
   * part itself, in `getPagePublic`'s own description.
   *
   * The Doc goes through `writable` first. The page id cannot be checked,
   * because pages are not mirrored — the blast radius is a page inside a Doc
   * the caller has already proved they can read.
   *
   * Nothing is echoed back. The browser re-reads the Doc, which is one ClickUp
   * request either way and repaints from ClickUp's own rendering of what it
   * stored rather than from an optimistic guess — the point of not mirroring
   * the body in the first place.
   */
  app.post("/docs/:docId/pages/:pageId/append", async (c) => {
    const user = c.get("user");
    const docId = c.req.param("docId");
    const pageId = c.req.param("pageId");

    const body = appendInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

    if (!(await writable(docId, user.teamId))) return c.json({ error: "not found" }, 404);

    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    try {
      await client.appendToDocPage(user.teamId, docId, pageId, body.data.content);
    } catch (error) {
      // 4xx that is not 401 is an answer the person should read — "you do not
      // have edit access to this Doc" is the one they will actually hit.
      const { status, error: message } = upstream(error);
      return c.json({ error: message }, status);
    }

    return c.json({ ok: true });
  });

  /**
   * A new page in a Doc that already exists.
   *
   * The other half of writing into a Doc without writing over one. A create
   * addresses a page that does not exist yet, so like an append it cannot lose
   * anything, and between them they cover what the release notes Doc actually
   * does — its 24 dated entries are child pages of one root page, not blocks
   * appended to a running one.
   *
   * `parentId` comes from the caller because the browser is the only one that
   * knows which page the person was standing on when they asked. It is not
   * checked: pages are not mirrored, and a wrong one inside a Doc the caller
   * has already proved they can read only misfiles a page they could have
   * created anyway.
   *
   * Answers with the new page's id and nothing else. The browser refetches the
   * Doc to see it in place — a created page has no siblings to be ordered among
   * or indented under until the Doc is read again, so anything more shaped than
   * an id would be a `depth` this route had to invent.
   */
  app.post("/docs/:docId/pages", async (c) => {
    const user = c.get("user");
    const docId = c.req.param("docId");

    const body = newPageInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

    if (!(await writable(docId, user.teamId))) return c.json({ error: "not found" }, 404);

    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    try {
      const page = await client.createDocPage(user.teamId, docId, {
        name: body.data.name,
        ...(body.data.parentId ? { parentPageId: body.data.parentId } : {}),
      });
      return c.json({ id: page.id }, 201);
    } catch (error) {
      const { status, error: message } = upstream(error);
      return c.json({ error: message }, status);
    }
  });

  return app;
}
