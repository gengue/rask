import { beforeEach, describe, expect, test } from "bun:test";
import type { Task, View } from "../src/lib/api.ts";
import { applyView } from "../src/lib/clickup-views.ts";
import { setUi, ui } from "../src/lib/ui.ts";
import { resetCursor, rowTasks, setViewTasks, setViewTitle } from "../src/lib/view.ts";

/*
 * The cursor following its row is reactive by construction — an effect over
 * `rowTasks` — so this drives the real signals and waits a tick rather than
 * testing a pure helper. That also needs `--conditions browser`, which the
 * package's test script passes: under the server build nothing recomputes and
 * every assertion here would pass without the effect existing at all.
 */

function task(id: string, status: string): Task {
  return {
    id,
    customId: null,
    name: id,
    status,
    statusColor: null,
    statusType: "custom",
    priority: null,
    dueDate: null,
    startDate: null,
    dateUpdated: null,
    dateCreated: null,
    listId: "L",
    spaceId: null,
    parentId: null,
    tags: [],
    url: null,
    listName: "List",
    deletedAt: null,
    archived: false,
    assignees: [],
  };
}

const ids = () => rowTasks().map((row) => row.id);

/** A list tab, which is what `applyView` reads to reset the cursor. */
const tab: View = {
  id: "v1",
  listId: "L",
  name: "Open bugs",
  type: "list",
  isDefault: false,
  groupField: "status",
  showClosed: false,
  publicUrl: null,
};

/** Lets the effect run, and then the one it schedules by moving the cursor. */
const settle = () => Promise.resolve().then(() => Promise.resolve());

let views = 0;

async function show(rows: Task[], cursor: number): Promise<void> {
  // A fresh title each time: the anchor resets with the view, the same way the
  // shell resets the cursor, so one test cannot leave its row anchored in the
  // next.
  setViewTitle(`view-${++views}`);
  setViewTasks(rows);
  setUi("cursor", cursor);
  await settle();
}

beforeEach(() => {
  setUi({ groupBy: "status", showClosed: false, filters: [], search: "" });
});

describe("the cursor follows its row", () => {
  test("a status change moves the cursor with the task it moved", async () => {
    // Groups are ordered by first appearance: todo (A, C) then review (B).
    await show([task("A", "todo"), task("B", "review"), task("C", "todo")], 1);
    expect(ids()).toEqual(["A", "C", "B"]);

    // C joins review, which is the whole bug: B slides into slot 1.
    setViewTasks([task("A", "todo"), task("B", "review"), task("C", "review")]);
    await settle();

    expect(ids()).toEqual(["A", "B", "C"]);
    expect(ui.cursor).toBe(2);
  });

  test("rows arriving above the cursor do not steal it", async () => {
    await show([task("B", "review"), task("C", "todo")], 0);
    expect(ids()).toEqual(["B", "C"]);

    setViewTasks([task("A", "todo"), task("B", "review"), task("C", "todo")]);
    await settle();

    expect(ids()).toEqual(["A", "C", "B"]);
    expect(ui.cursor).toBe(2);
  });

  test("a task that leaves the view leaves the cursor where it was", async () => {
    await show([task("A", "todo"), task("B", "review"), task("C", "todo")], 1);

    setViewTasks([task("A", "todo"), task("B", "review")]);
    await settle();

    expect(ids()).toEqual(["A", "B"]);
    expect(ui.cursor).toBe(1);
  });

  test("j and k still say where the cursor goes", async () => {
    await show([task("A", "todo"), task("B", "review"), task("C", "todo")], 0);

    setUi("cursor", 2);
    await settle();

    expect(ui.cursor).toBe(2);
  });

  test("a new view starts at the top even when it holds the same task", async () => {
    await show([task("A", "todo"), task("B", "review"), task("C", "todo")], 1);

    await show([task("B", "review"), task("C", "todo")], 0);

    expect(ui.cursor).toBe(0);
  });
});

describe("a view change", () => {
  /*
   * The rows on screen when a title changes still belong to the view being
   * left: routes set the two in separate effects, and a tab's rows are a fetch
   * away. Every row of the old set is a row the new one may also hold, so none
   * of them is something to follow.
   */
  test("does not drag the cursor onto a task the next view happens to hold", async () => {
    await show([task("A", "todo"), task("B", "review"), task("C", "todo")], 1);

    setViewTitle("somewhere else");
    await settle();
    setViewTasks([task("X", "todo"), task("Y", "todo"), task("C", "todo")]);
    await settle();

    expect(ui.cursor).toBe(0);
  });

  test("nor onto the row the old view happened to start with", async () => {
    await show([task("A", "todo"), task("B", "review"), task("C", "todo")], 1);

    setViewTitle("somewhere else again");
    await settle();
    setViewTasks([task("X", "todo"), task("Y", "todo"), task("A", "todo")]);
    await settle();

    expect(ui.cursor).toBe(0);
  });

  test("a tab within one list resets it too, title unchanged", async () => {
    await show([task("A", "todo"), task("B", "review"), task("C", "todo")], 1);

    // A tab keeps its list's title, so this is the only thing that resets: the
    // tab's own rows arrive a round trip later.
    applyView(tab);
    await settle();
    setViewTasks([task("X", "todo"), task("Y", "todo"), task("A", "todo")]);
    await settle();

    expect(ui.cursor).toBe(0);
  });

  test("and the cursor follows again once the new rows are the ones on screen", async () => {
    await show([task("A", "todo"), task("B", "review")], 0);

    resetCursor();
    setViewTasks([task("X", "todo"), task("Y", "review"), task("Z", "todo")]);
    await settle();
    expect(ids()).toEqual(["X", "Z", "Y"]);
    expect(ui.cursor).toBe(0);

    setUi("cursor", 1);
    await settle();

    // Z joins review, which puts it last.
    setViewTasks([task("X", "todo"), task("Y", "review"), task("Z", "review")]);
    await settle();

    expect(ids()).toEqual(["X", "Y", "Z"]);
    expect(ui.cursor).toBe(2);
  });
});
