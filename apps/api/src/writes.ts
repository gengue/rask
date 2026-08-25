import { placeholderId } from "@rask/clickup-client/vocabulary";

/**
 * A row the outbox has not shipped yet, so ClickUp has no id for it.
 *
 * Addressing one upstream would 404 and take the local state down with it on
 * the revert, so those writes are refused rather than queued. The window is a
 * couple of seconds — the outbox drains every two — and the UI says so.
 */
export const NOT_YET = "this has not reached ClickUp yet";

import {
  checklistItems,
  comments,
  type Db,
  outbox,
  taskAssignees,
  taskChecklists,
  taskCustomValues,
  tasks,
} from "@rask/schema";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * The write path.
 *
 * Both steps happen in one transaction: the mirror is updated so the change is
 * visible to every connected client immediately, and an outbox row is queued so
 * the worker can push it to ClickUp. If ClickUp later rejects it, the worker
 * repairs the mirror from ClickUp and the user hears about it.
 */

export const taskPatchInput = z.object({
  name: z.string().min(1).max(1000).optional(),
  description: z.string().max(100_000).optional(),
  status: z.string().min(1).optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  dueDate: z.number().int().nullable().optional(),
  assignees: z.array(z.string()).optional(),
});
export type TaskPatchInput = z.infer<typeof taskPatchInput>;

export const newTaskInput = z.object({
  listId: z.string().min(1),
  name: z.string().min(1).max(1000),
  status: z.string().min(1).optional(),
  description: z.string().max(100_000).optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  dueDate: z.number().int().nullable().optional(),
  assignees: z.array(z.string()).default([]),
  /**
   * Makes the new task a subtask of this one.
   *
   * ClickUp requires the parent to live in the List named in the path, so the
   * caller sends the parent's own list rather than whichever one is open.
   */
  parentId: z.string().min(1).optional(),
  /** Client-generated, so the optimistic row can be matched to ClickUp's reply. */
  clientId: z.string().min(1).max(64),
});

export const newCommentInput = z.object({
  text: z.string().min(1).max(50_000),
  /** Set to reply inside a thread. ClickUp threads are one level deep. */
  parentId: z.string().min(1).optional(),
  /** Client-generated, so the optimistic row can be matched to ClickUp's reply. */
  clientId: z.string().min(1).max(64),
});

export const commentPatchInput = z
  .object({
    text: z.string().min(1).max(50_000).optional(),
    resolved: z.boolean().optional(),
  })
  .refine((patch) => patch.text !== undefined || patch.resolved !== undefined, {
    message: "nothing to change",
  });
export type CommentPatchInput = z.infer<typeof commentPatchInput>;

export async function applyTaskPatch(
  db: Db,
  input: { taskId: string; userId: string; patch: TaskPatchInput },
): Promise<void> {
  const { taskId, userId, patch } = input;

  await db.transaction(async (tx) => {
    const local: Record<string, unknown> = { syncedAt: new Date() };
    if (patch.name !== undefined) local.name = patch.name;
    if (patch.description !== undefined) local.description = patch.description;
    if (patch.status !== undefined) local.status = patch.status;
    if (patch.priority !== undefined) local.priority = patch.priority;
    if (patch.dueDate !== undefined) {
      local.dueDate = patch.dueDate === null ? null : new Date(patch.dueDate);
    }

    await tx.update(tasks).set(local).where(eq(tasks.id, taskId));

    // Read the old set before overwriting it: ClickUp wants a delta, not a list.
    let delta: { add: number[]; rem: number[] } | undefined;
    if (patch.assignees) {
      const rows = await tx
        .select({ userId: taskAssignees.userId })
        .from(taskAssignees)
        .where(eq(taskAssignees.taskId, taskId));
      const before = new Set(rows.map((r) => r.userId));
      const after = new Set(patch.assignees);
      delta = {
        add: [...after].filter((id) => !before.has(id)).map(Number),
        rem: [...before].filter((id) => !after.has(id)).map(Number),
      };

      await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));
      if (patch.assignees.length > 0) {
        await tx
          .insert(taskAssignees)
          .values(patch.assignees.map((assignee) => ({ taskId, userId: assignee })))
          .onConflictDoNothing();
      }
    }

    await tx.insert(outbox).values({
      userId,
      op: "update_task",
      entityId: taskId,
      payload: toClickUpPatch(patch, delta),
    });
  });
}

