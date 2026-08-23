import { describe, expect, test } from "bun:test";
import { type FilterableTask, selectRows } from "../src/lib/filters.ts";

/**
 * The predicate that decides what a view shows.
 *
 * It lived inline in a Solid memo until now, which meant nothing tested it:
 * `bun test` resolves `solid-js` to its server build, so a memo never re-runs
 * and a test of one passes while asserting nothing. Extracted, every rule below
 * is a plain function of its arguments.
 */

type Row = FilterableTask & { id: string; statusType: string | null };

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  name: id,
  customId: null,
  status: "Open",
  statusType: "open",
  priority: null,
  dueDate: null,
  dateCreated: null,
  dateUpdated: null,
  listId: "list-1",
  parentId: null,
  tags: [],
  assignees: [],
  customValues: null,
  ...over,
});

const NOW = new Date("2026-06-15T12:00:00.000Z");
const base = {
  clauses: [] as const,
  member: null,
  showClosed: false,
  named: new Set<string>(),
  now: NOW,
};

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("closed statuses", () => {
  const rows = [row("open"), row("done", { status: "Done", statusType: "closed" })];

  test("a closed row is hidden by default", () => {
    // Otherwise every finished task in the workspace is on screen forever.
    expect(ids(selectRows(rows, base))).toEqual(["open"]);
  });

  test("showing closed brings it back", () => {
    expect(ids(selectRows(rows, { ...base, showClosed: true }))).toEqual(["open", "done"]);
  });

  test("naming the status in the filter shows it even with closed off", () => {
    // Picking "Done" out of the status menu and being told there is nothing
    // there is the filter matching and a second rule quietly undoing it.
    expect(ids(selectRows(rows, { ...base, named: new Set(["Done"]) }))).toEqual(["open", "done"]);
  });
});

describe("membership", () => {
  const rows = [row("a"), row("b")];

  test("rows outside the server's answer are dropped", () => {
    // The collection is additive across views. Without this, a row loaded under
    // a looser filter stays on screen under a tighter one.
    expect(ids(selectRows(rows, { ...base, member: new Set(["a"]) }))).toEqual(["a"]);
  });

  test("a row this browser just created survives", () => {
    // It did not exist when the server was asked, so it cannot be in the answer.
    // Dropping it makes creating a task under a filter look like a failed write.
    const withPlaceholder = [...rows, row("tmp_new")];
    expect(ids(selectRows(withPlaceholder, { ...base, member: new Set(["a"]) }))).toEqual([
      "a",
      "tmp_new",
    ]);
  });

  test("no membership set means the rows decide for themselves", () => {
    expect(ids(selectRows(rows, base))).toEqual(["a", "b"]);
  });
});

describe("clauses", () => {
  const rows = [
    row("urgent", { priority: 1, tags: [{ name: "billing" }] }),
    row("normal", { priority: 3 }),
  ];

  test("a clause narrows the rows in hand", () => {
    expect(
      ids(
        selectRows(rows, { ...base, clauses: [{ field: "priority", op: "ANY", values: ["1"] }] }),
      ),
    ).toEqual(["urgent"]);
  });

  test("clauses and the closed rule both apply", () => {
    const withClosed = [...rows, row("done", { priority: 1, status: "Done", statusType: "done" })];
    expect(
      ids(
        selectRows(withClosed, {
          ...base,
          clauses: [{ field: "priority", op: "ANY", values: ["1"] }],
        }),
      ),
    ).toEqual(["urgent"]);
  });
});
