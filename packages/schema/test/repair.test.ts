import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clickUpTask } from "@rask/clickup-client";
import { asc, eq } from "drizzle-orm";
import taskFixture from "../../clickup-client/test/fixtures/task.json" with { type: "json" };
import { ingestTasks, markTaskDeleted } from "../src/ingest.ts";
import { taskAssignees, tasks } from "../src/schema.ts";
import { createTestDb } from "../src/test-db.ts";

/**
 * The upsert's skip guard, and the `force` escape hatch that turns it off.
 *
 * `setWhere: date_updated IS DISTINCT FROM excluded.date_updated` exists so the
 * nightly full resync does not rewrite 147,000 unchanged rows and push every
 * one of them down every open SSE connection. That is the right call for a
 * poll, and exactly the wrong one for a repair.
 *
 * A repair happens when ClickUp *rejected* an optimistic write. The mirror is
 * holding a status ClickUp never accepted, and ClickUp's `date_updated` is
 * unchanged precisely because it refused the change — so the guard reads the
 * read-back as "nothing to do" and skips it. Everything ingest replaces
 * unconditionally (assignees, custom values, attachments, checklists) reverts
 * anyway, and the guarded columns do not. The row ends up half repaired, with a
 * status nobody upstream has ever agreed to, and nothing will ever correct it
 * because the guard will keep saying no.
 */

const db = createTestDb();

const TASK = "repair-test-task";
const LIST = "repair-test-list";

/** ClickUp's truth. Status "in progress", priority 2, one assignee. */
function truth(over: Record<string, unknown> = {}) {
  return clickUpTask.parse({ ...taskFixture, id: TASK, list: { id: LIST }, ...over });
}

const CLICKUP_UPDATED = new Date(Number(taskFixture.date_updated));
const CLICKUP_DUE = new Date(Number(taskFixture.due_date));

/**
 * What `applyTaskPatch` leaves behind: the columns the user changed, written
 * straight into the mirror, and `date_updated` deliberately untouched because
 * ClickUp has not been asked yet, let alone answered.
 */
async function optimisticPatch() {
  await db
    .update(tasks)
    .set({
      status: "done",
      name: "renamed in the browser",
      priority: 1,
      dueDate: new Date("2030-01-01T00:00:00Z"),
      syncedAt: new Date(),
    })
    .where(eq(tasks.id, TASK));
  await db.delete(taskAssignees).where(eq(taskAssignees.taskId, TASK));
}

async function stored() {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, TASK)).limit(1);
  return row ?? null;
}

async function assignees() {
  const rows = await db
    .select({ userId: taskAssignees.userId })
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, TASK))
    .orderBy(asc(taskAssignees.userId));
  return rows.map((r) => r.userId);
}

/** Backdates synced_at so "did this write touch the row" is not a race on the clock. */
const LONG_AGO = new Date("2020-01-01T00:00:00Z");
async function backdate() {
  await db.update(tasks).set({ syncedAt: LONG_AGO }).where(eq(tasks.id, TASK));
}

beforeEach(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
});

afterEach(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
});

