import { ClickUpError, type CommentSegment } from "@rask/clickup-client";
import {
  checklistItems,
  comments,
  type Db,
  ingestChecklist,
  ingestComments,
  ingestReplies,
  ingestTasks,
  type OutboxOp,
  outbox,
  taskChecklists,
  tasks,
} from "@rask/schema";
import { eq, sql } from "drizzle-orm";

import type { TokenPool } from "./tokens.ts";

/**
 * Ships optimistic writes to ClickUp.
 *
 * The outbox table is the queue. Rows are claimed with FOR UPDATE SKIP LOCKED,
 * so several worker processes can drain it at once without coordination and a
 * crashed worker's rows come back on their own once the transaction dies.
 *
 * ClickUp is the source of truth, so a rejected write is not retried forever
 * and is not papered over: the mirror is repaired from ClickUp and the user is
 * told. That repair is why `revert` refetches instead of trying to undo.
 */

export const MAX_ATTEMPTS = 5;

export interface OutboxRow {
  id: number;
  user_id: string;
  op: OutboxOp;
  entity_id: string | null;
  payload: unknown;
  client_id: string | null;
  attempts: number;
}

export interface DrainResult {
  sent: number;
  failed: number;
  deferred: number;
}

export async function drainOutbox(db: Db, pool: TokenPool, limit = 20): Promise<DrainResult> {
  const claimed = await claim(db, limit);
  const result: DrainResult = { sent: 0, failed: 0, deferred: 0 };

  for (const row of claimed) {
    try {
      const client = await pool.for(row.user_id);
      if (!client) throw new Error(`no ClickUp token for user ${row.user_id}`);

      await execute(db, client, row);
      await db
        .update(outbox)
        .set({ status: "done", updatedAt: new Date(), lastError: null })
        .where(eq(outbox.id, row.id));
      result.sent++;
    } catch (error) {
      const permanent = isPermanent(error) || row.attempts + 1 >= MAX_ATTEMPTS;
      const message = error instanceof Error ? error.message : String(error);

      await db
        .update(outbox)
        .set({
          status: permanent ? "failed" : "pending",
          attempts: row.attempts + 1,
          nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts + 1)),
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(outbox.id, row.id));

      if (permanent) {
        await revert(db, pool, row);
        result.failed++;
      } else {
        result.deferred++;
      }
    }
  }

  return result;
}

