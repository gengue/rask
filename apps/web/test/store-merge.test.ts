import { describe, expect, test } from "bun:test";
import type { Task } from "../src/lib/api.ts";
import { merge, removeTask, setCustomValue, tasks } from "../src/lib/store.ts";

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

  /*
   * The inbox, the change feed and a task detail all read without field ids,
   * so their rows say `customValues: null`. Merged as-is that emptied the
   * Custom Field column the list had just fetched values for — on the tasks
   * assigned to you, which is why only some rows lost it. See `keepValues`.
   */
  test("a row carrying no custom values keeps the ones already held", async () => {
    await tasks.preload();
    merge([task("M5", { customValues: { f1: '"Andre Kiwitz"' } })]);
    merge([task("M5", { customValues: null })]);
    expect(tasks.get("M5")?.customValues).toEqual({ f1: '"Andre Kiwitz"' });
  });

  test("a row carrying values wins over the ones already held", async () => {
    await tasks.preload();
    merge([task("MA", { customValues: { f1: '"Ana"' } })]);
    merge([task("MA", { customValues: { f1: '"Andre"' } })]);
    expect(tasks.get("MA")?.customValues).toEqual({ f1: '"Andre"' });
  });

  test("an empty map is an answer, not an absence, and is kept as sent", async () => {
    // {} means "asked, nothing there" — see customValuesJson. Putting the older
    // values back would resurrect a field somebody just cleared.
    await tasks.preload();
    merge([task("MB", { customValues: { f1: '"Ana"' } })]);
    merge([task("MB", { customValues: {} })]);
    expect(tasks.get("MB")?.customValues).toEqual({});
  });
});

/*
 * A field set from the panel reaches the list through here and nowhere else:
 * the panel refetches its own detail, and the feed's row says nothing about
 * Custom Fields — so the column and any `cf:` clause would go on reading the
 * value that was just replaced.
 */
describe("setCustomValue", () => {
  test("replaces the value the column is drawing", async () => {
    await tasks.preload();
    merge([task("M6", { customValues: { f1: '"Ana"' } })]);
    setCustomValue("M6", "f1", { value: "Andre" });
    expect(tasks.get("M6")?.customValues).toEqual({ f1: '"Andre"' });
  });

  test("a People field stores its mirror, not the delta that goes up", async () => {
    await tasks.preload();
    merge([task("M9", { customValues: { f1: "[]" } })]);
    setCustomValue("M9", "f1", {
      value: { add: [7], rem: [] },
      mirror: [{ id: 7, username: "Andre" }],
    });
    expect(tasks.get("M9")?.customValues).toEqual({ f1: '[{"id":7,"username":"Andre"}]' });
  });

  test("a cleared field loses its key, as the mirror loses its row", async () => {
    await tasks.preload();
    merge([task("M7", { customValues: { f1: '"Ana"', f2: "3" } })]);
    setCustomValue("M7", "f1", { value: null });
    expect(tasks.get("M7")?.customValues).toEqual({ f2: "3" });
  });

  test("says nothing about a row whose values were never read", async () => {
    await tasks.preload();
    merge([task("M8", { customValues: null })]);
    setCustomValue("M8", "f1", { value: "Andre" });
    // Not `{f1: ...}`: a map invented here would claim every other field on the
    // task is empty, and the browser's filter would act on that.
    expect(tasks.get("M8")?.customValues).toBeNull();
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
