import { describe, expect, test } from "bun:test";
import type { StatusDef, Task } from "../src/lib/api.ts";
import {
  type BoardColumn,
  cardHeight,
  cardOffsets,
  nextCursor,
  toColumns,
  visibleRange,
} from "../src/lib/board.ts";
import { groupTasks } from "../src/lib/grouping.ts";

function task(id: string, status: string | null, extra: Partial<Task> = {}): Task {
  return {
    id,
    customId: null,
    name: id,
    status,
    statusColor: status === null ? null : "#f2c94c",
    statusType: status === null ? null : "custom",
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
    ...extra,
  };
}

/** Deliberately not in orderindex order: the board is what has to sort them. */
const STATUSES: StatusDef[] = [
  { status: "done", type: "done", color: "#2ecd6f", orderindex: 3 },
  { status: "todo", type: "open", color: "#8a8f98", orderindex: 0 },
  { status: "in progress", type: "custom", color: "#f2c94c", orderindex: 1 },
  { status: "in review", type: "custom", color: "#9b8afb", orderindex: 2 },
];

const ROWS = [task("a", "todo"), task("b", "done"), task("c", "todo"), task("d", "in progress")];

/** Which statuses get a column. In the app this is `statusShown` in lib/view.ts. */
const ALL = () => true;
const OPEN_ONLY = (def: StatusDef) => def.type !== "done" && def.type !== "closed";

const shape = (columns: BoardColumn[]) =>
  columns.map((column) => [column.label, column.tasks.map((t) => t.id), column.offset]);

describe("columns", () => {
  test("a column is one run of the flattened list", () => {
    const columns = toColumns(groupTasks(ROWS, "status"), "status", [], ALL);
    // First appearance, which is all grouping knows without the list's statuses.
    expect(shape(columns)).toEqual([
      ["todo", ["a", "c"], 0],
      ["done", ["b"], 2],
      ["in progress", ["d"], 3],
    ]);
  });

  test("offsets index the same flat row list the cursor walks", () => {
    const items = groupTasks(ROWS, "status");
    const rows = items.flatMap((item) => (item.kind === "row" ? [item.task] : []));
    for (const column of toColumns(items, "status", [], ALL)) {
      for (const [index, card] of column.tasks.entries()) {
        expect(rows[column.offset + index]?.id).toBe(card.id);
      }
    }
  });

  test("status definitions put the columns in ClickUp's order", () => {
    const columns = toColumns(groupTasks(ROWS, "status"), "status", STATUSES, ALL);
    expect(columns.map((column) => column.label)).toEqual([
      "todo",
      "in progress",
      "in review",
      "done",
    ]);
  });

  test("a status nobody is in is still a column, and can be dropped into", () => {
    const columns = toColumns(groupTasks(ROWS, "status"), "status", STATUSES, ALL);
    const empty = columns.find((column) => column.label === "in review");
    expect(empty?.tasks).toEqual([]);
    expect(empty?.status?.status).toBe("in review");
    // Reordering must not break the mapping back to the flat row list.
    expect(shape(columns.filter((column) => column.tasks.length > 0))).toEqual([
      ["todo", ["a", "c"], 0],
      ["in progress", ["d"], 3],
      ["done", ["b"], 2],
    ]);
  });

  test("the status written on a drop is a name, not a display label", () => {
    const known = toColumns(
      groupTasks([task("a", "In Progress")], "status"),
      "status",
      STATUSES,
      ALL,
    );
    // The list's own spelling wins where the list has one...
    expect(known.find((column) => column.tasks.length > 0)?.status?.status).toBe("in progress");

    const unknown = toColumns(
      groupTasks([task("a", "Shipped")], "status"),
      "status",
      STATUSES,
      ALL,
    );
    // ...and where it does not, the task's, untouched. Never the capitalised
    // label, which is display text.
    expect(unknown.find((column) => column.tasks.length > 0)?.status?.status).toBe("Shipped");
  });

  test("tasks with no status make a column nothing can be dropped into", () => {
    const columns = toColumns(
      groupTasks([...ROWS, task("e", null)], "status"),
      "status",
      STATUSES,
      ALL,
    );
    const none = columns.find((column) => column.label === "No status");
    expect(none?.status).toBeNull();
    // And it sorts after every real status rather than jumping to the front.
    expect(columns.at(-1)).toBe(none as BoardColumn);
  });

  test("another grouping still makes columns, just unwritable ones", () => {
    const columns = toColumns(groupTasks(ROWS, "list"), "list", STATUSES, ALL);
    expect(shape(columns)).toEqual([["List", ["a", "b", "c", "d"], 0]]);
    expect(columns[0]?.status).toBeNull();
  });

  test("no grouping is one column, not none", () => {
    const columns = toColumns(groupTasks(ROWS, "none"), "none", STATUSES, ALL);
    expect(shape(columns)).toEqual([["All tasks", ["a", "b", "c", "d"], 0]]);
  });

  test("an empty view has no columns to draw", () => {
    expect(toColumns([], "status", [], ALL)).toEqual([]);
  });
});

/**
 * `showClosed` on the board governs the columns, not the cards.
 *
 * The list reads the same flag as "hide closed rows". The board cannot: it
 * draws a column per status from the list definition, so with the old reading
 * it drew an empty "done" column that the very same flag emptied again. A card
 * dropped there was written, closed, and then filtered out from under the
 * pointer — which reads as the app losing the task rather than finishing it.
 *
 * So the rule is: a column is drawn or it is not, and whatever is in a drawn
 * column stays in it. `statusShown` in lib/view.ts is the other half, and the
 * two are the same predicate so the sets cannot disagree.
 */
