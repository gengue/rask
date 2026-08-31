import type { ClickUpClient, ClickUpDoc, ClickUpList } from "@rask/clickup-client";
import {
  type Db,
  ingestComments,
  ingestTasks,
  mapDoc,
  replaceDocs,
  syncCursors,
  tasks,
  upsertFolders,
  upsertLists,
  upsertSpaces,
} from "@rask/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

export interface SyncStats {
  requests: number;
  tasks: number;
  changed: number;
  ms: number;
}

/**
 * Mirrors the Space/Folder/List tree. Cheap (1 + 2n requests for n spaces, plus
 * one per folderless List that overrides its statuses) and a prerequisite for
 * everything else, since list ids drive task sync.
 */
export async function syncHierarchy(
  db: Db,
  client: ClickUpClient,
  teamId: string,
): Promise<SyncStats> {
  const started = Date.now();
  const tree = await client.getWorkspaceHierarchy(teamId);
  let extra = 0;

  await upsertSpaces(
    db,
    tree.map((t) => t.space),
    teamId,
  );

  for (const { space, folders, lists: folderless } of tree) {
    await upsertFolders(db, folders, space.id);
    const readable = await Promise.all(
      folderless.map(async (list) => {
        if (!list.override_statuses) return list;
        extra++;
        return readStatuses(client, list);
      }),
    );
    await upsertLists(
      db,
      readable.filter((list) => list !== null),
      { spaceId: space.id, folderId: null },
    );
    for (const folder of folders) {
      await upsertLists(db, folder.lists, { spaceId: space.id, folderId: folder.id });
    }
  }

  /*
   * The Doc index rides along with the tree, because it is the same kind of
   * thing: names and parents that the sidebar needs all at once, refreshed on
   * the same schedule. It is deliberately last — a workspace whose Docs cannot
   * be read still gets its Spaces, Folders and Lists, which is what task sync
   * depends on.
   *
   * A failure here is warned about and swallowed for that reason. There is no
   * webhook for a Doc, so the next hierarchy pass is the retry.
   */
  const docs = await readDocIndex(client, teamId);
  if (docs)
    await replaceDocs(
      db,
      teamId,
      docs.map((doc) => mapDoc(doc, teamId)),
    );

  return {
    // The index costs at least one request even when it comes back empty.
    requests: 1 + tree.length * 2 + extra + (docs ? Math.max(1, Math.ceil(docs.length / 100)) : 0),
    tasks: 0,
    changed: 0,
    ms: Date.now() - started,
  };
}

/**
 * The workspace's Docs, or null if ClickUp would not say.
 *
 * Null rather than an empty array, and the caller checks: `replaceDocs` deletes
 * every row it was not given, so handing it `[]` on a failed read would empty
 * the sidebar of Docs and look exactly like a workspace that has none.
 */