export async function createTask(
  db: Db,
  input: { userId: string; task: z.infer<typeof newTaskInput> },
): Promise<string> {
  const { userId, task } = input;
  const id = placeholderId(task.clientId);

  await db.transaction(async (tx) => {
    await tx
      .insert(tasks)
      .values({
        id,
        listId: task.listId,
        name: task.name,
        description: task.description ?? null,
        status: task.status ?? null,
        priority: task.priority ?? null,
        dueDate: task.dueDate ? new Date(task.dueDate) : null,
        parentId: task.parentId ?? null,
        dateCreated: new Date(),
        dateUpdated: new Date(),
        creatorId: userId,
      })
      .onConflictDoNothing();

    if (task.assignees.length > 0) {
      await tx
        .insert(taskAssignees)
        .values(task.assignees.map((assignee) => ({ taskId: id, userId: assignee })))
        .onConflictDoNothing();
    }

    await tx.insert(outbox).values({
      userId,
      op: "create_task",
      clientId: task.clientId,
      payload: {
        listId: task.listId,
        name: task.name,
        markdown_content: task.description,
        status: task.status,
        priority: task.priority,
        due_date: task.dueDate,
        assignees: task.assignees.map(Number),
        // ClickUp's own name for it. See NewTask in the client.
        parent: task.parentId,
      },
    });
  });

  return id;
}

/**
 * Posts a comment, or a reply when `parentId` is set.
 *
 * Same shape as `createTask`: the mirror gets a placeholder row keyed on the
 * client's id so the browser sees the comment at once, and the outbox row
 * carries the same client id so the worker can swap in ClickUp's version.
 */
export async function createComment(
  db: Db,
  input: { taskId: string; userId: string; comment: z.infer<typeof newCommentInput> },
): Promise<string> {
  const { taskId, userId, comment } = input;
  const id = placeholderId(comment.clientId);

  await db.transaction(async (tx) => {
    await tx
      .insert(comments)
      .values({
        id,
        taskId,
        parentCommentId: comment.parentId ?? null,
        userId,
        text: comment.text,
        date: new Date(),
      })
      .onConflictDoNothing();

    // The thread header says "2 replies" the moment the second one is typed.
    if (comment.parentId) {
      await tx
        .update(comments)
        .set({ replyCount: sql`${comments.replyCount} + 1` })
        .where(eq(comments.id, comment.parentId));
    }

    await tx.insert(outbox).values({
      userId,
      op: "create_comment",
      entityId: taskId,
      clientId: comment.clientId,
      payload: { taskId, text: comment.text, parentId: comment.parentId ?? null },
    });
  });

  return id;
}

export interface CommentOwner {
  id: string;
  taskId: string;
  userId: string | null;
  text: string | null;
  /** ClickUp's own body, kept so a resolve can put it back untouched. */
  segments: unknown[] | null;
  resolved: boolean;
  parentCommentId: string | null;
}

/**
 * True when the flat text is the whole comment.
 *
 * ClickUp's PUT replaces the body, and all we could send for a rich comment is
 * its flattened text — which would delete the screenshot, the table, or the
 * file that made it rich. Editing is offered only where the round trip is
 * lossless; everything else keeps its Open in ClickUp link.
 */
export function isEditable(comment: Pick<CommentOwner, "segments">): boolean {
  const segments = comment.segments;
  if (!segments) return true;
  return segments.every((segment) => {
    const kind = (segment as { type?: string }).type;
    return kind === undefined || kind === "tag";
  });
}

export async function findComment(db: Db, commentId: string): Promise<CommentOwner | null> {
  const [row] = await db
    .select({
      id: comments.id,
      taskId: comments.taskId,
      userId: comments.userId,
      text: comments.text,
      segments: comments.segments,
      resolved: comments.resolved,
      parentCommentId: comments.parentCommentId,
    })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);
  return row ?? null;
}

/**
 * Edits a comment's body, resolves it, or both.
 *
 * ClickUp's PUT treats `comment_text` and `resolved` as required and blanks
 * whatever is left out, so the queued payload always carries the full resulting
 * state rather than the delta the caller sent.
 */
