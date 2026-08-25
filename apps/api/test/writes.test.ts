import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checklistItems,
  comments,
  createTestDb,
  outbox,
  taskAssignees,
  taskChecklists,
  taskCustomValues,
  tasks,
  users,
} from "@rask/schema";
import { asc, eq, inArray } from "drizzle-orm";
import {
  applyChecklistItemPatch,
  applyCommentPatch,
  applyTaskPatch,
  createChecklist,
  createChecklistItem,
  createComment,
  createTask,
  deleteChecklist,
  deleteComment,
  deleteTask,
  discardPendingComment,
  findChecklist,
  findChecklistItem,
  findComment,
  isEditable,
  setCustomField,
  setTaskTags,
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
const CHILD = "writes-test-child";
const GRANDCHILD = "writes-test-grandchild";
const AUTHOR = "9001";
const ALICE = "9002";
const BOB = "9003";

beforeEach(async () => {
  await db
    .insert(users)
    .values([{ id: AUTHOR }, { id: ALICE }, { id: BOB }])
    .onConflictDoNothing();
  await db.delete(outbox).where(eq(outbox.userId, AUTHOR));
  await db.delete(tasks).where(inArray(tasks.id, [TASK, CHILD, GRANDCHILD]));
  await db
    .insert(tasks)
    .values({ id: TASK, listId: "writes-test-list", name: "before", status: "todo" });
  await db.insert(taskAssignees).values({ taskId: TASK, userId: ALICE });
});

afterEach(async () => {
  await db.delete(outbox).where(eq(outbox.userId, AUTHOR));
  await db.delete(tasks).where(inArray(tasks.id, [TASK, CHILD, GRANDCHILD]));
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

  test("archiving is a patch like any other, and the mirror hides the row at once", async () => {
    await applyTaskPatch(db, { taskId: TASK, userId: AUTHOR, patch: { archived: true } });

    // Every read but the change feed filters `archived = false`, so this alone
    // takes the task out of every view without waiting for ClickUp.
    const [task] = await db.select().from(tasks).where(eq(tasks.id, TASK));
    expect(task?.archived).toBe(true);

    const rows = await queued();
    expect(rows[0]?.op).toBe("update_task");
    expect(rows[0]?.payload).toEqual({ archived: true });
  });
});

describe("deleteTask", () => {
  test("marks the row gone rather than dropping it, and queues the delete", async () => {
    const before = new Date();
    await deleteTask(db, { taskId: TASK, userId: AUTHOR });

    // The row has to survive: the change feed is what tells open browsers to
    // drop the task, and it reads rows, not absences.
    const [task] = await db.select().from(tasks).where(eq(tasks.id, TASK));
    expect(task?.deletedAt).not.toBeNull();
    expect(task?.syncedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());

    const rows = await queued();
    expect(rows[0]?.op).toBe("delete_task");
    expect(rows[0]?.entityId).toBe(TASK);
  });

  test("takes the whole subtree with it, however deep it goes", async () => {
    await db.insert(tasks).values([
      { id: CHILD, listId: "writes-test-list", name: "child", parentId: TASK },
      { id: GRANDCHILD, listId: "writes-test-list", name: "grandchild", parentId: CHILD },
    ]);

    await deleteTask(db, { taskId: TASK, userId: AUTHOR });

    // ClickUp deletes subtasks with their parent. Left in the mirror they are
    // rows pointing at a task nobody can open, and ClickUp nests deeper than
    // one level, so the grandchild is the case a non-recursive delete misses.
    const rows = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, [TASK, CHILD, GRANDCHILD]));
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.deletedAt !== null)).toHaveLength(3);

    // One request, not one per row: ClickUp cascades on its own side.
    expect(await queued()).toHaveLength(1);
  });

  test("names the parent, so its open detail can be told a subtask left it", async () => {
    await db
      .insert(tasks)
      .values({ id: CHILD, listId: "writes-test-list", name: "child", parentId: TASK });

    // Picked out of the returned subtree by id rather than taken from the first
    // row: an UPDATE ... RETURNING has no ordering, and the parent of the
    // grandchild is not the parent anybody asked about.
    expect(await deleteTask(db, { taskId: CHILD, userId: AUTHOR })).toEqual({ parentId: TASK });
    expect(await deleteTask(db, { taskId: TASK, userId: AUTHOR })).toEqual({ parentId: null });
  });

  test("stops rather than spinning when the mirror holds a parent cycle", async () => {
    // `parent_id` has no foreign key and each task's copy of it is written
    // independently, so two deliveries around a re-parent can leave a cycle
    // ClickUp itself never had. Unbounded, the walk below never returns — and
    // it runs in an open transaction in the API's request path, so the failure
    // is a hung request holding row locks rather than a wrong answer.
    await db
      .insert(tasks)
      .values({ id: CHILD, listId: "writes-test-list", name: "child", parentId: TASK });
    await db.update(tasks).set({ parentId: CHILD }).where(eq(tasks.id, TASK));

    expect(await deleteTask(db, { taskId: TASK, userId: AUTHOR })).toEqual({ parentId: CHILD });

    const rows = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, [TASK, CHILD]));
    expect(rows.filter((row) => row.deletedAt !== null)).toHaveLength(2);
  });

  test("says nothing was deleted when there was nothing left to delete", async () => {
    await deleteTask(db, { taskId: TASK, userId: AUTHOR });
    expect(await deleteTask(db, { taskId: TASK, userId: AUTHOR })).toBeNull();
  });

  test("deleting twice queues one delete, not two", async () => {
    await deleteTask(db, { taskId: TASK, userId: AUTHOR });
    await deleteTask(db, { taskId: TASK, userId: AUTHOR });

    // Two clicks on a row that is already on its way out would otherwise send
    // ClickUp a second DELETE, and the second one 404s and reports as a failed
    // write to a user whose delete actually worked.
    expect(await queued()).toHaveLength(1);
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

  test("a subtask carries its parent under ClickUp's own name for it", async () => {
    const id = await createTask(db, {
      userId: AUTHOR,
      task: {
        // ClickUp requires the parent to be in the List named in the path, so
        // the caller sends the parent's list, not whichever one is open.
        listId: "writes-test-list",
        name: "fix issue",
        parentId: TASK,
        assignees: [],
        clientId: "client-sub",
      },
    });

    const [placeholder] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(placeholder?.parentId).toBe(TASK);

    const rows = await queued();
    expect(rows[0]?.payload).toMatchObject({ parent: TASK });

    await db.delete(tasks).where(eq(tasks.id, id));
  });

  test("a top-level task queues no parent at all", async () => {
    const id = await createTask(db, {
      userId: AUTHOR,
      task: { listId: "writes-test-list", name: "standalone", assignees: [], clientId: "client-t" },
    });

    const rows = await queued();
    expect(rows[0]?.payload).not.toHaveProperty("parent");

    await db.delete(tasks).where(eq(tasks.id, id));
  });
});