async function readDocIndex(client: ClickUpClient, teamId: string): Promise<ClickUpDoc[] | null> {
  try {
    return await client.listAllDocs(teamId);
  } catch (error) {
    console.warn("[sync] doc index:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Re-reads a folderless List that overrides its Space, for the set itself.
 *
 * `GET /space/{id}/list` carries `override_statuses: true` and no `statuses`,
 * so the tree walk alone cannot say what those statuses are -- and every status
 * picker fell back to the Space's set, which for an overriding List is names it
 * does not have and none of the ones it does. Lists inside a Folder come with
 * the effective set inlined, so this is only ever the folderless overriders:
 * one request each, none at all for a workspace without any.
 *
 * Null on failure, and the caller leaves that List out of the pass rather than
 * writing the shallow row: `upsertLists` sets every column it names, so a row
 * with no statuses blanks the set already mirrored and puts the picker straight
 * back on the Space's -- the bug this exists to fix, reintroduced by a 500. The
 * rest of the tree still lands, and the next sync tries again. The cost is that
 * a List that is both new and unreadable waits a cycle to appear at all, which
 * is the rarer half of a case that is already an outage.
 */
async function readStatuses(client: ClickUpClient, list: ClickUpList): Promise<ClickUpList | null> {
  try {
    return await client.getList(list.id);
  } catch (error) {
    console.warn(
      `[sync] statuses for list ${list.id}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Pulls a list's tasks into the mirror.
 *
 * Incremental by default: `date_updated_gt` is the newest ClickUp mtime we have
 * already stored, so a quiet list costs exactly one request. Pages arrive
 * oldest first and the cursor advances only after one commits, so an error
 * halfway down a long list resumes from where it stopped rather than skipping
 * what it never read.
 *
 * `full: true` ignores the cursor. That is what a manual resync and the nightly
 * reconciliation use to repair anything a lost webhook left stale.
 */
export async function syncList(
  db: Db,
  client: ClickUpClient,
  listId: string,
  options: { full?: boolean; teamId?: string } = {},
): Promise<SyncStats> {
  const started = Date.now();
  const cursor = options.full ? null : await readCursor(db, "list", listId);

  const stats: SyncStats = { requests: 0, tasks: 0, changed: 0, ms: 0 };

  try {
    for await (const page of client.iterateListTasks(listId, {
      // ClickUp's filter is strictly greater-than, and its mtime resolution is
      // whole milliseconds, so resending the boundary task is not possible.
      // Back off 1ms anyway: a task updated in the same millisecond as our
      // cursor would otherwise be lost forever.
      dateUpdatedGt: cursor ? cursor.getTime() - 1 : undefined,
      includeClosed: true,
      subtasks: true,
      orderBy: "updated",
      /*
       * Oldest first, which is what makes the cursor below resumable.
       *
       * `order_by=updated` alone is newest first — measured against the real
       * workspace, not assumed. Page 0 would then carry the newest task in the
       * list, the cursor would jump to the list's global maximum before page 1
       * was even asked for, and an error halfway through would leave every task
       * it had not reached yet sitting behind a cursor that says they are all
       * accounted for. They would stay invisible until the nightly full pass.
       *
       * Ascending, each committed page only moves the cursor past what it
       * actually contains, and a task edited mid-pagination moves to the end
       * where this read still catches it.
       */
      reverse: true,
    })) {
      stats.requests++;
      stats.tasks += page.length;

      const result = await ingestTasks(db, page, { listId, teamId: options.teamId });
      stats.changed += result.changed;

      if (result.newestUpdate) await advanceCursor(db, "list", listId, result.newestUpdate);
    }
    // An empty first page still counts as a request.
    if (stats.requests === 0) stats.requests = 1;

    await db
      .update(syncCursors)
      .set({
        lastRunAt: new Date(),
        failures: 0,
        lastError: null,
        ...(options.full ? { lastFullSyncAt: new Date() } : {}),
      })
      .where(and(eq(syncCursors.scope, "list"), eq(syncCursors.scopeId, listId)));
  } catch (error) {
    await recordFailure(db, "list", listId, error);
    throw error;
  }

  stats.ms = Date.now() - started;
  return stats;
}

/** Re-reads a single task. What a webhook triggers, since events carry only an id. */
export async function syncTask(db: Db, client: ClickUpClient, taskId: string): Promise<void> {
  const task = await client.getTask(taskId);
  await ingestTasks(db, [task]);
}

/**
 * How many pages of a task's conversation a comment event is worth.
 *
 * One. `GET /task/{id}/comment` returns the newest 25 first, and a comment
 * event is about something somebody just said — the pages behind it are
 * history the detail view fetches when anybody actually opens the task. Two
 * would double the cost of every comment in the workspace to re-read what the
 * mirror already has.
 */
const COMMENT_PAGES_PER_EVENT = 1;

/**
 * Re-reads the newest page of a task's comments.
 *
 * Only ever called for a comment event. Replies are deliberately not walked:
 * `GET /comment/{id}/reply` is one request per thread, and the inbox reads
 * top-level comments — a reply that mentions you arrives when the task is
 * opened, which is where the threads are already fetched.
 */
export async function syncComments(db: Db, client: ClickUpClient, taskId: string): Promise<number> {
  let requests = 0;
  for await (const page of client.iterateComments(taskId, { maxPages: COMMENT_PAGES_PER_EVENT })) {
    requests++;
    await ingestComments(db, taskId, page);
  }
  return requests;
}

/** Lists we have synced at least once. Nothing else is worth polling. */
export async function activeLists(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: syncCursors.scopeId })
    .from(syncCursors)
    .where(eq(syncCursors.scope, "list"));
  return rows.map((r) => r.id);
}

/**
 * Lists somebody has asked for and nobody has read yet.
 *
 * Opening a list in the browser writes its cursor row and stops there, so
 * without this the first fill waits for the next poll tick — two minutes, or
 * ten once a webhook is delivering, since the webhook only carries changes to
 * tasks the mirror already holds and can say nothing about a list it has never
 * seen.
 *
 * `lastRunAt` is stamped by both the success and the failure path, so a list
 * leaves this set after one attempt either way and a list ClickUp keeps
 * refusing backs off with the poll instead of being retried every few seconds.
 */
export async function coldLists(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: syncCursors.scopeId })
    .from(syncCursors)
    .where(and(eq(syncCursors.scope, "list"), isNull(syncCursors.lastRunAt)));
  return rows.map((r) => r.id);
}

export async function taskCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(isNull(tasks.deletedAt));
  return row?.n ?? 0;
}

// --- cursors --------------------------------------------------------------

async function readCursor(db: Db, scope: "list" | "team", scopeId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: syncCursors.lastUpdatedAt })
    .from(syncCursors)
    .where(and(eq(syncCursors.scope, scope), eq(syncCursors.scopeId, scopeId)))
    .limit(1);
  return row?.at ?? null;
}

async function advanceCursor(
  db: Db,
  scope: "list" | "team",
  scopeId: string,
  at: Date,
): Promise<void> {
  await db
    .insert(syncCursors)
    .values({ scope, scopeId, lastUpdatedAt: at, lastRunAt: new Date() })
    .onConflictDoUpdate({
      target: [syncCursors.scope, syncCursors.scopeId],
      // Never move the cursor backwards. Out-of-order pages would otherwise
      // rewind it and force a re-read of everything since.
      set: {
        lastUpdatedAt: sql`greatest(${syncCursors.lastUpdatedAt}, excluded.last_updated_at)`,
        lastRunAt: new Date(),
      },
    });
}

async function recordFailure(
  db: Db,
  scope: "list" | "team",
  scopeId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .insert(syncCursors)
    .values({ scope, scopeId, lastRunAt: new Date(), failures: 1, lastError: message })
    .onConflictDoUpdate({
      target: [syncCursors.scope, syncCursors.scopeId],
      set: {
        lastRunAt: new Date(),
        failures: sql`${syncCursors.failures} + 1`,
        lastError: message,
      },
    });
}

/** Marks a list for syncing without fetching anything yet. */
export async function trackList(db: Db, listId: string): Promise<void> {
  await db.insert(syncCursors).values({ scope: "list", scopeId: listId }).onConflictDoNothing();
}
