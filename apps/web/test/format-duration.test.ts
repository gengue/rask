import { describe, expect, test } from "bun:test";
import { formatDuration, parseDuration } from "../src/lib/format.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("formatDuration", () => {
  test("reads as a timesheet when stopped", () => {
    expect(formatDuration(90 * MINUTE)).toBe("1h 30m");
    expect(formatDuration(2 * HOUR)).toBe("2h");
    expect(formatDuration(45 * MINUTE)).toBe("45m");
  });

  test("an entry someone opened and closed by mistake looks like nothing", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(5_000)).toBe("0m");
  });

  test("reads as a clock while running, seconds included", () => {
    // A live counter with no seconds looks like it has stopped.
    expect(formatDuration(90 * MINUTE + 9_000, "clock")).toBe("1:30:09");
    expect(formatDuration(9 * MINUTE + 5_000, "clock")).toBe("9:05");
    expect(formatDuration(0, "clock")).toBe("0:00");
  });

  test("nothing and nonsense are not zero-length work", () => {
    expect(formatDuration(null)).toBe("0m");
    expect(formatDuration(Number.NaN)).toBe("0m");
    // Negative is how ClickUp encodes "still running"; it is never a length.
    expect(formatDuration(-1_756_080_000_000)).toBe("0m");
  });
});

describe("parseDuration", () => {
  test("takes the shapes people type", () => {
    expect(parseDuration("1h 30m")).toBe(90 * MINUTE);
    expect(parseDuration("1h30m")).toBe(90 * MINUTE);
    expect(parseDuration("1:30")).toBe(90 * MINUTE);
    expect(parseDuration("90m")).toBe(90 * MINUTE);
    expect(parseDuration("2h")).toBe(2 * HOUR);
    expect(parseDuration("1.5h")).toBe(90 * MINUTE);
  });

  test("a bare number is minutes, which is what it means on a timesheet", () => {
    expect(parseDuration("90")).toBe(90 * MINUTE);
    expect(parseDuration("0")).toBe(0);
  });

  test("ignores case and stray spacing", () => {
    expect(parseDuration("  2H 15M ")).toBe(2 * HOUR + 15 * MINUTE);
  });

  test("round-trips what formatDuration prints", () => {
    for (const ms of [0, 45 * MINUTE, 2 * HOUR, 90 * MINUTE, 7 * HOUR + 13 * MINUTE]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
  });

  /*
   * The distinction that matters. Returning 0 for an unreadable box would turn
   * a typo into "you worked no time" and overwrite somebody's afternoon, so the
   * caller gets null and refuses to write anything.
   */
  test("refuses what it cannot read rather than calling it zero", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("   ")).toBeNull();
    expect(parseDuration("about an hour")).toBeNull();
    expect(parseDuration("1h 30")).toBeNull();
    expect(parseDuration("h")).toBeNull();
    expect(parseDuration("1:75")).toBeNull();
    expect(parseDuration("-30m")).toBeNull();
  });
});
