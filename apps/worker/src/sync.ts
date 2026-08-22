import type { ClickUpClient } from "@rask/clickup-client";
import {
  type Db,
  ingestTasks,
  lists,
  mapCustomField,
  syncCursors,
  tasks,
  upsertCustomFields,
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
 * Mirrors the Space/Folder/List tree. Cheap (1 + 2n requests for n spaces) and
 * a prerequisite for everything else, since list ids drive task sync.
 */
export async function syncHierarchy(
  db: Db,
  client: ClickUpClient,
  teamId: string,
): Promise<SyncStats> {
  const started = Date.now();
  const tree = await client.getWorkspaceHierarchy(teamId);

  await upsertSpaces(
    db,
    tree.map((t) => t.space),
    teamId,
  );

  for (const { space, folders, lists: folderless } of tree) {
    await upsertFolders(db, folders, space.id);
    await upsertLists(db, folderless, { spaceId: space.id, folderId: null });
    for (const folder of folders) {
      await upsertLists(db, folder.lists, { spaceId: space.id, folderId: folder.id });
    }
  }

  return {
    requests: 1 + tree.length * 2,
    tasks: 0,
    changed: 0,
    ms: Date.now() - started,
  };
}

/**
 * Pulls a list's tasks into the mirror.
 *
 * Incremental by default: `date_updated_gt` is the newest ClickUp mtime we have
 * already stored, so a quiet list costs exactly one request. The cursor only
 * advances after a page commits, so a crash mid-list re-reads instead of
 * skipping, and the upserts make the re-read a no-op.
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

/** Custom Field definitions for a list. Needed to render anything but raw values. */
export async function syncListCustomFields(
  db: Db,
  client: ClickUpClient,
  listId: string,
): Promise<void> {
  const fields = await client.getListCustomFields(listId);
  await upsertCustomFields(db, fields.map(mapCustomField));
}

/** Re-reads a single task. What a webhook triggers, since events carry only an id. */
export async function syncTask(db: Db, client: ClickUpClient, taskId: string): Promise<void> {
  const task = await client.getTask(taskId);
  await ingestTasks(db, [task]);
}

/** Lists we have synced at least once. Nothing else is worth polling. */
export async function activeLists(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: syncCursors.scopeId })
    .from(syncCursors)
    .where(eq(syncCursors.scope, "list"));
  return rows.map((r) => r.id);
}

/** Every list in the mirror, archived ones excluded. Used by the initial load. */
export async function allLists(db: Db): Promise<Array<{ id: string; name: string }>> {
  return db.select({ id: lists.id, name: lists.name }).from(lists).where(eq(lists.archived, false));
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
