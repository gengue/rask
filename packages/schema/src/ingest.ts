import type { ClickUpTask } from "@rask/clickup-client";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import {
  type MappedCustomField,
  type MappedUser,
  mapComment,
  mapFolder,
  mapList,
  mapSpace,
  mapTask,
} from "./map.ts";
import {
  comments,
  customFieldDefs,
  folders,
  lists,
  spaces,
  taskAssignees,
  taskCustomValues,
  tasks,
  users,
} from "./schema.ts";

/**
 * Writes ClickUp payloads into the mirror.
 *
 * Every write is an upsert keyed on the ClickUp id, so replaying the same page
 * twice is a no-op. That matters: webhooks arrive out of order, polling overlaps
 * itself, and the nightly reconciliation deliberately re-reads everything.
 */

/** Postgres caps a statement at 65535 bound parameters. Tasks use ~26 each. */
const TASK_CHUNK = 200;
const ROW_CHUNK = 500;

export async function upsertSpaces(
  db: Db,
  input: Array<Parameters<typeof mapSpace>[0]>,
  teamId: string,
): Promise<void> {
  if (input.length === 0) return;
  const rows = input.map((s) => mapSpace(s, teamId));
  await db
    .insert(spaces)
    .values(rows)
    .onConflictDoUpdate({
      target: spaces.id,
      set: pick(["teamId", "name", "private", "archived", "statuses"], { syncedAt: true }),
    });
}

export async function upsertFolders(
  db: Db,
  input: Array<Parameters<typeof mapFolder>[0]>,
  spaceId: string,
): Promise<void> {
  if (input.length === 0) return;
  await db
    .insert(folders)
    .values(input.map((f) => mapFolder(f, spaceId)))
    .onConflictDoUpdate({
      target: folders.id,
      set: pick(["spaceId", "name", "orderindex", "hidden", "archived"], { syncedAt: true }),
    });
}

export async function upsertLists(
  db: Db,
  input: Array<Parameters<typeof mapList>[0]>,
  fallback: { spaceId: string; folderId?: string | null },
): Promise<void> {
  if (input.length === 0) return;
  await db
    .insert(lists)
    .values(input.map((l) => mapList(l, fallback)))
    .onConflictDoUpdate({
      target: lists.id,
      set: pick(
        [
          "spaceId",
          "folderId",
          "name",
          "orderindex",
          "content",
          "taskCount",
          "archived",
          "statuses",
        ],
        { syncedAt: true },
      ),
    });
}

export async function upsertUsers(db: Db, input: MappedUser[]): Promise<void> {
  const unique = dedupeById(input);
  if (unique.length === 0) return;
  for (const chunk of chunks(unique, ROW_CHUNK)) {
    await db
      .insert(users)
      .values(chunk)
      .onConflictDoUpdate({
        target: users.id,
        set: pick(["username", "email", "color", "initials", "profilePicture"], {
          syncedAt: true,
        }),
      });
  }
}

export async function upsertCustomFields(db: Db, input: MappedCustomField[]): Promise<void> {
  const unique = dedupeById(input);
  if (unique.length === 0) return;
  for (const chunk of chunks(unique, ROW_CHUNK)) {
    await db
      .insert(customFieldDefs)
      .values(chunk)
      .onConflictDoUpdate({
        target: customFieldDefs.id,
        set: pick(["name", "type", "typeConfig", "required"], { syncedAt: true }),
      });
  }
}

export interface IngestResult {
  /** Rows Postgres actually wrote. Unchanged tasks are skipped, not rewritten. */
  changed: number;
  /** Newest ClickUp `date_updated` in the batch. Becomes the next poll cursor. */
  newestUpdate: Date | null;
}

/**
 * Upserts a batch of tasks along with their assignees, custom values, and the
 * users and field definitions they reference.
 *
 * `listId` is the list the batch was fetched from. ClickUp usually echoes the
 * list back on the task, but not on every endpoint, so the caller's context wins
 * when the payload is missing it.
 */
