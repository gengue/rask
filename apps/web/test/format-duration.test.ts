import { describe, expect, test } from "bun:test";
import { formatDuration } from "../src/lib/format.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("formatDuration", () => {
  test("reads in the units an estimate is set in", () => {
    expect(formatDuration(45 * MINUTE)).toBe("45m");
    expect(formatDuration(2 * HOUR)).toBe("2h");
    expect(formatDuration(HOUR + 30 * MINUTE)).toBe("1h 30m");
  });

  test("stops at two units, however long the total gets", () => {
    // 41 hours is a real tracked total on a task that ran for a week. "1d 17h
    // 20m" is a third unit and a working-day length nobody agreed on.
    expect(formatDuration(41 * HOUR + 20 * MINUTE)).toBe("41h 20m");
  });

  test("rounds to the minute rather than showing seconds", () => {
    expect(formatDuration(90_000)).toBe("2m");
    expect(formatDuration(HOUR + 29_000)).toBe("1h");
  });

  /*
   * ClickUp sends `time_spent: 0` for every task nobody has ever tracked
   * against, which is most of them. Rendering that as "0m" would put a column
   * of zeroes next to every subtask and call it information.
   */
  test("says nothing for a task nobody tracked or estimated", () => {
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-5)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });

  test("does not round a few seconds down to nothing", () => {
    // Nothing and almost-nothing are different answers: a timer left running
    // for ten seconds is still evidence somebody started one.
    expect(formatDuration(10_000)).toBe("<1m");
  });
});
