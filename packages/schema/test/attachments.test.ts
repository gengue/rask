import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clickUpTask } from "@rask/clickup-client";
import { asc, eq } from "drizzle-orm";
import taskFixture from "../../clickup-client/test/fixtures/task.json" with { type: "json" };
import { ingestTasks } from "../src/ingest.ts";
import { taskAttachments, tasks } from "../src/schema.ts";
import { createTestDb } from "../src/test-db.ts";

/**
 * Attachment ingest against a real database.
 *
 * The case worth a test is the one that is invisible in a unit test: only
 * `GET /task/{id}` reports attachments, and every list endpoint omits the key
 * entirely. A poll that read the silence as "no files" would empty the table
 * for every task in the list, and the rows would come back the next time
 * somebody opened one — which looks like flakiness, not like a bug.
 */

const db = createTestDb();

const TASK = "attachments-test-task";

function payload(over: Record<string, unknown> = {}) {
  return clickUpTask.parse({
    ...taskFixture,
    id: TASK,
    list: { id: "attachments-test-list" },
    ...over,
  });
}

function file(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    date: "1787362173440",
    title: `${id}.png`,
    extension: "png",
    mimetype: "image/png",
    size: 1024,
    url: `https://t529.p.clickup-attachments.com/t529/${id}/image.png`,
    url_w_query: `https://t529.p.clickup-attachments.com/t529/${id}/image.png?view=open`,
    ...over,
  };
}

async function stored() {
  return db
    .select({ id: taskAttachments.id, title: taskAttachments.title })
    .from(taskAttachments)
    .where(eq(taskAttachments.taskId, TASK))
    .orderBy(asc(taskAttachments.id));
}

beforeEach(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
});

afterEach(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
});

describe("ingestTasks", () => {
  test("mirrors the files on a task", async () => {
    await ingestTasks(db, [payload({ attachments: [file("a"), file("b")] })]);

    expect((await stored()).map((row) => row.id)).toEqual(["a", "b"]);
  });

  test("round-trips the size and the timestamp through Postgres", async () => {
    await ingestTasks(db, [payload({ attachments: [file("a", { size: "10916008" })] })]);

    const [row] = await db
      .select({ size: taskAttachments.size, date: taskAttachments.date })
      .from(taskAttachments)
      .where(eq(taskAttachments.taskId, TASK));

    expect(row?.size).toBe(10916008);
    expect(row?.date).toEqual(new Date(1787362173440));
  });

  test("drops files that are gone from a later fetch", async () => {
    await ingestTasks(db, [payload({ attachments: [file("a"), file("b")] })]);
    await ingestTasks(db, [payload({ attachments: [file("b")] })]);

    expect((await stored()).map((row) => row.id)).toEqual(["b"]);
  });

  test("empties the task when ClickUp answers with no files", async () => {
    await ingestTasks(db, [payload({ attachments: [file("a")] })]);
    await ingestTasks(db, [payload({ attachments: [] })]);

    expect(await stored()).toEqual([]);
  });

  test("leaves them alone when the payload never mentioned attachments", async () => {
    await ingestTasks(db, [payload({ attachments: [file("a")] })]);

    const { attachments, ...listShaped } = taskFixture;
    await ingestTasks(db, [
      clickUpTask.parse({ ...listShaped, id: TASK, list: { id: "attachments-test-list" } }),
    ]);

    expect((await stored()).map((row) => row.id)).toEqual(["a"]);
  });

  test("re-reading the same file updates it rather than duplicating it", async () => {
    await ingestTasks(db, [payload({ attachments: [file("a", { title: "before.png" })] })]);
    await ingestTasks(db, [payload({ attachments: [file("a", { title: "after.png" })] })]);

    expect(await stored()).toEqual([{ id: "a", title: "after.png" }]);
  });
});
