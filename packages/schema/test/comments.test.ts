import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { ingestComments, ingestReplies } from "../src/ingest.ts";
import { commentMentions, comments, tasks } from "../src/schema.ts";
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

async function mentions(commentId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: commentMentions.userId })
    .from(commentMentions)
    .where(eq(commentMentions.commentId, commentId))
    .orderBy(asc(commentMentions.userId));
  return rows.map((row) => row.userId);
}

async function stored() {
  return db
    .select({ id: comments.id, parent: comments.parentCommentId, replies: comments.replyCount })
    .from(comments)
    .where(eq(comments.taskId, TASK))
    .orderBy(asc(comments.id));
}

/**
 * Who a comment mentions, extracted at ingest.
 *
 * This is the index the inbox asks "did anyone say my name" against, and every
 * failure here is silent: a mention that produces no row is a notification that
 * never arrives, and a row that outlives the words that made it is a
 * notification for something nobody said.
 */
describe("mentions", () => {
  test("records the people a comment tagged", async () => {
    await ingestComments(db, TASK, [
      payload("c1", "@Ada @Linus have a look", {
        comment: [
          { type: "tag", user: { id: 7, username: "Ada" }, text: "@Ada" },
          { text: " " },
          { type: "tag", user: { id: 9, username: "Linus" }, text: "@Linus" },
          { text: " have a look" },
        ],
      }),
    ]);

    expect(await mentions("c1")).toEqual(["7", "9"]);
  });

  test("drops a mention an edit removed", async () => {
    // The stale half. A merge would leave the old row behind, and the person
    // who was un-tagged would keep being told about a comment that no longer
    // names them — with no way to make it stop.
    await ingestComments(db, TASK, [
      payload("c1", "@Ada look", {
        comment: [{ type: "tag", user: { id: 7, username: "Ada" }, text: "@Ada" }],
      }),
    ]);
    await ingestComments(db, TASK, [
      payload("c1", "never mind", { comment: [{ text: "never mind" }] }),
    ]);

    expect(await mentions("c1")).toEqual([]);
  });

  test("records a person tagged twice once", async () => {
    await ingestComments(db, TASK, [
      payload("c1", "@Ada @Ada", {
        comment: [
          { type: "tag", user: { id: 7, username: "Ada" }, text: "@Ada" },
          { type: "tag", user: { id: 7, username: "Ada" }, text: "@Ada" },
        ],
      }),
    ]);

    expect(await mentions("c1")).toEqual(["7"]);
  });

  test("records nothing for a tag ClickUp sent no user for", async () => {
    /*
     * About one tag in ten. The flattened "@Ada" is all we get, and guessing an
     * id from a display name notifies whoever happens to share it — so the
     * mention is simply not represented. See `commentMentions` for what covers
     * the gap instead.
     */
    await ingestComments(db, TASK, [
      payload("c1", "@Ada look", { comment: [{ type: "tag", text: "@Ada" }] }),
    ]);

    expect(await mentions("c1")).toEqual([]);
  });

  test("carries the assignee of a comment ClickUp handed to somebody", async () => {
    // The one comment signal with no parsing behind it.
    await ingestComments(db, TASK, [payload("c1", "yours", { assignee: { id: 7 } })]);

    const [row] = await db
      .select({ assigneeId: comments.assigneeId })
      .from(comments)
      .where(eq(comments.id, "c1"));
    expect(row?.assigneeId).toBe("7");
  });
});

describe("ingestComments", () => {
  test("keeps comments that were not in this page", async () => {
    await ingestComments(db, TASK, [payload("c1", "one"), payload("c2", "two")]);
    await ingestComments(db, TASK, [payload("c2", "two")]);

    expect((await stored()).map((row) => row.id)).toEqual(["c1", "c2"]);
  });

  test("carries the rendered body into the column the UI reads", async () => {
    // The whole point of the column: the flat text ClickUp also sends says
    // "image.png" and nothing else, so a mirror that only stores that has
    // thrown the screenshot away before the UI ever sees it.
    await ingestComments(db, TASK, [
      payload("c1", "@Ada hi\nimage.png\n", {
        comment: [
          { type: "tag", user: { id: 7, username: "Ada" }, text: "@Ada" },
          { text: " hi", attributes: {} },
          { text: "\n", attributes: { "block-id": "b1" } },
          {
            type: "image",
            text: "image.png",
            image: { name: "image.png", url: "https://t529.p.clickup-attachments.com/x/i.png" },
          },
        ],
      }),
    ]);

    const [row] = await db
      .select({ text: comments.text, markdown: comments.markdown })
      .from(comments)
      .where(eq(comments.id, "c1"));

    expect(row?.text).toBe("@Ada hi\nimage.png\n");
    expect(row?.markdown).toBe(
      "@[Ada](clickup://user/7) hi\n" +
        "![image.png](https://t529.p.clickup-attachments.com/x/i.png?view=open)",
    );
  });

  test("a comment that loses its rich body on the way back in clears the column", async () => {
    await ingestComments(db, TASK, [
      payload("c1", "hi", { comment: [{ text: "hi", attributes: { bold: true } }] }),
    ]);
    await ingestComments(db, TASK, [payload("c1", "hi")]);

    const [row] = await db
      .select({ markdown: comments.markdown })
      .from(comments)
      .where(eq(comments.id, "c1"));

    // Otherwise an edit that removed the formatting would keep rendering it.
    expect(row?.markdown).toBeNull();
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
