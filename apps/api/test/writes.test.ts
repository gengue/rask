import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { comments, createTestDb, outbox, taskAssignees, tasks, users } from "@rask/schema";
import { asc, eq, inArray } from "drizzle-orm";
import {
  applyCommentPatch,
  applyTaskPatch,
  createComment,
  createTask,
  deleteComment,
  discardPendingComment,
  findComment,
} from "../src/writes.ts";

/**
 * The write path against a real database.
 *
 * The assignee delta is the reason this needs Postgres rather than a stub:
 * ClickUp's PUT takes `{ add, rem }` rather than a replacement list, so the new
 * set has to be diffed against the old one *before* the local rows are
 * overwritten. Getting that order wrong produces an empty delta and a change
 * that silently never reaches ClickUp — which is exactly what happened the
 * first time this was written.
 */

const db = createTestDb();

const TASK = "writes-test-task";
const AUTHOR = "9001";
const ALICE = "9002";
const BOB = "9003";

beforeEach(async () => {
  await db
    .insert(users)
    .values([{ id: AUTHOR }, { id: ALICE }, { id: BOB }])
    .onConflictDoNothing();
  await db.delete(outbox).where(eq(outbox.userId, AUTHOR));
  await db.delete(tasks).where(eq(tasks.id, TASK));
  await db
    .insert(tasks)
    .values({ id: TASK, listId: "writes-test-list", name: "before", status: "todo" });
  await db.insert(taskAssignees).values({ taskId: TASK, userId: ALICE });
});

afterEach(async () => {
  await db.delete(outbox).where(eq(outbox.userId, AUTHOR));
  await db.delete(tasks).where(eq(tasks.id, TASK));
  await db.delete(users).where(inArray(users.id, [AUTHOR, ALICE, BOB]));
});

async function queued() {
  const rows = await db.select().from(outbox).where(eq(outbox.userId, AUTHOR));
  return rows;
}

describe("applyTaskPatch", () => {
  test("writes the change locally and queues it in one go", async () => {
    await applyTaskPatch(db, { taskId: TASK, userId: AUTHOR, patch: { status: "done" } });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, TASK));
    expect(task?.status).toBe("done");

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.op).toBe("update_task");
    expect(rows[0]?.entityId).toBe(TASK);
    expect(rows[0]?.payload).toEqual({ status: "done" });
  });

  test("diffs assignees against the previous set, not the one just written", async () => {
    await applyTaskPatch(db, { taskId: TASK, userId: AUTHOR, patch: { assignees: [BOB] } });

    const rows = await queued();
    expect(rows[0]?.payload).toEqual({ assignees: { add: [Number(BOB)], rem: [Number(ALICE)] } });

    const links = await db.select().from(taskAssignees).where(eq(taskAssignees.taskId, TASK));
    expect(links.map((l) => l.userId)).toEqual([BOB]);
  });

  test("clearing every assignee removes them all rather than sending nothing", async () => {
    await applyTaskPatch(db, { taskId: TASK, userId: AUTHOR, patch: { assignees: [] } });

    const rows = await queued();
    expect(rows[0]?.payload).toEqual({ assignees: { add: [], rem: [Number(ALICE)] } });
  });

  test("sends only the fields that changed", async () => {
    await applyTaskPatch(db, {
      taskId: TASK,
      userId: AUTHOR,
      patch: { name: "after", dueDate: null },
    });

    const rows = await queued();
    expect(rows[0]?.payload).toEqual({ name: "after", due_date: null });
  });

  test("converts a due date to the epoch milliseconds ClickUp expects", async () => {
    const due = Date.UTC(2026, 8, 1, 12);
    await applyTaskPatch(db, { taskId: TASK, userId: AUTHOR, patch: { dueDate: due } });

    const rows = await queued();
    expect(rows[0]?.payload).toEqual({ due_date: due });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, TASK));
    expect(task?.dueDate?.getTime()).toBe(due);
  });
});

describe("createTask", () => {
  test("inserts a placeholder the browser can already see and queues the create", async () => {
    const id = await createTask(db, {
      userId: AUTHOR,
      task: {
        listId: "writes-test-list",
        name: "brand new",
        assignees: [ALICE],
        clientId: "client-123",
      },
    });

    expect(id).toBe("tmp_client-123");

    const [placeholder] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(placeholder?.name).toBe("brand new");

    const rows = await queued();
    expect(rows[0]?.op).toBe("create_task");
    expect(rows[0]?.clientId).toBe("client-123");
    expect(rows[0]?.payload).toMatchObject({ listId: "writes-test-list", name: "brand new" });

    await db.delete(tasks).where(eq(tasks.id, id));
  });
});

/**
 * Comment writes go through the same mirror-then-queue transaction as tasks,
 * with two wrinkles Postgres is the only place to check: an optimistic reply
 * has to move its parent's reply count, and ClickUp's PUT blanks whatever the
 * body leaves out, so the queued payload has to hold the *resulting* comment
 * rather than the fields the caller changed.
 */
