import { describe, expect, test } from "bun:test";
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
});