/**
 * Checklists.
 *
 * The tick is the interesting one. ClickUp's checklist-item PUT is a genuine
 * partial update, unlike the comment PUT next door which blanks whatever it is
 * not given — so the queued payload holds only what changed, and ticking a box
 * is not able to rewrite its text. The other thing Postgres is needed for is
 * the cascade: deleting a checklist has to take its items with it, because
 * that is what ClickUp does upstream.
 */
describe("checklists", () => {
  const CHECKLIST = "writes-test-checklist";

  async function seedChecklist() {
    await db
      .insert(taskChecklists)
      .values({ id: CHECKLIST, taskId: TASK, name: "Release steps", orderindex: 0 })
      .onConflictDoNothing();
    await db
      .insert(checklistItems)
      .values({ id: "writes-test-item", checklistId: CHECKLIST, name: "Tag it", orderindex: 0 })
      .onConflictDoNothing();
    const item = await findChecklistItem(db, "writes-test-item");
    if (!item) throw new Error("expected the item");
    return item;
  }

  test("creating one inserts a placeholder and queues the create", async () => {
    const id = await createChecklist(db, {
      taskId: TASK,
      userId: AUTHOR,
      checklist: { name: "Release steps", clientId: "client-cl" },
    });

    expect(id).toBe("tmp_client-cl");

    const [row] = await db.select().from(taskChecklists).where(eq(taskChecklists.id, id));
    expect(row?.name).toBe("Release steps");

    const rows = await queued();
    expect(rows[0]?.op).toBe("create_checklist");
    expect(rows[0]?.entityId).toBe(TASK);
    expect(rows[0]?.payload).toEqual({ taskId: TASK, name: "Release steps" });
  });

  test("ticking flips the mirror and queues only the tick", async () => {
    const item = await seedChecklist();

    await applyChecklistItemPatch(db, { item, userId: AUTHOR, patch: { resolved: true } });

    const [row] = await db.select().from(checklistItems).where(eq(checklistItems.id, item.id));
    expect(row?.resolved).toBe(true);
    expect(row?.name).toBe("Tag it");

    const rows = await queued();
    expect(rows[0]?.op).toBe("update_checklist_item");
    expect(rows[0]?.entityId).toBe(TASK);
    expect(rows[0]?.payload).toEqual({
      taskId: TASK,
      checklistId: CHECKLIST,
      itemId: item.id,
      resolved: true,
    });
  });

  test("renaming an item leaves the tick out of the payload", async () => {
    const item = await seedChecklist();

    await applyChecklistItemPatch(db, { item, userId: AUTHOR, patch: { name: "Tag the release" } });

    const rows = await queued();
    expect(rows[0]?.payload).toEqual({
      taskId: TASK,
      checklistId: CHECKLIST,
      itemId: item.id,
      name: "Tag the release",
    });
  });

  test("an item knows which task it belongs to, which is what the outbox is keyed on", async () => {
    const item = await seedChecklist();
    expect(item.taskId).toBe(TASK);
  });

  test("deleting a checklist takes its items with it, as ClickUp does", async () => {
    await seedChecklist();
    const checklist = await findChecklist(db, CHECKLIST);
    if (!checklist) throw new Error("expected the checklist");

    await deleteChecklist(db, { checklist, userId: AUTHOR });

    const items = await db
      .select()
      .from(checklistItems)
      .where(eq(checklistItems.checklistId, CHECKLIST));
    expect(items).toHaveLength(0);

    const rows = await queued();
    expect(rows[0]?.op).toBe("delete_checklist");
    expect(rows[0]?.payload).toEqual({ taskId: TASK, checklistId: CHECKLIST });
  });

  test("a new item has no orderindex, so it sorts after everything ClickUp numbered", async () => {
    await seedChecklist();
    const checklist = await findChecklist(db, CHECKLIST);
    if (!checklist) throw new Error("expected the checklist");

    const id = await createChecklistItem(db, {
      checklist,
      userId: AUTHOR,
      item: { name: "Smoke test", clientId: "client-item" },
    });

    const [row] = await db.select().from(checklistItems).where(eq(checklistItems.id, id));
    expect(row?.orderindex).toBeNull();

    const rows = await queued();
    expect(rows[0]?.op).toBe("create_checklist_item");
    expect(rows[0]?.clientId).toBe("client-item");
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
      segments: null,
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

describe("setTaskTags", () => {
  test("queues one operation per tag added and removed", async () => {
    await db
      .update(tasks)
      .set({ tags: [{ name: "infra" }, { name: "flaky" }] })
      .where(eq(tasks.id, TASK));

    await setTaskTags(db, { taskId: TASK, userId: AUTHOR, tags: ["infra", "billing"] });

    const rows = await queued();
    expect(rows.map((r) => [r.op, (r.payload as { tag: string }).tag]).sort()).toEqual([
      ["add_tag", "billing"],
      ["remove_tag", "flaky"],
    ]);
  });

  test("writes the new set locally, keeping colours we already had", async () => {
    await db
      .update(tasks)
      .set({ tags: [{ name: "infra", fg: "#fff", bg: "#0ab4ff" }] })
      .where(eq(tasks.id, TASK));

    await setTaskTags(db, { taskId: TASK, userId: AUTHOR, tags: ["infra", "new"] });

    const [task] = await db.select({ tags: tasks.tags }).from(tasks).where(eq(tasks.id, TASK));
    expect(task?.tags).toEqual([
      { name: "infra", fg: "#fff", bg: "#0ab4ff" },
      { name: "new", fg: null, bg: null },
    ]);
  });

  test("queues nothing when the set is unchanged", async () => {
    await db
      .update(tasks)
      .set({ tags: [{ name: "infra" }] })
      .where(eq(tasks.id, TASK));

    await setTaskTags(db, { taskId: TASK, userId: AUTHOR, tags: ["infra"] });
    expect(await queued()).toHaveLength(0);
  });

  test("removes every tag when given an empty list", async () => {
    await db
      .update(tasks)
      .set({ tags: [{ name: "infra" }, { name: "ios" }] })
      .where(eq(tasks.id, TASK));

    await setTaskTags(db, { taskId: TASK, userId: AUTHOR, tags: [] });

    const rows = await queued();
    expect(rows.every((r) => r.op === "remove_tag")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  test("ignores duplicates rather than queueing the same tag twice", async () => {
    await db.update(tasks).set({ tags: [] }).where(eq(tasks.id, TASK));

    await setTaskTags(db, { taskId: TASK, userId: AUTHOR, tags: ["dup", "dup"] });
    expect(await queued()).toHaveLength(1);
  });
});

describe("setCustomField", () => {
  /*
   * The one write here that used to queue and nothing else.
   *
   * The panel refetches after a field write, so a mirror left holding the old
   * value shows the old value — for as long as the outbox takes, which is a
   * couple of seconds on a good day and unbounded when the worker is behind.
   * A People field makes it worse than cosmetic: its menu decides add-versus-
   * remove from what it believes is on the task, so a stale read turns "take
   * Ana off" into a second request to put her on.
   */
  test("writes the value locally and queues it in one go", async () => {
    await setCustomField(db, { taskId: TASK, userId: AUTHOR, fieldId: "f1", value: "opt-2" });

    const [row] = await db.select().from(taskCustomValues).where(eq(taskCustomValues.taskId, TASK));
    expect(row?.value).toBe("opt-2");

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.op).toBe("set_custom_field");
    expect(rows[0]?.payload).toEqual({ taskId: TASK, fieldId: "f1", value: "opt-2" });
  });

  /* A People field goes up as a delta and is stored as the list it leaves
     behind, which is the whole reason the two are separate arguments. */
  test("stores what the mirror should hold, not what ClickUp is sent", async () => {
    await setCustomField(db, {
      taskId: TASK,
      userId: AUTHOR,
      fieldId: "f2",
      value: { add: [42], rem: [] },
      mirror: [{ id: "42", username: "ana" }],
    });

    const [row] = await db
      .select()
      .from(taskCustomValues)
      .where(eq(taskCustomValues.fieldId, "f2"));
    expect(row?.value).toEqual([{ id: "42", username: "ana" }]);

    const rows = await queued();
    expect(rows[0]?.payload).toEqual({
      taskId: TASK,
      fieldId: "f2",
      value: { add: [42], rem: [] },
    });
  });

  test("clearing it takes the row out rather than storing a null", async () => {
    await setCustomField(db, { taskId: TASK, userId: AUTHOR, fieldId: "f1", value: "opt-2" });
    await setCustomField(db, { taskId: TASK, userId: AUTHOR, fieldId: "f1", value: null });

    const rows = await db.select().from(taskCustomValues).where(eq(taskCustomValues.taskId, TASK));
    expect(rows).toHaveLength(0);
  });
});

describe("resolving a rich comment", () => {
  /**
   * ClickUp's PUT replaces the comment with the text we send, and the text is
   * only a flattening of the body. Resolving one that held a screenshot used to
   * delete the screenshot upstream.
   */
  const RICH = `${TASK}-rich`;
  const segments = [
    { text: "look at this " },
    { type: "image", image: { url: "https://example.invalid/a.png" } },
  ];

  beforeEach(async () => {
    await db.delete(comments).where(eq(comments.id, RICH));
    await db.insert(comments).values({
      id: RICH,
      taskId: TASK,
      userId: AUTHOR,
      text: "look at this image.png",
      segments,
    });
  });

  afterEach(async () => {
    await db.delete(comments).where(eq(comments.id, RICH));
  });

  test("queues the original body so the image survives", async () => {
    const comment = await findComment(db, RICH);
    if (!comment) throw new Error("expected the comment");

    await applyCommentPatch(db, { comment, userId: AUTHOR, patch: { resolved: true } });

    const [row] = await queued();
    expect((row?.payload as { segments: unknown } | undefined)?.segments).toEqual(segments);
  });

  test("an actual edit sends the new text and drops the old body", async () => {
    const comment = await findComment(db, RICH);
    if (!comment) throw new Error("expected the comment");

    await applyCommentPatch(db, { comment, userId: AUTHOR, patch: { text: "rewritten" } });

    const [row] = await queued();
    expect(row?.payload).toMatchObject({ text: "rewritten", segments: null });
  });

  test("is not offered for inline editing in the first place", async () => {
    const comment = await findComment(db, RICH);
    expect(comment ? isEditable(comment) : null).toBe(false);
  });

  test("a mention-only body is still editable", () => {
    expect(isEditable({ segments: [{ text: "hi " }, { type: "tag" }] })).toBe(true);
  });

  test("a comment ClickUp sent no segments for is editable", () => {
    expect(isEditable({ segments: null })).toBe(true);
  });
});
