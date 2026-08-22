import { type Db, outbox, taskAssignees, tasks } from "@rask/schema";
import { eq } from "drizzle-orm";
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

export const newCommentInput = z.object({ text: z.string().min(1).max(50_000) });

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

export async function createComment(
  db: Db,
  input: { taskId: string; userId: string; text: string },
): Promise<void> {
  await db.insert(outbox).values({
    userId: input.userId,
    op: "create_comment",
    entityId: input.taskId,
    payload: { taskId: input.taskId, text: input.text },
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
