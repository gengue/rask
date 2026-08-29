import { describe, expect, test } from "bun:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import type { TimeEntry } from "../src/lib/api.ts";
import { reconcileStorage } from "../src/lib/reconcile-storage.ts";

/**
 * The property the time-entry list depends on: a refetch that answers with
 * all-new row objects must not hand `<For>` new references for rows that did
 * not change, because `<For>` keys by reference and a new reference is a torn
 * down and rebuilt `<li>` — the stop-the-timer blink.
 */

function entry(over: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "e1",
    taskId: "T",
    taskName: "Task",
    user: null,
    start: 1_756_080_000_000,
    end: 1_756_083_600_000,
    durationMs: 3_600_000,
    running: false,
    description: "",
    billable: false,
    ...over,
  };
}

describe("reconcileStorage", () => {
  test("keeps the untouched rows' identity across a wholesale replacement", () => {
    const [value, set] = reconcileStorage<TimeEntry[]>(undefined);
    set([entry({ id: "a" }), entry({ id: "b" })]);
    const before = (value() ?? []).map((row) => unwrap(row));

    // What a refetch does: same data, brand-new objects, one real change.
    set([entry({ id: "a" }), entry({ id: "b", description: "edited" })]);
    const after = (value() ?? []).map((row) => unwrap(row));

    expect(after[0]).toBe(before[0] as TimeEntry);
    expect(after[1]?.description).toBe("edited");
  });

  test("a new row lands without disturbing its neighbours", () => {
    const [value, set] = reconcileStorage<TimeEntry[]>(undefined);
    set([entry({ id: "a" })]);
    const before = unwrap((value() ?? [])[0] as TimeEntry);

    set([entry({ id: "fresh", start: 1_756_090_000_000 }), entry({ id: "a" })]);

    const rows = (value() ?? []).map((row) => unwrap(row));
    expect(rows.map((row) => row.id)).toEqual(["fresh", "a"]);
    expect(rows[1]).toBe(before);
  });

  test("clearing still answers undefined rather than a stale value", () => {
    const [value, set] = reconcileStorage<TimeEntry[]>(undefined);
    set([entry()]);
    set(undefined);
    expect(value()).toBeUndefined();
  });

  /*
   * The setter must not subscribe its caller. It reads `state.value` to build
   * its answer, and unguarded that read lands in whatever reactive scope called
   * it — the effect that resets the time-entries panel on a task switch calls
   * `mutate(undefined)`, so it got subscribed to the resource's value and
   * re-ran on every fetch that landed, folding the section it had just opened
   * and throwing the answer away.
   */
  test("set does not subscribe its caller to the stored value", () => {
    createRoot((dispose) => {
      const [value, set] = reconcileStorage<TimeEntry[]>(undefined);
      const [epoch, setEpoch] = createSignal(0);

      let clears = 0;
      const clearing = createMemo(() => {
        epoch();
        clears++;
        set(undefined);
      });
      let reads = 0;
      const reading = createMemo(() => {
        reads++;
        return value();
      });
      clearing();
      reading();
      expect(clears).toBe(1);

      // A fetch landing elsewhere writes the value. The reading memo re-runs —
      // which is what proves reactivity is alive in this test environment and
      // the clearing assertion below is measuring something.
      set([entry()]);
      reading();
      expect(reads).toBe(2);
      clearing();
      expect(clears).toBe(1);

      // And the setter's declared dependency still works.
      setEpoch(1);
      clearing();
      expect(clears).toBe(2);

      dispose();
    });
  });
});
