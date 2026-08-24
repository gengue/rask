import { describe, expect, test } from "bun:test";
import type { Task } from "../src/lib/api.ts";
import { type FlatItem, groupTasks, reuseItems } from "../src/lib/grouping.ts";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    customId: null,
    name: id,
    status: "todo",
    statusColor: "#f2c94c",
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
    ...over,
  };
}

/*
 * The wrappers' identity is load-bearing: the windowed `<Index>` in the list
 * diffs per position by `===`, so a fresh wrapper for an unchanged task means
 * that row's tag chips and avatars are rebuilt for nothing. These pin the two
 * halves of the contract — reuse what did not change, replace what did.
 */
describe("reuseItems", () => {
  test("an identical regroup returns the previous array itself", () => {
    const rows = [task("T1"), task("T2", { status: "done" })];
    const prev = groupTasks(rows, "status");
    const next = groupTasks(rows, "status");
    expect(next).not.toBe(prev);
    expect(reuseItems(prev, next)).toBe(prev);
  });

  test("one changed task replaces only its own wrapper", () => {
    const t1 = task("T1");
    const prev = groupTasks([t1, task("T2")], "status");
    const next = groupTasks([t1, task("T2", { name: "renamed" })], "status");

    const out = reuseItems(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0] as FlatItem); // the header: same label, same count
    expect(out[1]).toBe(prev[1] as FlatItem); // T1 untouched
    expect(out[2]).not.toBe(prev[2] as FlatItem); // T2 changed
    expect(out[2]).toBe(next[2] as FlatItem);
  });

  test("a header whose count changed is a new wrapper", () => {
    const t1 = task("T1");
    const header = (count: number): FlatItem => ({
      kind: "header",
      id: "header:todo",
      label: "todo",
      count,
      color: null,
      statusType: null,
    });
    const prev: FlatItem[] = [header(1), { kind: "row", id: "T1", task: t1 }];
    const next: FlatItem[] = [header(2), { kind: "row", id: "T1", task: t1 }];

    const out = reuseItems(prev, next);
    expect(out[0]).toBe(next[0] as FlatItem);
    expect(out[1]).toBe(prev[1] as FlatItem);
  });

  test("a position that changes kind is never reused", () => {
    const t1 = task("T1");
    const prev = groupTasks([t1], "none"); // [row]
    const next = groupTasks([t1], "status"); // [header, row]
    const out = reuseItems(prev, next);
    expect(out).toEqual(next);
    expect(out[0]).toBe(next[0] as FlatItem);
  });
});