describe("repairing a rejected write", () => {
  test("puts back every column, not only the ones outside the guard", async () => {
    // The half-repaired row is the bug this pins. If the guarded columns and
    // the unconditionally replaced ones disagree after a repair, the task shows
    // ClickUp's assignees next to a status ClickUp refused — and the user has
    // already been told the write failed, so they are looking right at it.
    await ingestTasks(db, [truth()]);
    await optimisticPatch();

    // ClickUp rejected the PUT, so the read-back carries the same date_updated
    // it had before anybody touched anything.
    const result = await ingestTasks(db, [truth()], { force: true });

    const row = await stored();
    expect(row?.status).toBe("in progress");
    expect(row?.name).toBe("Faster app launch");
    expect(row?.priority).toBe(2);
    expect(row?.dueDate).toEqual(CLICKUP_DUE);
    expect(await assignees()).toEqual(["183"]);
    expect(result.changed).toBe(1);
  });

  test("reports the repair, so the change feed pushes it to the open tab", async () => {
    // synced_at is what the API's change feed polls. A repair the feed cannot
    // see is a repair the browser never applies: the tab keeps rendering the
    // rejected value until somebody reloads.
    await ingestTasks(db, [truth()]);
    await optimisticPatch();
    await backdate();

    await ingestTasks(db, [truth()], { force: true });

    expect((await stored())?.syncedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  test("clears the deleted flag when ClickUp still has the task", async () => {
    // A 404 during a webhook read-back is read as a deletion, and it is not
    // always one — a permissions blip answers the same way. Nothing moves
    // `date_updated` when that happens, so without force the guard would keep
    // the task buried on every later read of it.
    await ingestTasks(db, [truth()]);
    await markTaskDeleted(db, TASK);
    expect((await stored())?.deletedAt).toBeInstanceOf(Date);

    await ingestTasks(db, [truth()], { force: true });

    expect((await stored())?.deletedAt).toBeNull();
  });

  test("still trusts ClickUp's date_updated rather than inventing a newer one", async () => {
    // The column feeds `date_updated_gt` on the next incremental poll. Writing
    // a local clock value here would move the poll cursor past changes made by
    // other people in the seconds either side of the repair, and those tasks
    // would then only reappear on the nightly full resync.
    await ingestTasks(db, [truth()]);
    await optimisticPatch();

    await ingestTasks(db, [truth()], { force: true });

    expect((await stored())?.dateUpdated).toEqual(CLICKUP_UPDATED);
  });
});

describe("the skip guard, when nothing is being repaired", () => {
  test("does not rewrite a row ClickUp has not touched", async () => {
    // The nightly resync re-reads every task on purpose. If each unchanged row
    // came back as a write, synced_at would move on all of them and the change
    // feed would push the entire mirror to every connected browser at 3am.
    await ingestTasks(db, [truth()]);
    await backdate();

    const result = await ingestTasks(db, [truth()]);

    expect(result.changed).toBe(0);
    expect((await stored())?.syncedAt).toEqual(LONG_AGO);
  });

  test("still writes a row ClickUp really did touch", async () => {
    // The other half of the same guarantee: a resync that skipped a genuine
    // change would leave the mirror permanently behind, and the guard is a
    // single SQL predicate away from doing exactly that.
    await ingestTasks(db, [truth()]);
    await backdate();

    const result = await ingestTasks(db, [
      truth({ date_updated: String(CLICKUP_UPDATED.getTime() + 60_000), name: "edited upstream" }),
    ]);

    expect(result.changed).toBe(1);
    expect((await stored())?.name).toBe("edited upstream");
  });

  test("reports what it skipped as a cursor anyway", async () => {
    // `newestUpdate` is the next poll's `date_updated_gt`. It has to come from
    // the batch, not from the rows that happened to be written, or a page where
    // every task was already mirrored would rewind the cursor to the page
    // before it and the poll would walk the same tasks forever.
    await ingestTasks(db, [truth()]);

    const result = await ingestTasks(db, [truth()]);

    expect(result.changed).toBe(0);
    expect(result.newestUpdate).toEqual(CLICKUP_UPDATED);
  });
});

/**
 * Tracking time against a task changes its total and nothing else.
 *
 * ClickUp is not obliged to bump `date_updated` for it, and the guard reads an
 * unchanged `date_updated` as "nothing to do". So the timer stops, ClickUp
 * records the interval, the read-back arrives carrying the new `time_spent` —
 * and the upsert throws it away. There is no error anywhere: the task detail
 * just keeps showing yesterday's total, forever.
 *
 * `syncTask` in the worker and `refreshTask` in the API both force for this
 * reason. These two tests are what says so.
 */
describe("time tracked against a task", () => {
  test("is dropped when the read-back is not forced", async () => {
    await ingestTasks(db, [truth({ time_spent: 3_600_000 })]);

    // Same date_updated: ClickUp did not consider the task itself edited.
    const result = await ingestTasks(db, [truth({ time_spent: 7_200_000 })]);

    expect(result.changed).toBe(0);
    expect((await stored())?.timeSpent).toBe(3_600_000);
  });

  test("lands when it is", async () => {
    await ingestTasks(db, [truth({ time_spent: 3_600_000 })]);
    await backdate();

    const result = await ingestTasks(db, [truth({ time_spent: 7_200_000 })], { force: true });

    expect(result.changed).toBe(1);
    expect((await stored())?.timeSpent).toBe(7_200_000);
    // synced_at moved too, so the change feed pushes the new total to the tab
    // that is looking at the task right now.
    expect((await stored())?.syncedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  test("a task nobody has tracked stores null, not zero", async () => {
    // The difference is readable: "no time tracked" prints as nothing, and a
    // stored 0 would print as `0m` on every task in the workspace.
    await ingestTasks(db, [truth({ time_spent: null })]);
    expect((await stored())?.timeSpent).toBeNull();
  });
});
