import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clickUpChecklist, clickUpTask } from "@rask/clickup-client";
import { asc, eq } from "drizzle-orm";
import checklistFixture from "../../clickup-client/test/fixtures/checklist.json" with {
  type: "json",
};
import taskFixture from "../../clickup-client/test/fixtures/task.json" with { type: "json" };
import { ingestChecklist, ingestTasks } from "../src/ingest.ts";
import { checklistItems, taskChecklists, tasks } from "../src/schema.ts";
import { createTestDb } from "../src/test-db.ts";

/**
 * Checklist ingest against a real database.
 *
 * Two things are only visible here. The first is the same trap attachments
 * fell into: only `GET /task/{id}` reports checklists, so a list poll that read
 * the missing key as "there are none" would empty the table for every task in
 * the list and refill it the next time somebody opened one.
 *
 * The second is the cascade. Items hang off their checklist with an ON DELETE
 * CASCADE, which is what makes replacing a task's checklists one statement —
 * and what would silently take every item with it if the delete ever ran
 * against a task the payload said nothing about.
 */

const db = createTestDb();

const TASK = "checklists-test-task";
const CHECKLIST = "f66e2c95-ab84-463b-8b5d-3754a97ec1e7";

function payload(over: Record<string, unknown> = {}) {
  return clickUpTask.parse({
    ...taskFixture,
    id: TASK,
    list: { id: "checklists-test-list" },
    ...over,
  });
}

function checklist(over: Record<string, unknown> = {}) {
  return { ...checklistFixture, task_id: TASK, ...over };
}

async function storedLists() {
  return db
    .select({ id: taskChecklists.id, name: taskChecklists.name })
    .from(taskChecklists)
    .where(eq(taskChecklists.taskId, TASK))
    .orderBy(asc(taskChecklists.orderindex));
}

async function storedItems(checklistId = CHECKLIST) {
  return db
    .select({
      id: checklistItems.id,
      name: checklistItems.name,
      resolved: checklistItems.resolved,
      assigneeId: checklistItems.assigneeId,
      parentItemId: checklistItems.parentItemId,
    })
    .from(checklistItems)
    .where(eq(checklistItems.checklistId, checklistId))
    .orderBy(asc(checklistItems.orderindex));
}

beforeEach(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
});

afterEach(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
});

describe("ingestTasks", () => {
  test("mirrors a task's checklists and their items", async () => {
    await ingestTasks(db, [payload({ checklists: [checklist()] })]);

    expect(await storedLists()).toEqual([{ id: CHECKLIST, name: "Release steps" }]);
    expect((await storedItems()).map((item) => item.name)).toEqual([
      "Tag the release",
      "Run the migrations",
      "Announce it in the channel",
    ]);
  });

  test("round-trips the tick, the assignee and the nesting through Postgres", async () => {
    await ingestTasks(db, [payload({ checklists: [checklist()] })]);
    const items = await storedItems();

    expect(items[0]?.resolved).toBe(true);
    expect(items[1]?.resolved).toBe(false);
    expect(items[1]?.assigneeId).toBe("183");
    expect(items[2]?.parentItemId).toBe("b851599b-ac59-4e52-b15a-ec2a18921647");
  });

  test("leaves them alone when the payload never mentioned checklists", async () => {
    await ingestTasks(db, [payload({ checklists: [checklist()] })]);

    // Exactly what a list poll sends: no `checklists` key at all.
    const { checklists: _absent, ...listPage } = taskFixture;
    await ingestTasks(db, [
      clickUpTask.parse({ ...listPage, id: TASK, list: { id: "checklists-test-list" } }),
    ]);

    expect(await storedLists()).toHaveLength(1);
    expect(await storedItems()).toHaveLength(3);
  });

  test("empties them when ClickUp really says there are none", async () => {
    await ingestTasks(db, [payload({ checklists: [checklist()] })]);
    await ingestTasks(db, [payload({ checklists: [] })]);

    expect(await storedLists()).toEqual([]);
  });

  test("a re-read replaces the items rather than duplicating them", async () => {
    await ingestTasks(db, [payload({ checklists: [checklist()] })]);
    await ingestTasks(db, [
      payload({
        // A different `date_updated`, or the task upsert skips the row entirely.
        date_updated: "1787165300000",
        checklists: [
          checklist({ items: [{ ...checklistFixture.items[0], name: "Tag the release again" }] }),
        ],
      }),
    ]);

    expect((await storedItems()).map((item) => item.name)).toEqual(["Tag the release again"]);
  });
});

describe("ingestChecklist", () => {
  test("retires the optimistic placeholder the write path inserted", async () => {
    await ingestTasks(db, [payload({ checklists: [checklist({ items: [] })] })]);
    await db
      .insert(checklistItems)
      .values({ id: "tmp_abc", checklistId: CHECKLIST, name: "typed a second ago" });

    await ingestChecklist(db, TASK, clickUpChecklist.parse(checklist()));

    expect((await storedItems()).map((item) => item.id)).not.toContain("tmp_abc");
    expect(await storedItems()).toHaveLength(3);
  });

  test("inserts a checklist the mirror has never seen", async () => {
    await ingestTasks(db, [payload({ checklists: [] })]);

    await ingestChecklist(db, TASK, clickUpChecklist.parse(checklist()));

    expect(await storedLists()).toEqual([{ id: CHECKLIST, name: "Release steps" }]);
  });
});