async function execute(
  db: Db,
  client: NonNullable<Awaited<ReturnType<TokenPool["for"]>>>,
  row: OutboxRow,
) {
  const payload = row.payload as Record<string, unknown>;

  switch (row.op) {
    case "update_task": {
      if (!row.entity_id) throw new Error("update_task without an entity_id");
      const updated = await client.updateTask(row.entity_id, payload);
      // Write ClickUp's own version back. If it normalized anything (a status
      // rename, a due date rounded to midnight) the mirror matches immediately.
      await ingestTasks(db, [updated]);
      return;
    }

    case "create_task": {
      const { listId, ...input } = payload as { listId: string } & Record<string, unknown>;
      const created = await client.createTask(listId, input as never);
      await ingestTasks(db, [created], { listId });
      // Drop the placeholder the API inserted so the browser can swap it for
      // the real row on the next SSE frame.
      if (row.client_id) await db.delete(tasks).where(eq(tasks.id, placeholderId(row.client_id)));
      await db.update(outbox).set({ entityId: created.id }).where(eq(outbox.id, row.id));
      return;
    }

    case "create_comment": {
      const { taskId, text, parentId } = payload as {
        taskId: string;
        text: string;
        parentId: string | null;
      };

      if (parentId) await client.createThreadedComment(parentId, { text });
      else await client.createComment(taskId, { text });

      // Past this line the comment exists in ClickUp, so nothing may throw:
      // a retry would post it a second time. ClickUp's reply endpoint answers
      // with an empty body and even the task version only returns an id, so the
      // comment is read back rather than reconstructed — that read is what gives
      // the row its real id, author and reply count. If the read fails anyway,
      // the next task refresh picks it up.
      if (row.client_id) {
        await db.delete(comments).where(eq(comments.id, placeholderId(row.client_id)));
      }
      await readBackComments(db, client, taskId, parentId).catch(() => {});
      return;
    }

    case "update_comment": {
      const { commentId, text, segments, resolved } = payload as {
        commentId: string;
        text: string;
        segments?: CommentSegment[] | null;
        resolved: boolean;
      };
      // The mirror already holds this exact state, and ClickUp answers with an
      // empty body, so there is nothing to ingest on success.
      await client.updateComment(commentId, { text, segments, resolved });
      return;
    }

    case "delete_comment": {
      const { commentId } = payload as { commentId: string };
      await client.deleteComment(commentId);
      return;
    }

    case "add_tag":
    case "remove_tag": {
      const { taskId, tag } = payload as { taskId: string; tag: string };
      if (row.op === "add_tag") await client.addTag(taskId, tag);
      else await client.removeTag(taskId, tag);
      // ClickUp returns nothing useful, and its own colour for a new tag only
      // shows up on the task itself.
      await ingestTasks(db, [await client.getTask(taskId)]);
      return;
    }

    /*
     * Checklists.
     *
     * Every write except the two deletes answers with the whole checklist,
     * items included, so the mirror is repaired from the response rather than
     * by refetching the task. Ticking a box costs exactly one request.
     */
    case "create_checklist": {
      const { taskId, name } = payload as { taskId: string; name: string };
      const created = await client.createChecklist(taskId, { name });
      await ingestChecklist(db, taskId, created);
      // Retire the placeholder now that the real row exists. The API's SSE push
      // carries the swap to whoever has the task open.
      if (row.client_id) {
        await db.delete(taskChecklists).where(eq(taskChecklists.id, placeholderId(row.client_id)));
      }
      return;
    }

    case "update_checklist": {
      const { checklistId, name } = payload as { checklistId: string; name: string };
      // ClickUp answers an empty body and the mirror already holds this name.
      await client.updateChecklist(checklistId, { name });
      return;
    }

    case "delete_checklist": {
      const { checklistId } = payload as { checklistId: string };
      await client.deleteChecklist(checklistId);
      return;
    }

    case "create_checklist_item": {
      const { taskId, checklistId, name } = payload as {
        taskId: string;
        checklistId: string;
        name: string;
      };
      const updated = await client.createChecklistItem(checklistId, { name });
      // Replaces every item on the checklist, placeholder included.
      await ingestChecklist(db, taskId, updated);
      return;
    }

    case "update_checklist_item": {
      const { taskId, checklistId, itemId, name, resolved } = payload as {
        taskId: string;
        checklistId: string;
        itemId: string;
        name?: string;
        resolved?: boolean;
      };
      const updated = await client.updateChecklistItem(checklistId, itemId, { name, resolved });
      await ingestChecklist(db, taskId, updated);
      return;
    }

    case "delete_checklist_item": {
      const { checklistId, itemId } = payload as { checklistId: string; itemId: string };
      await client.deleteChecklistItem(checklistId, itemId);
      return;
    }

    case "set_custom_field": {
      const { taskId, fieldId, value } = payload as {
        taskId: string;
        fieldId: string;
        value: unknown;
      };
      await client.setCustomFieldValue(taskId, fieldId, value);
      const refreshed = await client.getTask(taskId);
      await ingestTasks(db, [refreshed]);
      return;
    }
  }
}

/**
 * Puts the mirror back to what ClickUp actually has.
 *
 * For an update that means refetching the task, or the conversation when the
 * write was a comment: ClickUp wins, and whatever the user optimistically saw
 * gets overwritten. For a create it means deleting the placeholder, since
 * ClickUp has nothing to refetch.
 *
 * The task refetch covers checklists for free: `GET /task/{id}` carries them,
 * and ingest replaces a task's checklists wholesale, so a rejected tick, rename
 * or delete snaps back to what ClickUp actually holds.
 */
