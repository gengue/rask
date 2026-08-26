import { describe, expect, test } from "bun:test";
import { entryStart } from "../src/components/Time.tsx";
import { toDateInput } from "../src/lib/format.ts";

/**
 * The arithmetic that places a manual time entry. It writes somebody's
 * timesheet, so the two anchors are pinned here: today's entry ends now, a
 * past day's entry sits at noon — local noon, so the date survives being read
 * from any timezone ClickUp renders it in.
 */

describe("entryStart", () => {
  test("an entry for today ends now, not starts now", () => {
    const now = new Date(2026, 7, 26, 15, 0).getTime();
    expect(entryStart(toDateInput(now), 2 * 3_600_000, now)).toBe(now - 2 * 3_600_000);
  });

  test("a past day pins the entry to that day's local noon", () => {
    const now = new Date(2026, 7, 26, 15, 0).getTime();
    expect(entryStart("2026-08-20", 3_600_000, now)).toBe(new Date(2026, 7, 20, 12, 0).getTime());
  });

  test("just after midnight, today still means today, not the UTC day", () => {
    // 00:30 local. In any timezone ahead of UTC the UTC date is yesterday,
    // which is exactly the slice a naive toISOString comparison would take.
    const now = new Date(2026, 7, 26, 0, 30).getTime();
    const start = entryStart(toDateInput(now), 3_600_000, now);
    expect(start).toBe(now - 3_600_000);
  });

  test("an unreadable day refuses rather than guessing", () => {
    expect(entryStart("", 3_600_000, Date.now())).toBeNull();
  });
});