describe("comments", () => {
  const post = (text: string, clientId: string, parentId?: string) =>
    createComment(db, {
      taskId: TASK,
      userId: AUTHOR,
      comment: { text, clientId, parentId },
    });

  async function seedComment(id: string, over: Partial<typeof comments.$inferInsert> = {}) {
    await db
      .insert(comments)
      .values({ id, taskId: TASK, userId: AUTHOR, text: "original", date: new Date(), ...over })
      .onConflictDoNothing();
    const found = await findComment(db, id);
    if (!found) throw new Error(`seed comment ${id} missing`);
    return found;
  }

  test("posting inserts a placeholder the browser can already see", async () => {
    const id = await post("first", "c-1");
    expect(id).toBe("tmp_c-1");

    const [row] = await db.select().from(comments).where(eq(comments.id, id));
    expect(row?.text).toBe("first");
    // Authorship is what later decides who may edit it, so it is set now and
    // not left for ClickUp to fill in.
    expect(row?.userId).toBe(AUTHOR);
    expect(row?.parentCommentId).toBeNull();

    const rows = await queued();
    expect(rows[0]?.op).toBe("create_comment");
    expect(rows[0]?.entityId).toBe(TASK);
    expect(rows[0]?.clientId).toBe("c-1");
    expect(rows[0]?.payload).toEqual({ taskId: TASK, text: "first", parentId: null });
  });

  test("a reply carries its parent and bumps the thread's count", async () => {
    const parent = await seedComment("parent-1");
    const id = await post("me too", "c-2", parent.id);

    const [reply] = await db.select().from(comments).where(eq(comments.id, id));
    expect(reply?.parentCommentId).toBe(parent.id);

    const [after] = await db.select().from(comments).where(eq(comments.id, parent.id));
    expect(after?.replyCount).toBe(1);

    const rows = await queued();
    expect(rows[0]?.payload).toMatchObject({ parentId: parent.id });
  });

  test("resolving queues the body unchanged, because ClickUp would blank it", async () => {
    const comment = await seedComment("resolve-1");
    await applyCommentPatch(db, { comment, userId: AUTHOR, patch: { resolved: true } });

    const [row] = await db.select().from(comments).where(eq(comments.id, comment.id));
    expect(row?.resolved).toBe(true);
    expect(row?.text).toBe("original");
    // Resolving is not editing, so it leaves no "edited" mark.
    expect(row?.editedAt).toBeNull();

    const rows = await queued();
    expect(rows[0]?.op).toBe("update_comment");
    expect(rows[0]?.entityId).toBe(TASK);
    expect(rows[0]?.payload).toEqual({
      taskId: TASK,
      commentId: comment.id,
      parentId: null,
      text: "original",
      resolved: true,
    });
  });

  test("editing keeps the resolved flag and marks the body as edited", async () => {
    const comment = await seedComment("edit-1", { resolved: true });
    await applyCommentPatch(db, { comment, userId: AUTHOR, patch: { text: "rewritten" } });

    const [row] = await db.select().from(comments).where(eq(comments.id, comment.id));
    expect(row?.text).toBe("rewritten");
    expect(row?.resolved).toBe(true);
    expect(row?.editedAt).not.toBeNull();

    const rows = await queued();
    expect(rows[0]?.payload).toMatchObject({ text: "rewritten", resolved: true });
  });

  test("deleting a comment takes its replies with it", async () => {
    const parent = await seedComment("delete-1");
    await post("reply a", "c-3", parent.id);
    await post("reply b", "c-4", parent.id);
    await db.delete(outbox).where(eq(outbox.userId, AUTHOR));

    await deleteComment(db, { comment: parent, userId: AUTHOR });

    const left = await db
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.taskId, TASK))
      .orderBy(asc(comments.id));
    expect(left).toHaveLength(0);

    const rows = await queued();
    expect(rows[0]?.op).toBe("delete_comment");
    expect(rows[0]?.payload).toEqual({ taskId: TASK, commentId: parent.id, parentId: null });
  });

  test("deleting a reply gives the count back", async () => {
    const parent = await seedComment("delete-2");
    const replyId = await post("mistake", "c-5", parent.id);
    const reply = await findComment(db, replyId);
    if (!reply) throw new Error("reply missing");

    await deleteComment(db, { comment: reply, userId: AUTHOR });

    const [after] = await db.select().from(comments).where(eq(comments.id, parent.id));
    expect(after?.replyCount).toBe(0);
  });

  test("discarding an unsent comment withdraws the queued write instead of queueing another", async () => {
    const parent = await seedComment("discard-1");
    const id = await post("never mind", "c-6", parent.id);
    const pending = await findComment(db, id);
    if (!pending) throw new Error("placeholder missing");

    await discardPendingComment(db, { comment: pending, userId: AUTHOR });

    expect(await findComment(db, id)).toBeNull();
    const [after] = await db.select().from(comments).where(eq(comments.id, parent.id));
    expect(after?.replyCount).toBe(0);
    // ClickUp never heard about it, so nothing is left to tell it about.
    expect(await queued()).toHaveLength(0);
  });
});
