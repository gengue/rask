import { describe, expect, test } from "bun:test";
import type { Task } from "../src/lib/api.ts";
import { merge, removeTask, tasks } from "../src/lib/store.ts";

/**
 * What the collection does with the rows the change feed sends it.
 *
 * The feed is the one read in the app that does *not* filter deleted and
 * archived tasks out — it has to carry them, because a row is the only way it
 * can say "this one is gone". So this is the single place that decides whether
 * a task disappears from every view, and getting it wrong leaves an archived
 * task on screen until the tab is reloaded.
 */

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

describe("merge", () => {
  test("keeps a row anyone can still see", async () => {
    await tasks.preload();
    merge([task("M1")]);
    expect(tasks.get("M1")?.name).toBe("M1");
  });

  test("drops a task the mirror has marked deleted", async () => {
    await tasks.preload();
    merge([task("M2")]);
    merge([task("M2", { deletedAt: new Date().toISOString() })]);
    expect(tasks.get("M2")).toBeUndefined();
  });

  test("drops an archived task, which every other read already hides", async () => {
    await tasks.preload();
    merge([task("M3")]);
    merge([task("M3", { archived: true })]);
    expect(tasks.get("M3")).toBeUndefined();
  });
});

describe("removeTask", () => {
  test("takes a row out now rather than a feed tick from now", async () => {
    await tasks.preload();
    merge([task("M4")]);
    removeTask("M4");
    expect(tasks.get("M4")).toBeUndefined();
  });

  test("says nothing about a task it never held", async () => {
    await tasks.preload();
    expect(() => removeTask("never-loaded")).not.toThrow();
  });
});
