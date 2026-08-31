import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { columnDate } from "../src/components/TimesheetTable.tsx";

/**
 * Which date each of the seven columns names.
 *
 * Worth pinning because the answer stopped being cosmetic: a day cell is a
 * button now, and the date it names is the date `startFor` writes to ClickUp.
 * A column labelled Monday that logs against Sunday is somebody's hours on the
 * wrong day of their week.
 *
 * Run in a zone that actually changes its clocks — the arithmetic this replaced
 * only goes wrong in the two weeks a year that hold a fold, so a test in UTC
 * would pass against the bug. `TZ` is set for the file and put back after:
 * `bun test` runs files one at a time in one process, and the neighbouring
 * suites build local dates of their own.
 */

const original = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  // Deleted rather than assigned back when there was nothing there: writing
  // `undefined` into `process.env` stores the *string* "undefined", and every
  // suite that runs after this one would then build its dates in a zone that
  // does not exist.
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

/** Sunday 00:00 local of the given calendar date. */
const sunday = (year: number, month: number, date: number) =>
  new Date(year, month - 1, date).getTime();

describe("columnDate", () => {
  test("names seven consecutive calendar days from the week's Sunday", () => {
    const start = sunday(2026, 8, 23);
    const dates = [0, 1, 2, 3, 4, 5, 6].map((day) => columnDate(start, day).getDate());
    expect(dates).toEqual([23, 24, 25, 26, 27, 28, 29]);
  });

  test("every column begins at local midnight, not at an offset from Sunday", () => {
    const start = sunday(2026, 8, 23);
    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      const at = columnDate(start, day);
      expect([at.getHours(), at.getMinutes(), at.getSeconds()]).toEqual([0, 0, 0]);
    }
  });

  /*
   * The week the clocks go back: Sunday is 25 hours long, so `start + 1 * 24h`
   * is 23:00 on Sunday and every column after it reads a day early. This is the
   * bug the calendar arithmetic exists for, and it is invisible outside these
   * two weeks — which is why it survived as long as it did.
   */
  test("survives the week the clocks go back", () => {
    const start = sunday(2026, 11, 1);
    const dates = [0, 1, 2, 3, 4, 5, 6].map((day) => columnDate(start, day).getDate());
    expect(dates).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const fixedStep = new Date(start + 24 * 60 * 60 * 1000);
    expect(fixedStep.getDate()).toBe(1);
  });

  test("survives the week the clocks go forward", () => {
    const start = sunday(2026, 3, 8);
    const dates = [0, 1, 2, 3, 4, 5, 6].map((day) => columnDate(start, day).getDate());
    expect(dates).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  test("crosses a month end without a fixed step's help", () => {
    const start = sunday(2026, 8, 30);
    const dates = [0, 1, 2, 3, 4, 5, 6].map((day) => {
      const at = columnDate(start, day);
      return `${at.getMonth() + 1}-${at.getDate()}`;
    });
    expect(dates).toEqual(["8-30", "8-31", "9-1", "9-2", "9-3", "9-4", "9-5"]);
  });
});