export async function applyCommentPatch(
  db: Db,
  input: { comment: CommentOwner; userId: string; patch: CommentPatchInput },
): Promise<void> {
  const { comment, userId, patch } = input;
  const text = patch.text ?? comment.text ?? "";
  const resolved = patch.resolved ?? comment.resolved;

  /*
   * Resolving must not rewrite the body.
   *
   * ClickUp requires `comment_text` on PUT and replaces the comment with it, so
   * resolving a comment that held a screenshot used to post its flattened text
   * and delete the image upstream. When the body is not being edited, the
   * original segments go back exactly as they arrived.
   */
  const segments = patch.text === undefined ? comment.segments : null;

  await db.transaction(async (tx) => {
    await tx
      .update(comments)
      .set({
        text,
        resolved,
        syncedAt: new Date(),
        // A rewritten body makes the mirrored rich version a description of a
        // comment that no longer exists. Dropping it falls the UI back to the
        // text we just wrote; ingest refills it when ClickUp answers. Resolving
        // alone must leave it, or resolving a screenshot would erase it.
        ...(patch.text !== undefined ? { editedAt: new Date(), markdown: null } : {}),
      })
      .where(eq(comments.id, comment.id));

    await tx.insert(outbox).values({
      userId,
      op: "update_comment",
      entityId: comment.taskId,
      payload: {
        taskId: comment.taskId,
        commentId: comment.id,
        // Carried so a rejected edit is repaired from the right endpoint: a
        // reply is only readable through its thread, never the task's list.
        parentId: comment.parentCommentId,
        text,
        segments,
        resolved,
      },
    });
  });
}

export async function deleteComment(
  db: Db,
  input: { comment: CommentOwner; userId: string },
): Promise<void> {
  const { comment, userId } = input;

  await db.transaction(async (tx) => {
    await tx.delete(comments).where(eq(comments.id, comment.id));
    // Its own replies go with it; ClickUp does the same on its side.
    await tx.delete(comments).where(eq(comments.parentCommentId, comment.id));

    if (comment.parentCommentId) {
      await tx
        .update(comments)
        .set({ replyCount: sql`greatest(${comments.replyCount} - 1, 0)` })
        .where(eq(comments.id, comment.parentCommentId));
    }

    await tx.insert(outbox).values({
      userId,
      op: "delete_comment",
      entityId: comment.taskId,
      payload: {
        taskId: comment.taskId,
        commentId: comment.id,
        parentId: comment.parentCommentId,
      },
    });
  });
}

/**
 * Drops a comment that never reached ClickUp.
 *
 * A placeholder has no ClickUp id, so there is nothing to delete upstream and
 * nothing to queue — the outbox row is simply withdrawn if it has not been
 * claimed yet.
 */
export async function discardPendingComment(
  db: Db,
  input: { comment: CommentOwner; userId: string },
): Promise<void> {
  const clientId = input.comment.id.replace(/^tmp_/, "");

  await db.transaction(async (tx) => {
    await tx.delete(comments).where(eq(comments.id, input.comment.id));
    if (input.comment.parentCommentId) {
      await tx
        .update(comments)
        .set({ replyCount: sql`greatest(${comments.replyCount} - 1, 0)` })
        .where(eq(comments.id, input.comment.parentCommentId));
    }
    await tx.delete(outbox).where(and(eq(outbox.clientId, clientId), eq(outbox.status, "pending")));
  });
}

// --- Checklists -----------------------------------------------------------

/*
 * Checklists follow the same two-step as everything else here: the mirror is
 * written and an outbox row queued in one transaction, and the route answers
 * with the whole refreshed task detail. The detail is the unit because the task
 * collection carries no checklists, so there is nothing for the browser to
 * patch into — the same reason comment writes answer that way.
 */

export const newChecklistInput = z.object({
  name: z.string().min(1).max(255),
  clientId: z.string().min(1).max(64),
});

export const checklistPatchInput = z.object({ name: z.string().min(1).max(255) });

export const newChecklistItemInput = z.object({
  name: z.string().min(1).max(2000),
  clientId: z.string().min(1).max(64),
});

export const checklistItemPatchInput = z
  .object({
    name: z.string().min(1).max(2000).optional(),
    resolved: z.boolean().optional(),
  })
  .refine((patch) => patch.name !== undefined || patch.resolved !== undefined, {
    message: "nothing to change",
  });
export type ChecklistItemPatchInput = z.infer<typeof checklistItemPatchInput>;

export interface ChecklistOwner {
  id: string;
  taskId: string;
  name: string;
}

export interface ChecklistItemOwner {
  id: string;
  checklistId: string;
  taskId: string;
  name: string;
  resolved: boolean;
}

export async function findChecklist(db: Db, checklistId: string): Promise<ChecklistOwner | null> {
  const [row] = await db
    .select({ id: taskChecklists.id, taskId: taskChecklists.taskId, name: taskChecklists.name })
    .from(taskChecklists)
    .where(eq(taskChecklists.id, checklistId))
    .limit(1);
  return row ?? null;
}

