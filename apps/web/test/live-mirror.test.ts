import { describe, expect, test } from "bun:test";
import { createMemo, createRoot } from "solid-js";
import type { Task } from "../src/lib/api.ts";
import { useLiveTask } from "../src/lib/live.ts";
import { merge, tasks } from "../src/lib/store.ts";

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
 * The collection is a Map, not a signal: `tasks.get()` returns the new value on
 * the next read and never asks anyone to read again. So these count
 * recomputations rather than compare values — a test that only asserted
 * `live()?.status` would pass against `tasks.get()` and catch nothing, which is
 * the whole shape of the bug this covers.
 *
 * They also need `--conditions browser`, which is why the package's test script
 * passes it. Under Bun's default node conditions `solid-js` resolves to its SSR
 * build, where a signal is a value and nothing recomputes — so every assertion
 * below passes for the wrong reason, and so would any future test of anything
 * reactive in this app.
 */
describe("useLiveTask", () => {
  test("a row that changes in the collection re-runs what reads it", async () => {
    await tasks.preload();
    merge([task("T1")]);

    const seen = await createRoot(async (dispose) => {
      const live = useLiveTask(() => "T1");
      const statuses: Array<string | null | undefined> = [];
      const derived = createMemo(() => {
        const row = live();
        statuses.push(row?.status);
        return row?.status;
      });
      derived();

      merge([task("T1", { status: "in review" })]);
      await Promise.resolve();
      derived();

      dispose();
      return statuses;
    });

    expect(seen).toEqual(["todo", "in review"]);
  });

  /*
   * The panel re-injects its description's `innerHTML` and rebuilds its comment
   * threads when what it reads changes, so a poll that brings back an identical
   * row must not count as a change. The collection already compares deeply
   * before it emits, and this is what says so out loud.
   */
  test("an identical row is not a change", async () => {
    await tasks.preload();
    merge([task("T2")]);

    const seen = await createRoot(async (dispose) => {
      const live = useLiveTask(() => "T2");
      const statuses: Array<string | null | undefined> = [];
      const derived = createMemo(() => {
        const row = live();
        statuses.push(row?.status);
        return row?.status;
      });
      derived();

      merge([task("T2")]);
      await Promise.resolve();
      derived();

      dispose();
      return statuses;
    });

    expect(seen).toEqual(["todo"]);
  });

  test("a row nobody has loaded reads as undefined", async () => {
    await tasks.preload();

    const value = createRoot((dispose) => {
      const live = useLiveTask(() => "nobody");
      const row = live();
      dispose();
      return row;
    });

    expect(value).toBeUndefined();
  });
});