async function revert(db: Db, pool: TokenPool, row: OutboxRow): Promise<void> {
  try {
    if (row.op === "create_task") {
      if (row.client_id) await db.delete(tasks).where(eq(tasks.id, placeholderId(row.client_id)));
      return;
    }

    const payload = row.payload as { taskId?: string; parentId?: string | null } | null;
    const taskId = row.entity_id ?? payload?.taskId ?? null;
    if (!taskId) return;

    if (row.op === "create_comment") {
      // Nothing to read back: the comment never existed upstream. Undoing the
      // optimistic reply count locally is both cheaper and more reliable than
      // refetching the thread, which is what left counts stranded when the
      // token that failed the write was also the token that would repair it.
      if (row.client_id) {
        await db.delete(comments).where(eq(comments.id, placeholderId(row.client_id)));
      }
      if (payload?.parentId) {
        await db
          .update(comments)
          .set({ replyCount: sql`greatest(${comments.replyCount} - 1, 0)` })
          .where(eq(comments.id, payload.parentId));
      }
      return;
    }

    /*
     * A checklist row that never reached ClickUp has nothing to refetch, and
     * the refetch below is exactly what is unavailable when the token itself is
     * the reason the write failed. Drop the placeholder locally first; the
     * repair that follows is then only correcting what ClickUp really holds.
     */
    if (row.client_id && row.op === "create_checklist") {
      await db.delete(taskChecklists).where(eq(taskChecklists.id, placeholderId(row.client_id)));
    }
    if (row.client_id && row.op === "create_checklist_item") {
      await db.delete(checklistItems).where(eq(checklistItems.id, placeholderId(row.client_id)));
    }

    const client = await pool.for(row.user_id);
    if (!client) return;

    if (row.op === "update_comment" || row.op === "delete_comment") {
      await readBackComments(db, client, taskId, payload?.parentId ?? null);
      return;
    }

    const truth = await client.getTask(taskId);
    await ingestTasks(db, [truth]);
  } catch {
    // The revert is best-effort. The nightly reconciliation is the backstop,
    // and leaving the row marked failed is what tells the user something broke.
  }
}

/**
 * Re-reads one conversation from ClickUp. One request either way.
 *
 * A thread is read whole, so `ingestReplies` can prune and recount from it; a
 * top-level read only gets the newest page, which is enough to correct or
 * restore a comment somebody just touched.
 */
async function readBackComments(
  db: Db,
  client: NonNullable<Awaited<ReturnType<TokenPool["for"]>>>,
  taskId: string,
  parentId: string | null,
): Promise<void> {
  if (parentId) {
    await ingestReplies(db, taskId, parentId, await client.getThreadedComments(parentId));
    return;
  }
  await ingestComments(db, taskId, await client.getComments(taskId));
}

export function placeholderId(clientId: string): string {
  return `tmp_${clientId}`;
}

/**
 * 2s, 4s, 8s, 16s, capped at five minutes.
 *
 * This is the worker's own budget, not ClickUp's: 429s are absorbed inside the
 * ClickUp client, so anything reaching here is a transient server error.
 */
export function backoffMs(attempt: number): number {
  return Math.min(300_000, 2 ** attempt * 1000);
}

/** A 4xx that is not 429 means the request itself is wrong. Retrying cannot help. */
export function isPermanent(error: unknown): boolean {
  return (
    error instanceof ClickUpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}

async function claim(db: Db, limit: number): Promise<OutboxRow[]> {
  const result = await db.execute(sql`
    with claimed as (
      select id from ${outbox}
      where status = 'pending' and next_attempt_at <= now()
      order by id
      for update skip locked
      limit ${limit}
    )
    update ${outbox} o
    set status = 'sending', updated_at = now()
    from claimed c
    where o.id = c.id
    returning o.id, o.user_id, o.op, o.entity_id, o.payload, o.client_id, o.attempts
  `);
  return (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  ) as OutboxRow[];
}
