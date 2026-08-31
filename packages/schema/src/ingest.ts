import {
  type ClickUpTask,
  type ClickUpView,
  findMentions,
  isCommentEvent,
} from "@rask/clickup-client";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import {
  type MappedAttachment,
  type MappedChecklist,
  type MappedCustomField,
  type MappedDoc,
  type MappedUser,
  mapChecklist,
  mapComment,
  mapFolder,
  mapList,
  mapSpace,
  mapTask,
  mapView,
} from "./map.ts";
import {
  checklistItems,
  commentMentions,
  comments,
  customFieldDefs,
  docs,
  folders,
  lists,
  listViews,
  spaces,
  taskAssignees,
  taskAttachments,
  taskChecklists,
  taskCustomValues,
  tasks,
  users,
  webhookEvents,
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

/**
 * A List's views, replacing whatever was there.
 *
 * `GET /list/{id}/view` answers with the complete set — saved views and
 * built-ins together — so unlike a page of comments, "absent" here really does
 * mean "deleted in ClickUp", and a tab bar that keeps offering a view somebody
 * removed is worse than one that is a poll behind.
 *
 * Upsert then delete, rather than delete then insert: the rows survive a failed
 * fetch, and nothing observes the table mid-transaction anyway.
 */
export async function replaceListViews(
  db: Db,
  listId: string,
  input: { views: ClickUpView[]; defaultViewId: string | null },
): Promise<void> {
  const rows = input.views.map((view) => mapView(view, listId, input.defaultViewId));

  if (rows.length > 0) {
    await db
      .insert(listViews)
      .values(rows)
      .onConflictDoUpdate({
        target: listViews.id,
        set: pick(
          [
            "listId",
            "name",
            "type",
            "orderindex",
            "isDefault",
            "groupField",
            "showClosed",
            "publicUrl",
          ],
          { syncedAt: true },
        ),
      });
  }

  const keep = rows.map((row) => row.id);
  await db
    .delete(listViews)
    .where(
      and(
        eq(listViews.listId, listId),
        keep.length > 0 ? notInArray(listViews.id, keep) : undefined,
      ),
    );
}

/**
 * The workspace's Doc index, replacing whatever was there.
 *
 * The same bargain `replaceListViews` makes, for the same reason: the walk that
 * feeds this answers with every Doc in the workspace, so a row that is absent
 * really was deleted rather than merely unmentioned, and a sidebar still
 * offering a Doc somebody removed sends people to a 404.
 *
 * Scoped to the team so a workspace whose walk failed cannot empty another's.
 * Upsert first, delete second: the rows survive a failed fetch.
 */
export async function replaceDocs(db: Db, teamId: string, input: MappedDoc[]): Promise<void> {
  if (input.length > 0) {
    for (const chunk of chunks(input, ROW_CHUNK)) {
      await db
        .insert(docs)
        .values(chunk)
        .onConflictDoUpdate({
          target: docs.id,
          set: pick(["teamId", "name", "parentId", "parentType", "dateUpdated", "archived"], {
            syncedAt: true,
          }),
        });
    }
  }

  const keep = input.map((row) => row.id);
  await db
    .delete(docs)
    .where(and(eq(docs.teamId, teamId), keep.length > 0 ? notInArray(docs.id, keep) : undefined));
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
  context: { listId?: string; teamId?: string; force?: boolean } = {},
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
              "timeSpent",
              "points",
              "url",
              "deletedAt",
            ],
            { syncedAt: true },
          ),
        },
        /*
         * Skip rows ClickUp has not touched since we last stored them. Keeps
         * the nightly full resync from bumping synced_at on every task and
         * flooding SSE.
         *
         * `force` is for repair, where the guard is exactly wrong: a rejected
         * write left the mirror holding a status ClickUp never accepted, and
         * ClickUp's `date_updated` is unchanged precisely *because* it rejected
         * it. Guarded, the read-back would restore assignees and checklists —
         * those are replaced unconditionally below — while leaving status, name
         * and due date optimistic forever. Half-repaired is worse than either.
         *
         * `time_spent` is ORed in because it was added to a mirror that already
         * held every row, and a column added after the fact is null on all of
         * them. Nothing upstream moves `date_updated` to announce a column we
         * invented, so the guard would skip those rows forever — a full resync
         * included, since that ignores the cursor and not this predicate.
         *
         * It fires once per row and then never again: adding a time entry does
         * bump ClickUp's `date_updated` (checked against the workspace — the
         * entry's `date_added` and the task's `date_updated` agree to the
         * millisecond), so from the backfill onwards the first clause is
         * already true whenever this one would be.
         */
        setWhere: context.force
          ? undefined
          : sql`${tasks.dateUpdated} IS DISTINCT FROM excluded.date_updated
              or ${tasks.timeSpent} IS DISTINCT FROM excluded.time_spent`,
      })
      .returning({ id: tasks.id });

    changed += written.length;

    const taskIds = chunk.map((m) => m.task.id);
    await replaceAssignees(db, taskIds, chunk);
    await replaceCustomValues(db, taskIds, chunk);
    await replaceAttachments(db, chunk);
    await replaceChecklists(db, chunk);

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

