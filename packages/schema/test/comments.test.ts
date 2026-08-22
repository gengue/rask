import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { ingestComments, ingestReplies } from "../src/ingest.ts";
import { comments, tasks } from "../src/schema.ts";
import { createTestDb } from "../src/test-db.ts";

/**
 * Comment ingest against a real database.
 *
 * The two endpoints behave differently and the difference is the whole point:
 * a task's comment list is paginated, so a comment missing from a batch may
 * simply be older than what we asked for; a thread is not, so a reply missing
 * from a batch really is gone. Getting that backwards either strands deleted
 * replies forever or silently deletes the comments we did not fetch.
 */

const db = createTestDb();

const TASK = "comments-test-task";

/** The subset of a ClickUp comment payload these paths actually read. */
function payload(id: string, text: string, over: Record<string, unknown> = {}) {
  return { id, comment_text: text, date: new Date(), reply_count: 0, ...over };
}

beforeEach(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
  await db.insert(tasks).values({ id: TASK, listId: "comments-test-list", name: "probe" });
});

afterEach(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
});

async function stored() {
  return db
    .select({ id: comments.id, parent: comments.parentCommentId, replies: comments.replyCount })
    .from(comments)
    .where(eq(comments.taskId, TASK))
    .orderBy(asc(comments.id));
}

describe("ingestComments", () => {
  test("keeps comments that were not in this page", async () => {
    await ingestComments(db, TASK, [payload("c1", "one"), payload("c2", "two")]);
    await ingestComments(db, TASK, [payload("c2", "two")]);

    expect((await stored()).map((row) => row.id)).toEqual(["c1", "c2"]);
  });
});

describe("ingestReplies", () => {
  test("attaches replies to their parent and counts them", async () => {
    await ingestComments(db, TASK, [payload("c1", "one", { reply_count: 2 })]);
    await ingestReplies(db, TASK, "c1", [payload("r1", "first"), payload("r2", "second")]);

    expect(await stored()).toEqual([
      { id: "c1", parent: null, replies: 2 },
      { id: "r1", parent: "c1", replies: 0 },
      { id: "r2", parent: "c1", replies: 0 },
    ]);
  });

  test("drops replies ClickUp no longer has, because a thread arrives whole", async () => {
    await ingestComments(db, TASK, [payload("c1", "one")]);
    await ingestReplies(db, TASK, "c1", [payload("r1", "first"), payload("r2", "second")]);
    await ingestReplies(db, TASK, "c1", [payload("r1", "first")]);

    expect(await stored()).toEqual([
      { id: "c1", parent: null, replies: 1 },
      { id: "r1", parent: "c1", replies: 0 },
    ]);
  });

  test("an emptied thread leaves the parent alone", async () => {
    await ingestComments(db, TASK, [payload("c1", "one", { reply_count: 1 })]);
    await ingestReplies(db, TASK, "c1", [payload("r1", "first")]);
    await ingestReplies(db, TASK, "c1", []);

    expect(await stored()).toEqual([{ id: "c1", parent: null, replies: 0 }]);
  });

  test("re-reading the task's comments does not orphan a reply", async () => {
    // The parent's page never carries a parent id, and a naive upsert would
    // write that null straight over the thread the reply belongs to.
    await ingestComments(db, TASK, [payload("c1", "one")]);
    await ingestReplies(db, TASK, "c1", [payload("r1", "first")]);
    await ingestComments(db, TASK, [payload("r1", "first")]);

    const [reply] = await db.select().from(comments).where(eq(comments.id, "r1"));
    expect(reply?.parentCommentId).toBe("c1");
  });
});
