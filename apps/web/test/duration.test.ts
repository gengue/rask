import { describe, expect, test } from "bun:test";
import { parseDuration, startFor } from "../src/lib/duration.ts";

/**
 * The two rules that decide what a manual time entry says. Both write somebody's
 * paid week, so every shape the modal advertises is pinned here — including the
 * ones that must come back null, since a parser that guesses is worse than one
 * that refuses.
 */

describe("parseDuration", () => {
  test("units, spaced or not", () => {
    expect(parseDuration("2h 30m")).toBe(9_000_000);
    expect(parseDuration("2h30m")).toBe(9_000_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("45m")).toBe(2_700_000);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("90m 30s")).toBe(5_430_000);
    expect(parseDuration("2h 10m 30s")).toBe(7_830_000);
  });

  test("a bare number is hours, decimals included", () => {
    expect(parseDuration("2.5")).toBe(9_000_000);
    expect(parseDuration("1")).toBe(3_600_000);
    expect(parseDuration("0.25")).toBe(900_000);
  });

  test("a clock reads h:mm and h:mm:ss", () => {
    expect(parseDuration("1:30")).toBe(5_400_000);
    expect(parseDuration("1:30:20")).toBe(5_420_000);
    expect(parseDuration("2:10:30")).toBe(7_830_000);
    expect(parseDuration("0:05")).toBe(300_000);
  });

  test("case and surrounding space do not matter", () => {
    expect(parseDuration("  2H 30M  ")).toBe(9_000_000);
  });

  test("zero parses, and is the caller's to refuse", () => {
    // Not null: "0h" is readable, it just is not worth writing. Save is what
    // rejects it, so the box does not claim a typo it did not see.
    expect(parseDuration("0h")).toBe(0);
  });

  test("what it will not guess at", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("   ")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    // A negative term is a typo, not a subtraction.
    expect(parseDuration("2h -30m")).toBeNull();
    expect(parseDuration(":30")).toBeNull();
    expect(parseDuration("1:60")).toBeNull();
    expect(parseDuration("2h 30")).toBeNull();
    expect(parseDuration("h")).toBeNull();
    expect(parseDuration("2d")).toBeNull();
  });
});

describe("startFor", () => {
  test("work logged against today ends now, rather than starting now", () => {
    const now = new Date(2026, 7, 26, 15, 0).getTime();
    expect(startFor("2026-08-26", 2 * 3_600_000, now)).toBe(now - 2 * 3_600_000);
  });

  test("a past day hangs the interval off that day's last second", () => {
    const now = new Date(2026, 7, 26, 15, 0).getTime();
    expect(startFor("2026-08-20", 3_600_000, now)).toBe(
      new Date(2026, 7, 20, 22, 59, 59).getTime(),
    );
  });

  test("a future day is placed the same way, not refused", () => {
    const now = new Date(2026, 7, 26, 15, 0).getTime();
    expect(startFor("2026-09-02", 1_800_000, now)).toBe(new Date(2026, 8, 2, 23, 29, 59).getTime());
  });

  test("crossing midnight backwards keeps the entry on the day that was picked", () => {
    // 00:30 local, logging three hours against today. `now - duration` is
    // yesterday evening, which would file the hours under the wrong date — so
    // the interval is hung off tonight instead.
    const now = new Date(2026, 7, 26, 0, 30).getTime();
    expect(startFor("2026-08-26", 3 * 3_600_000, now)).toBe(
      new Date(2026, 7, 26, 20, 59, 59).getTime(),
    );
  });

  test("just after midnight, a short entry still ends now", () => {
    const now = new Date(2026, 7, 26, 0, 30).getTime();
    expect(startFor("2026-08-26", 600_000, now)).toBe(now - 600_000);
  });

  test("an unpadded date is read as the date it spells", () => {
    const now = new Date(2026, 7, 26, 15, 0).getTime();
    expect(startFor("2026-8-26", 2 * 3_600_000, now)).toBe(now - 2 * 3_600_000);
  });

  test("an unreadable day refuses rather than guessing", () => {
    const now = Date.now();
    expect(startFor("", 3_600_000, now)).toBeNull();
    expect(startFor("not-a-date", 3_600_000, now)).toBeNull();
    expect(startFor("2026-08", 3_600_000, now)).toBeNull();
  });
});
