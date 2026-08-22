import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDb, outbox, taskAssignees, tasks, users } from "@rask/schema";
import { eq, inArray } from "drizzle-orm";
import { applyTaskPatch, createTask } from "../src/writes.ts";

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

const db = createDb(process.env.DATABASE_URL ?? "postgres://rask:rask@localhost:5432/rask", {
  max: 1,
});

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