describe("closed columns", () => {
  const OPEN_ROWS = [task("a", "todo"), task("d", "in progress")];

  test("a closed status is not a column when closed tasks are hidden", () => {
    const columns = toColumns(groupTasks(OPEN_ROWS, "status"), "status", STATUSES, OPEN_ONLY);
    expect(columns.map((column) => column.label)).toEqual(["todo", "in progress", "in review"]);
  });

  test("and is one when they are shown", () => {
    const columns = toColumns(groupTasks(OPEN_ROWS, "status"), "status", STATUSES, ALL);
    expect(columns.map((column) => column.label)).toEqual([
      "todo",
      "in progress",
      "in review",
      "done",
    ]);
  });

  test("a card in a drawn closed column stays in it", () => {
    // What a drop produces: the task is closed now, and its column is on screen.
    const columns = toColumns(
      groupTasks([...OPEN_ROWS, task("b", "done")], "status"),
      "status",
      STATUSES,
      ALL,
    );
    const done = columns.find((column) => column.label === "done");
    expect(done?.tasks.map((row) => row.id)).toEqual(["b"]);
    expect(done?.status?.status).toBe("done");
  });

  test("no closed column means nothing to drop into", () => {
    const columns = toColumns(groupTasks(OPEN_ROWS, "status"), "status", STATUSES, OPEN_ONLY);
    expect(columns.some((column) => column.status?.type === "done")).toBe(false);
  });
});

describe("cursor", () => {
  // Three columns of 3, 1 and 2 cards, plus an empty one in the middle.
  const columns: BoardColumn[] = [
    { ...stub("a"), tasks: [task("1", "a"), task("2", "a"), task("3", "a")], offset: 0 },
    { ...stub("b"), tasks: [], offset: 0 },
    { ...stub("c"), tasks: [task("4", "c")], offset: 3 },
    { ...stub("d"), tasks: [task("5", "d"), task("6", "d")], offset: 4 },
  ];

  function stub(id: string): BoardColumn {
    return { id, label: id, color: null, statusType: null, status: null, tasks: [], offset: 0 };
  }

  test("the list layout is one flat run", () => {
    expect(nextCursor("j", 0, 6, null)).toBe(1);
    expect(nextCursor("ArrowUp", 3, 6, null)).toBe(2);
    expect(nextCursor("k", 0, 6, null)).toBe(0);
    expect(nextCursor("j", 5, 6, null)).toBe(5);
  });

  test("sideways means nothing in a list, and the browser keeps the key", () => {
    expect(nextCursor("l", 0, 6, null)).toBeNull();
    expect(nextCursor("ArrowLeft", 0, 6, null)).toBeNull();
  });

  test("j and k stay inside the column", () => {
    expect(nextCursor("j", 0, 6, columns)).toBe(1);
    expect(nextCursor("j", 2, 6, columns)).toBe(2);
    expect(nextCursor("k", 3, 6, columns)).toBe(3);
    expect(nextCursor("ArrowDown", 4, 6, columns)).toBe(5);
  });

  test("h and l cross columns at the same depth, and skip the empty one", () => {
    expect(nextCursor("l", 0, 6, columns)).toBe(3);
    expect(nextCursor("h", 3, 6, columns)).toBe(0);
    expect(nextCursor("l", 3, 6, columns)).toBe(4);
  });

  test("a deep cursor lands on the last card of a shorter column", () => {
    // Third card of the first column, into a column that only has one.
    expect(nextCursor("l", 2, 6, columns)).toBe(3);
    // And back out again, to the first card rather than the one it left.
    expect(nextCursor("h", 3, 6, columns)).toBe(0);
  });

  test("the edges hold", () => {
    expect(nextCursor("h", 0, 6, columns)).toBeNull();
    expect(nextCursor("l", 5, 6, columns)).toBeNull();
  });

  test("keys that are not movement are left alone", () => {
    expect(nextCursor("s", 0, 6, columns)).toBeNull();
    expect(nextCursor("Enter", 0, 6, null)).toBeNull();
    expect(nextCursor("j", 0, 0, columns)).toBeNull();
  });
});

describe("card geometry", () => {
  const tagged = task("t", "todo", { tags: [{ name: "infra" }] });

  test("a card with tags is one row taller, and both heights are known", () => {
    expect(cardHeight(tagged) - cardHeight(task("p", "todo"))).toBe(22);
  });

  test("offsets are the running total, ending at the column height", () => {
    const offsets = cardOffsets([task("a", "todo"), tagged, task("c", "todo")]);
    expect([...offsets]).toEqual([0, 86, 194, 280]);
  });

  test("a window covers the viewport", () => {
    const offsets = cardOffsets(Array.from({ length: 500 }, (_, i) => task(String(i), "todo")));
    const { start, end } = visibleRange(offsets, 0, 800, 0);
    expect(start).toBe(0);
    // 800px of viewport at 86px a card, and the partly visible one at the end.
    expect(end).toBe(10);
  });

  test("a window in the middle carries overscan on both sides", () => {
    const offsets = cardOffsets(Array.from({ length: 500 }, (_, i) => task(String(i), "todo")));
    expect(visibleRange(offsets, 8600, 800, 4)).toEqual({ start: 96, end: 114 });
  });

  test("the window never runs off either end", () => {
    const offsets = cardOffsets(Array.from({ length: 12 }, (_, i) => task(String(i), "todo")));
    expect(visibleRange(offsets, 0, 800, 4)).toEqual({ start: 0, end: 12 });
    expect(visibleRange(cardOffsets([]), 0, 800, 4)).toEqual({ start: 0, end: 0 });
  });
});