/** The item plus the task it hangs off, which is what the outbox row is keyed on. */
export async function findChecklistItem(
  db: Db,
  itemId: string,
): Promise<ChecklistItemOwner | null> {
  const [row] = await db
    .select({
      id: checklistItems.id,
      checklistId: checklistItems.checklistId,
      taskId: taskChecklists.taskId,
      name: checklistItems.name,
      resolved: checklistItems.resolved,
    })
    .from(checklistItems)
    .innerJoin(taskChecklists, eq(taskChecklists.id, checklistItems.checklistId))
    .where(eq(checklistItems.id, itemId))
    .limit(1);
  return row ?? null;
}

export async function createChecklist(
  db: Db,
  input: { taskId: string; userId: string; checklist: z.infer<typeof newChecklistInput> },
): Promise<string> {
  const { taskId, userId, checklist } = input;
  const id = placeholderId(checklist.clientId);

  await db.transaction(async (tx) => {
    await tx
      .insert(taskChecklists)
      .values({ id, taskId, name: checklist.name, dateCreated: new Date() })
      .onConflictDoNothing();

    await tx.insert(outbox).values({
      userId,
      op: "create_checklist",
      entityId: taskId,
      clientId: checklist.clientId,
      payload: { taskId, name: checklist.name },
    });
  });

  return id;
}

export async function renameChecklist(
  db: Db,
  input: { checklist: ChecklistOwner; userId: string; name: string },
): Promise<void> {
  const { checklist, userId, name } = input;

  await db.transaction(async (tx) => {
    await tx
      .update(taskChecklists)
      .set({ name, syncedAt: new Date() })
      .where(eq(taskChecklists.id, checklist.id));

    await tx.insert(outbox).values({
      userId,
      op: "update_checklist",
      entityId: checklist.taskId,
      payload: { taskId: checklist.taskId, checklistId: checklist.id, name },
    });
  });
}

export async function deleteChecklist(
  db: Db,
  input: { checklist: ChecklistOwner; userId: string },
): Promise<void> {
  const { checklist, userId } = input;

  await db.transaction(async (tx) => {
    // Items go with it through the cascade, exactly as they do upstream.
    await tx.delete(taskChecklists).where(eq(taskChecklists.id, checklist.id));

    await tx.insert(outbox).values({
      userId,
      op: "delete_checklist",
      entityId: checklist.taskId,
      payload: { taskId: checklist.taskId, checklistId: checklist.id },
    });
  });
}

export async function createChecklistItem(
  db: Db,
  input: { checklist: ChecklistOwner; userId: string; item: z.infer<typeof newChecklistItemInput> },
): Promise<string> {
  const { checklist, userId, item } = input;
  const id = placeholderId(item.clientId);

  await db.transaction(async (tx) => {
    await tx
      .insert(checklistItems)
      .values({
        id,
        checklistId: checklist.id,
        name: item.name,
        // No orderindex: ClickUp assigns it. Nulls sort last, so the new item
        // lands at the bottom of the list, which is where it was typed.
        dateCreated: new Date(),
      })
      .onConflictDoNothing();

    await tx.insert(outbox).values({
      userId,
      op: "create_checklist_item",
      entityId: checklist.taskId,
      clientId: item.clientId,
      payload: { taskId: checklist.taskId, checklistId: checklist.id, name: item.name },
    });
  });

  return id;
}

/**
 * Ticks an item, renames it, or both.
 *
 * Unlike the comment endpoint, ClickUp's PUT here is a genuine partial update —
 * a field left out keeps its value — so only what changed is queued. That is
 * what keeps ticking a box from being able to rewrite its text.
 */
export async function applyChecklistItemPatch(
  db: Db,
  input: { item: ChecklistItemOwner; userId: string; patch: ChecklistItemPatchInput },
): Promise<void> {
  const { item, userId, patch } = input;

  await db.transaction(async (tx) => {
    const local: Record<string, unknown> = { syncedAt: new Date() };
    if (patch.name !== undefined) local.name = patch.name;
    if (patch.resolved !== undefined) local.resolved = patch.resolved;

    await tx.update(checklistItems).set(local).where(eq(checklistItems.id, item.id));

    await tx.insert(outbox).values({
      userId,
      op: "update_checklist_item",
      entityId: item.taskId,
      payload: {
        taskId: item.taskId,
        checklistId: item.checklistId,
        itemId: item.id,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.resolved !== undefined ? { resolved: patch.resolved } : {}),
      },
    });
  });
}

