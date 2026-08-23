import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDb, listViews, tasks } from "@rask/schema";
import { eq } from "drizzle-orm";
import { findListView, listTasks, listViewsFor, resolveRefs } from "../src/queries.ts";

/**
 * The tab bar's read model.
 *
 * The ordering is the part worth a test: it is three rules deep and none of
 * them is documented. Both fixtures below are the real shape of a list in the
 * Ventura workspace, where sorting by `orderindex` alone puts the wrong tab
 * first — see `listViewsFor`.
 */

const db = createTestDb();

const LIST = "api-views-test-list";
const OTHER = "api-views-test-other";

function view(over: Partial<typeof listViews.$inferInsert>) {
  return {
    id: "v",
    listId: LIST,
    name: "View",
    type: "list",
    orderindex: 1,
    isDefault: false,
    showClosed: false,
    ...over,
  };
}

beforeEach(async () => {
  await db.delete(listViews).where(eq(listViews.listId, LIST));
  await db.delete(listViews).where(eq(listViews.listId, OTHER));
});

afterEach(async () => {
  await db.delete(listViews).where(eq(listViews.listId, LIST));
  await db.delete(listViews).where(eq(listViews.listId, OTHER));
});

describe("listViewsFor", () => {
  test("puts the chat view first and the default second, then orderindex", async () => {
    // List 901516038590: ClickUp draws Channel, All, Board, Ventura AI, …
    await db
      .insert(listViews)
      .values([
        view({ id: "board-builtin", name: "Board", type: "board", orderindex: 1 }),
        view({ id: "gh-96195", name: "Ventura AI", type: "board", orderindex: 2 }),
        view({ id: "gh-84055", name: "All", type: "board", orderindex: 3, isDefault: true }),
        view({ id: "gh-96335", name: "Ventura AI list", orderindex: 4 }),
        view({ id: "list-builtin", name: "All", orderindex: 5 }),
        view({ id: "chat", name: "AI Tasks", type: "conversation", orderindex: 7 }),
        view({ id: "gh-91895", name: "AI wish form", type: "form", orderindex: 8 }),
      ]);

    expect((await listViewsFor(db, LIST)).map((row) => row.name)).toEqual([
      "AI Tasks",
      "All",
      "Board",
      "Ventura AI",
      "Ventura AI list",
      "All",
      "AI wish form",
    ]);
  });

  test("lifts a default that sits sixty views down", async () => {
    // List 5345534: the default is a dashboard at orderindex 90.
    await db
      .insert(listViews)
      .values([
        view({ id: "gh-16925", name: "Open by Assignee", orderindex: 6 }),
        view({ id: "gh-27255", name: "Open by Team", orderindex: 7 }),
        view({ id: "gh-91595", name: "IT Overview", type: "dashboard", orderindex: 90 }),
      ]);
    expect((await listViewsFor(db, LIST))[0]?.name).toBe("Open by Assignee");

    await db.update(listViews).set({ isDefault: true }).where(eq(listViews.id, "gh-91595"));

    expect((await listViewsFor(db, LIST)).map((row) => row.name)).toEqual([
      "IT Overview",
      "Open by Assignee",
      "Open by Team",
    ]);
  });

  test("sorts a view with no orderindex last, not first", async () => {
    await db
      .insert(listViews)
      .values([
        view({ id: "a", name: "Ordered", orderindex: 40 }),
        view({ id: "b", name: "Unordered", orderindex: null }),
      ]);

    expect((await listViewsFor(db, LIST)).map((row) => row.name)).toEqual(["Ordered", "Unordered"]);
  });

  test("answers for one list only", async () => {
    await db
      .insert(listViews)
      .values([view({ id: "mine" }), view({ id: "theirs", listId: OTHER })]);

    expect((await listViewsFor(db, LIST)).map((row) => row.id)).toEqual(["mine"]);
  });
});

describe("findListView", () => {
  test("carries the list a view belongs to, which is how its tasks are ingested", async () => {
    await db.insert(listViews).values(view({ id: "gh-1", groupField: "dueDate" }));

    const found = await findListView(db, "gh-1");
    expect(found?.listId).toBe(LIST);
    expect(found?.groupField).toBe("dueDate");
    expect(await findListView(db, "gh-nope")).toBeNull();
  });
});

describe("resolveRefs", () => {
  test("identifies a view id lifted out of a ClickUp URL", async () => {
    await db.insert(listViews).values(view({ id: "gh-1", name: "Ventura AI list" }));

    expect(await resolveRefs(db, ["gh-1", "v", "529"])).toEqual({
      kind: "view",
      viewId: "gh-1",
      listId: LIST,
      name: "Ventura AI list",
    });
  });
});

describe("listTasks by id", () => {
  const TASK = "api-views-test-task";

  beforeEach(async () => {
    await db.delete(tasks).where(eq(tasks.id, TASK));
    await db.insert(tasks).values({ id: TASK, listId: LIST, name: "in the view" });
  });

  afterEach(async () => {
    await db.delete(tasks).where(eq(tasks.id, TASK));
  });

  test("returns exactly the tasks ClickUp said the view holds", async () => {
    const rows = await listTasks(db, { taskIds: [TASK, "not-mirrored"] });
    expect(rows.map((row) => row.id)).toEqual([TASK]);
  });

  test("a view that matches nothing is empty, not unfiltered", async () => {
    // `in ()` is not valid SQL; dropping the clause instead would return the
    // whole mirror as though the view held every task there is.
    expect(await listTasks(db, { taskIds: [] })).toEqual([]);
  });
});
