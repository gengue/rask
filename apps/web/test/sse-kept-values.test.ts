import { describe, expect, test } from "bun:test";
import type { Task } from "../src/lib/api.ts";
import { withKeptValues } from "../src/lib/sse.ts";

/**
 * The change feed reads no field ids, so its frames say `customValues: null`
 * about every task. Merged as-is that null overwrote the values the columns
 * had fetched — every cell of a task blanked within a second of anybody
 * touching it. The keep is what stands between those two facts.
 */

const row = (over: Partial<Task>): Task => ({ id: "t1", ...over }) as Task;

describe("withKeptValues", () => {
  test("a frame carrying null keeps the stored row's values", () => {
    const kept = withKeptValues([row({ customValues: null })], () =>
      row({ customValues: { f1: "1200" } }),
    );
    expect(kept[0]?.customValues).toEqual({ f1: "1200" });
  });

  test("a frame carrying values wins over the stored ones", () => {
    const kept = withKeptValues([row({ customValues: { f1: "2" } })], () =>
      row({ customValues: { f1: "1" } }),
    );
    expect(kept[0]?.customValues).toEqual({ f1: "2" });
  });

  test("an empty map is an answer, not an absence, and is kept as sent", () => {
    // {} means "tested, nothing there" — see customValuesJson. Replacing it
    // with older values would resurrect a field somebody just cleared.
    const kept = withKeptValues([row({ customValues: {} })], () =>
      row({ customValues: { f1: "1" } }),
    );
    expect(kept[0]?.customValues).toEqual({});
  });

  test("a task the store has never seen passes through untouched", () => {
    const frame = row({ customValues: null });
    const kept = withKeptValues([frame], () => undefined);
    expect(kept[0]).toBe(frame);
  });
});