export async function deleteChecklistItem(
  db: Db,
  input: { item: ChecklistItemOwner; userId: string },
): Promise<void> {
  const { item, userId } = input;

  await db.transaction(async (tx) => {
    await tx.delete(checklistItems).where(eq(checklistItems.id, item.id));

    await tx.insert(outbox).values({
      userId,
      op: "delete_checklist_item",
      entityId: item.taskId,
      payload: { taskId: item.taskId, checklistId: item.checklistId, itemId: item.id },
    });
  });
}

export const taskTagsInput = z.object({ tags: z.array(z.string().min(1).max(120)).max(50) });

/**
 * Replaces a task's tags.
 *
 * ClickUp has no "set the tags to this list" call — tags go on and off one at a
 * time, by name — so the difference is worked out here and queued as individual
 * operations. Each one can fail on its own, which is honest: a tag that does
 * not exist in the Space is rejected while the others still land.
 */
export async function setTaskTags(
  db: Db,
  input: { taskId: string; userId: string; tags: string[] },
): Promise<void> {
  const { taskId, userId } = input;
  const wanted = [...new Set(input.tags)];

  await db.transaction(async (tx) => {
    const [task] = await tx
      .select({ tags: tasks.tags })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    const before = task?.tags ?? [];
    const beforeNames = new Set(before.map((tag) => tag.name));
    const afterNames = new Set(wanted);

    const added = wanted.filter((name) => !beforeNames.has(name));
    const removed = [...beforeNames].filter((name) => !afterNames.has(name));
    if (added.length === 0 && removed.length === 0) return;

    // Keep the colour of a tag we already had; a new one renders neutral until
    // the next sync brings ClickUp's own colours back.
    await tx
      .update(tasks)
      .set({
        tags: wanted.map(
          (name) => before.find((tag) => tag.name === name) ?? { name, fg: null, bg: null },
        ),
        syncedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    const rows = [
      ...added.map((name) => ({ op: "add_tag" as const, name })),
      ...removed.map((name) => ({ op: "remove_tag" as const, name })),
    ];

    await tx.insert(outbox).values(
      rows.map((row) => ({
        userId,
        op: row.op,
        entityId: taskId,
        payload: { taskId, tag: row.name },
      })),
    );
  });
}

/**
 * A Custom Field value, in the mirror and on its way to ClickUp.
 *
 * This used to queue the outbox row and nothing else, which made it the one
 * write in this file that was not optimistic: the panel refetched, read the
 * value it had just replaced, and showed the old one until the worker drained
 * a couple of seconds later. Worse for a People field, whose menu decides
 * add-versus-remove from what it thinks is on the task — reading a stale value
 * there turns "take Ana off" into a second request to put her on.
 *
 * `mirror` is what the mirror should hold, when that is not what ClickUp is
 * sent: a People field goes up as `{add, rem}` and is stored as the list that
 * leaves behind. Null clears the row, which is how a cleared field is spelled
 * in both directions.
 */
export async function setCustomField(
  db: Db,
  input: {
    taskId: string;
    userId: string;
    fieldId: string;
    value: unknown;
    mirror?: unknown;
  },
): Promise<void> {
  const stored = input.mirror === undefined ? input.value : input.mirror;

  await db.transaction(async (tx) => {
    if (stored === null) {
      await tx
        .delete(taskCustomValues)
        .where(
          and(
            eq(taskCustomValues.taskId, input.taskId),
            eq(taskCustomValues.fieldId, input.fieldId),
          ),
        );
    } else {
      await tx
        .insert(taskCustomValues)
        .values({ taskId: input.taskId, fieldId: input.fieldId, value: stored })
        .onConflictDoUpdate({
          target: [taskCustomValues.taskId, taskCustomValues.fieldId],
          set: { value: stored },
        });
    }

    await tx.insert(outbox).values({
      userId: input.userId,
      op: "set_custom_field",
      entityId: input.taskId,
      payload: { taskId: input.taskId, fieldId: input.fieldId, value: input.value },
    });
  });
}

// --- helpers --------------------------------------------------------------

function toClickUpPatch(
  patch: TaskPatchInput,
  assignees: { add: number[]; rem: number[] } | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.description !== undefined) body.markdown_content = patch.description;
  if (patch.status !== undefined) body.status = patch.status;
  if (patch.priority !== undefined) body.priority = patch.priority;
  if (patch.dueDate !== undefined) body.due_date = patch.dueDate;
  if (assignees) body.assignees = assignees;
  return body;
}