/**
 * Attachments, for the tasks in the batch that came with an opinion about them.
 *
 * A task whose payload had no `attachments` key is skipped entirely rather than
 * emptied: every list endpoint omits the key, so a poll would otherwise wipe
 * what the last detail fetch mirrored, and the files would flicker back into
 * existence the next time somebody opened the task.
 */
async function replaceAttachments(
  db: Db,
  mapped: Array<{ task: { id: string }; attachments: MappedAttachment[] | null }>,
): Promise<void> {
  const known = mapped.filter((m) => m.attachments !== null);
  if (known.length === 0) return;

  const taskIds = known.map((m) => m.task.id);
  await db.delete(taskAttachments).where(inArray(taskAttachments.taskId, taskIds));

  const rows = known.flatMap((m) =>
    (m.attachments ?? []).map((attachment) => ({ ...attachment, taskId: m.task.id })),
  );
  if (rows.length === 0) return;
  for (const chunk of chunks(rows, ROW_CHUNK)) {
    await db.insert(taskAttachments).values(chunk).onConflictDoNothing();
  }
}

/**
 * Checklists, for the tasks in the batch that came with an opinion about them.
 *
 * Skipped for a task whose payload had no `checklists` key, exactly like
 * attachments: every list endpoint omits it, so treating the silence as "no
 * checklists" would empty the table on every poll and refill it the next time
 * somebody opened the task. That reads as flakiness rather than as a bug, which
 * is what makes it worth a comment in both places.
 *
 * Replacement rather than a diff. A checklist is a handful of rows, ClickUp's
 * item ids are stable, and the delete cascades — so this also removes the
 * optimistic placeholder a write left behind, with no bookkeeping.
 */
async function replaceChecklists(
  db: Db,
  mapped: Array<{ task: { id: string }; checklists: MappedChecklist[] | null }>,
): Promise<void> {
  const known = mapped.filter((m) => m.checklists !== null);
  if (known.length === 0) return;

  await db.delete(taskChecklists).where(
    inArray(
      taskChecklists.taskId,
      known.map((m) => m.task.id),
    ),
  );

  const mirrored = known.flatMap((m) => m.checklists ?? []);
  if (mirrored.length === 0) return;

  for (const chunk of chunks(
    mirrored.map((entry) => entry.checklist),
    ROW_CHUNK,
  )) {
    await db.insert(taskChecklists).values(chunk).onConflictDoNothing();
  }

  // Items only after every checklist is in: the foreign key cascades, so an
  // item whose checklist is still missing is rejected rather than orphaned.
  const items = mirrored.flatMap((entry) => entry.items);
  for (const chunk of chunks(items, ROW_CHUNK)) {
    await db.insert(checklistItems).values(chunk).onConflictDoNothing();
  }
}

/**
 * One checklist, as every checklist write answers with it.
 *
 * Items are replaced rather than merged, which is what retires the optimistic
 * placeholder the API inserted: it has a `tmp_` id ClickUp never heard of, so a
 * merge would leave it on screen for ever.
 */
export async function ingestChecklist(
  db: Db,
  taskId: string,
  payload: Parameters<typeof mapChecklist>[0],
): Promise<void> {
  const mapped = mapChecklist(payload, taskId);

  await db
    .insert(taskChecklists)
    .values(mapped.checklist)
    .onConflictDoUpdate({
      target: taskChecklists.id,
      set: pick(["taskId", "name", "orderindex", "creatorId", "dateCreated"], { syncedAt: true }),
    });

  await db.delete(checklistItems).where(eq(checklistItems.checklistId, mapped.checklist.id));
  if (mapped.items.length === 0) return;
  for (const chunk of chunks(mapped.items, ROW_CHUNK)) {
    await db.insert(checklistItems).values(chunk).onConflictDoNothing();
  }
}

type CommentPayload = Parameters<typeof mapComment>[0];

/**
 * Top-level comments for a task.
 *
 * Deliberately does not delete mirrored comments that are missing from the
 * batch: this endpoint is paginated and the caller decides how many pages to
 * walk, so "absent" and "older than what we asked for" look identical here.
 */
export async function ingestComments(
  db: Db,
  taskId: string,
  batch: CommentPayload[],
): Promise<void> {
  if (batch.length === 0) return;
  await upsertCommentAuthors(db, batch);
  const rows = batch.map((c) => mapComment(c, taskId));
  await upsertComments(db, rows);
  await replaceMentions(db, rows);
}