export async function ingestTasks(
  db: Db,
  batch: ClickUpTask[],
  context: { listId?: string; teamId?: string } = {},
): Promise<IngestResult> {
  if (batch.length === 0) return { changed: 0, newestUpdate: null };

  const mapped = batch.map(mapTask);
  let changed = 0;
  let newestUpdate: Date | null = null;

  await upsertUsers(
    db,
    mapped.flatMap((m) => m.users),
  );
  await upsertCustomFields(
    db,
    mapped.flatMap((m) => m.customFields),
  );

  for (const chunk of chunks(mapped, TASK_CHUNK)) {
    const rows = chunk.map((m) => ({
      ...m.task,
      listId: m.task.listId || context.listId || "",
      teamId: context.teamId ?? null,
      deletedAt: null,
    }));

    const written = await db
      .insert(tasks)
      .values(rows)
      .onConflictDoUpdate({
        target: tasks.id,
        set: {
          ...pick(
            [
              "customId",
              "listId",
              "folderId",
              "spaceId",
              "teamId",
              "name",
              "description",
              "textContent",
              "status",
              "statusColor",
              "statusType",
              "orderindex",
              "parentId",
              "priority",
              "dueDate",
              "startDate",
              "dateCreated",
              "dateUpdated",
              "dateClosed",
              "dateDone",
              "creatorId",
              "archived",
              "tags",
              "timeEstimate",
              "points",
              "url",
              "deletedAt",
            ],
            { syncedAt: true },
          ),
        },
        // Skip rows ClickUp has not touched since we last stored them. Keeps the
        // nightly full resync from bumping synced_at on every task and flooding SSE.
        setWhere: sql`${tasks.dateUpdated} IS DISTINCT FROM excluded.date_updated`,
      })
      .returning({ id: tasks.id });

    changed += written.length;

    const taskIds = chunk.map((m) => m.task.id);
    await replaceAssignees(db, taskIds, chunk);
    await replaceCustomValues(db, taskIds, chunk);

    for (const m of chunk) {
      if (m.task.dateUpdated && (!newestUpdate || m.task.dateUpdated > newestUpdate)) {
        newestUpdate = m.task.dateUpdated;
      }
    }
  }

  return { changed, newestUpdate };
}

async function replaceAssignees(
  db: Db,
  taskIds: string[],
  mapped: Array<{ task: { id: string }; assigneeIds: string[] }>,
): Promise<void> {
  // Delete-then-insert rather than diffing: assignee sets are tiny and a diff
  // would need a read round trip to save writes that cost less than the read.
  await db.delete(taskAssignees).where(inArray(taskAssignees.taskId, taskIds));
  const rows = mapped.flatMap((m) =>
    m.assigneeIds.map((userId) => ({ taskId: m.task.id, userId })),
  );
  if (rows.length === 0) return;
  for (const chunk of chunks(rows, ROW_CHUNK)) {
    await db.insert(taskAssignees).values(chunk).onConflictDoNothing();
  }
}

async function replaceCustomValues(
  db: Db,
  taskIds: string[],
  mapped: Array<{ task: { id: string }; customValues: Array<{ fieldId: string; value: unknown }> }>,
): Promise<void> {
  await db.delete(taskCustomValues).where(inArray(taskCustomValues.taskId, taskIds));
  const rows = mapped.flatMap((m) =>
    m.customValues.map((v) => ({ taskId: m.task.id, fieldId: v.fieldId, value: v.value })),
  );
  if (rows.length === 0) return;
  for (const chunk of chunks(rows, ROW_CHUNK)) {
    await db.insert(taskCustomValues).values(chunk).onConflictDoNothing();
  }
}

export async function ingestComments(
  db: Db,
  taskId: string,
  batch: Array<Parameters<typeof mapComment>[0]>,
): Promise<void> {
  if (batch.length === 0) return;
  const mapped = batch.map((c) => mapComment(c, taskId));
  await upsertUsers(
    db,
    batch
      .filter((c) => c.user)
      .map((c) => ({
        id: String(c.user?.id),
        username: c.user?.username ?? null,
        email: c.user?.email ?? null,
        color: c.user?.color ?? null,
        initials: c.user?.initials ?? null,
        profilePicture: c.user?.profilePicture ?? null,
      })),
  );
  await db
    .insert(comments)
    .values(mapped)
    .onConflictDoUpdate({
      target: comments.id,
      set: pick(["text", "resolved", "replyCount", "date"], { syncedAt: true }),
    });
}

/** Marks a task gone without dropping the row, so open clients can reconcile. */
export async function markTaskDeleted(db: Db, taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ deletedAt: new Date(), syncedAt: new Date() })
    .where(and(eq(tasks.id, taskId), sql`${tasks.deletedAt} IS NULL`));
}

// --- helpers --------------------------------------------------------------

/**
 * Builds the `SET` clause of an upsert straight from `excluded`, plus a fresh
 * synced_at. Listing columns by name beats spreading the values object: a column
 * we deliberately do not overwrite (like `id`) stays out by construction.
 */
function pick(columns: string[], extra: { syncedAt?: boolean } = {}): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const column of columns) set[column] = sql.raw(`excluded.${snake(column)}`);
  if (extra.syncedAt) set.syncedAt = new Date();
  return set;
}

function snake(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function* chunks<T>(rows: T[], size: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}
