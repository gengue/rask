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
 * The one write here goes straight through to ClickUp rather than into the
 * outbox, and for a reason that follows from all of the above. The outbox
 * exists so a write can be *shown* before it lands: the mirror is updated and
 * a row queued in one transaction, and the browser paints from the mirror. No
 * Doc body is mirrored, so there is nothing to paint optimistically and
 * nothing for the worker to repair when ClickUp refuses — and the outbox's
 * retry would append the same paragraph twice, which is the argument `time.ts`
 * makes about starting the same timer twice. So it waits for ClickUp, as the
 * attachment upload does. `docs/doc-editing.md` has the rest, including why
 * whole-body replace is not here.
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
 * The page list, flat and in reading order, each one knowing how deep it sits.
 *
 * Depth is walked from `parent_page_id` rather than counted while flattening,
 * so a page whose parent ClickUp did not include still lands somewhere sane:
 * unknown parent means depth 0, at the top, rather than lost. The cap is there
 * because the chain comes from ClickUp and a cycle in it would hang the
 * request.
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
const appendInput = z.object({ content: z.string().min(1).max(50_000) });

export function docsRoutes(deps: DocsDeps) {
  const { db, clientFor } = deps;
  const app = new Hono<Env>();

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
   * The Doc is checked against the mirrored index first, exactly as the read
   * above checks it and for the same reason: the id arrives from the caller and
   * decides what this server writes on the caller's token. That also refuses an
   * archived Doc for free — `DOC_LIVE_ONLY` keeps archived and deleted Docs out
   * of both reads, so one never reaches the index and a write aimed at it
   * answers 404 without a request leaving the machine.
   *
   * The page id cannot be checked, because pages are not mirrored. The blast
   * radius is a page inside a Doc the caller has already proved they can read.
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

    const [row] = await db
      .select({ id: docs.id })
      .from(docs)
      .where(and(eq(docs.id, docId), eq(docs.teamId, user.teamId)))
      .limit(1);
    if (!row) return c.json({ error: "not found" }, 404);

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

  return app;
}