/**
 * The replies under one comment.
 *
 * `GET /comment/{id}/reply` is not paginated, so unlike the task's comment
 * list this batch is the whole thread. That is what makes it safe to drop
 * replies that are no longer there and to trust its length as the parent's
 * reply count, which saves refetching the task's comment list just to learn a
 * number we already know.
 */
export async function ingestReplies(
  db: Db,
  taskId: string,
  parentCommentId: string,
  batch: CommentPayload[],
): Promise<void> {
  await upsertCommentAuthors(db, batch);
  const rows = batch.map((c) => mapComment(c, taskId, parentCommentId));
  await upsertComments(db, rows);
  await replaceMentions(db, rows);

  const keep = batch.map((c) => c.id);
  await db
    .delete(comments)
    .where(
      and(
        eq(comments.parentCommentId, parentCommentId),
        keep.length > 0 ? notInArray(comments.id, keep) : undefined,
      ),
    );

  await db
    .update(comments)
    .set({ replyCount: batch.length, syncedAt: new Date() })
    .where(eq(comments.id, parentCommentId));
}

/**
 * Rewrites who each comment mentions.
 *
 * Deleted and reinserted per comment rather than merged, because an edit can
 * remove a mention and a merge would leave the old row behind — the one shape
 * of staleness that shows up as a notification for something nobody said.
 *
 * The ids come from the rendered markdown rather than from `segments`, because
 * `renderCommentBody` has already done the work of deciding which `tag` runs
 * carry a real user, and a locally authored comment is written in that dialect
 * before ClickUp has ever seen it. One reader, both origins.
 */
async function replaceMentions(db: Db, rows: ReturnType<typeof mapComment>[]): Promise<void> {
  if (rows.length === 0) return;

  await db.delete(commentMentions).where(
    inArray(
      commentMentions.commentId,
      rows.map((row) => row.id),
    ),
  );

  const mentioned = rows.flatMap((row) =>
    // A body that mentions the same person twice is one row, not a conflict.
    [...new Set(findMentions(row.markdown ?? "").map((mention) => String(mention.id)))].map(
      (userId) => ({ commentId: row.id, userId }),
    ),
  );
  if (mentioned.length === 0) return;

  for (const chunk of chunks(mentioned, ROW_CHUNK)) {
    await db.insert(commentMentions).values(chunk).onConflictDoNothing();
  }
}

async function upsertComments(db: Db, rows: ReturnType<typeof mapComment>[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(comments)
    .values(rows)
    .onConflictDoUpdate({
      target: comments.id,
      set: {
        ...pick(["text", "markdown", "segments", "assigneeId", "resolved", "replyCount", "date"], {
          syncedAt: true,
        }),
        // A reply re-read as part of some other batch must not lose its thread.
        parentCommentId: sql`coalesce(excluded.parent_comment_id, ${comments.parentCommentId})`,
      },
    });
}

async function upsertCommentAuthors(db: Db, batch: CommentPayload[]): Promise<void> {
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
}

/**
 * Records that a webhook says this task changed.
 *
 * Called from the receiving route, which has no session behind it and so must
 * stay cheap: one insert, no ClickUp traffic, no read. The conflict clause is
 * the coalescing — a second event for a task already queued overwrites the
 * first instead of queueing behind it, so a task somebody is editing quickly
 * costs one read-back rather than one per keystroke.
 *
 * `attempts` and `nextAttemptAt` are deliberately left alone on conflict. A row
 * that is already backing off after a failed read-back keeps its schedule; a
 * task that keeps producing events would otherwise reset it forever and never
 * reach the give-up point where polling takes over.
 */
export async function enqueueWebhookEvent(
  db: Db,
  input: { taskId: string; event: string; webhookId?: string | null },
): Promise<void> {
  await db
    .insert(webhookEvents)
    .values({
      taskId: input.taskId,
      event: input.event,
      webhookId: input.webhookId ?? null,
      needsComments: isCommentEvent(input.event),
    })
    .onConflictDoUpdate({
      target: webhookEvents.taskId,
      set: {
        event: sql`excluded.event`,
        // Only ever widen what we know. A delivery that named no webhook must
        // not erase the id an earlier one did, since that id is the only thing
        // pointing at which registration is misbehaving.
        webhookId: sql`coalesce(excluded.webhook_id, ${webhookEvents.webhookId})`,
        // ORed, never replaced. The row is keyed by task, so a task event
        // landing behind a comment event would otherwise clear the only record
        // that the conversation moved, and the comment would wait for whenever
        // somebody next opened the task.
        needsComments: sql`${webhookEvents.needsComments} or excluded.needs_comments`,
        receivedAt: new Date(),
      },
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
