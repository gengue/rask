import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDb, taskAssignees, tasks, users } from "@rask/schema";
import { eq, inArray } from "drizzle-orm";
import { findTaskRef, listSubtasks } from "../src/queries.ts";

/**
 * What a subtask row is allowed to say about itself.
 *
 * The assignee assertion is not a formality. `assigneesJson` correlates on
 * `tasks.id`, and Drizzle only writes that qualified when the outer query has a
 * join — the task list joins `lists`, this query joins nothing. Unqualified,
 * `"id"` binds to the `users` row the subquery itself joined, `ta.task_id =
 * u.id` matches nothing, and every subtask renders as Unassigned while the
 * mirror holds the assignee perfectly well. Nothing else notices: no error, no
 * empty result, just a column of blanks that reads like real data.
 */

const db = createTestDb();

const PARENT = "api-subtasks-parent";
const CHILD = "api-subtasks-child";
const LIST = "api-subtasks-list";
const USER = "api-subtasks-user";

const ids = [PARENT, CHILD, `${CHILD}-2`];

const DUE = new Date("2026-09-01T10:00:00Z");

beforeEach(async () => {
  await db.delete(tasks).where(inArray(tasks.id, ids));
  await db.delete(users).where(eq(users.id, USER));

  await db.insert(users).values({ id: USER, username: "ana", initials: "A", color: "#f00" });
  await db.insert(tasks).values([
    { id: PARENT, listId: LIST, name: "Parent" },
    {
      id: CHILD,
      listId: LIST,
      parentId: PARENT,
      name: "Child",
      orderindex: "1",
      dueDate: DUE,
      timeEstimate: 5_400_000,
      timeSpent: 3_600_000,
    },
    { id: `${CHILD}-2`, listId: LIST, parentId: PARENT, name: "Second child", orderindex: "2" },
  ]);
  await db.insert(taskAssignees).values({ taskId: CHILD, userId: USER });
});

afterEach(async () => {
  await db.delete(tasks).where(inArray(tasks.id, ids));
  await db.delete(users).where(eq(users.id, USER));
});

describe("listSubtasks", () => {
  test("names who a subtask belongs to", async () => {
    const rows = await listSubtasks(db, PARENT);

    expect(rows.map((row) => row.name)).toEqual(["Child", "Second child"]);
    expect(rows[0]?.assignees.map((user) => user.username)).toEqual(["ana"]);
    expect(rows[1]?.assignees).toEqual([]);
  });

  test("carries the columns the panel can be asked to show", async () => {
    // Due date, estimate and tracked time are chosen per browser, so they ride
    // along on every row rather than costing a second request when turned on.
    const [row] = await listSubtasks(db, PARENT);

    expect(row?.dueDate).toEqual(DUE);
    expect(row?.timeEstimate).toBe(5_400_000);
    expect(row?.timeSpent).toBe(3_600_000);
  });
});

describe("findTaskRef", () => {
  test("reads the same row shape, assignees included", async () => {
    // Same columns, same correlated subquery, and also no join to save it.
    const row = await findTaskRef(db, CHILD);

    expect(row?.name).toBe("Child");
    expect(row?.assignees.map((user) => user.username)).toEqual(["ana"]);
  });
});
