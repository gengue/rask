import { comments, type Db, outbox, taskAssignees, tasks } from "@rask/schema";
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

export function placeholderId(clientId: string): string {
  return `tmp_${clientId}`;
}

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
  resolved: boolean;
  parentCommentId: string | null;
}

export async function findComment(db: Db, commentId: string): Promise<CommentOwner | null> {
  const [row] = await db
    .select({
      id: comments.id,
      taskId: comments.taskId,
      userId: comments.userId,
      text: comments.text,
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

export async function setCustomField(
  db: Db,
  input: { taskId: string; userId: string; fieldId: string; value: unknown },
): Promise<void> {
  await db.insert(outbox).values({
    userId: input.userId,
    op: "set_custom_field",
    entityId: input.taskId,
    payload: { taskId: input.taskId, fieldId: input.fieldId, value: input.value },
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
