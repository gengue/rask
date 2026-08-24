import { describe, expect, test } from "bun:test";
import { fromDateInput, toDateInput } from "../src/lib/format.ts";

/* `bun test` runs in UTC, and in UTC every wrong way to do this looks right.
   Both directions need their own zone: behind UTC it is the end of the day that
   has already rolled over there, ahead of it the beginning. */
function inZone<T>(tz: string, run: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

describe("toDateInput", () => {
  test("is the local day, not the UTC one", () => {
    const late = inZone("America/Los_Angeles", () =>
      toDateInput(new Date(2026, 5, 9, 23, 30).getTime()),
    );
    const early = inZone("Asia/Tokyo", () => toDateInput(new Date(2026, 5, 9, 0, 30).getTime()));
    expect(late).toBe("2026-06-09");
    expect(early).toBe("2026-06-09");
  });

  test("pads the month and the day", () => {
    expect(toDateInput(new Date(2026, 0, 5, 12, 0).getTime())).toBe("2026-01-05");
  });

  test("says nothing when there is no date", () => {
    expect(toDateInput(null)).toBe("");
    expect(toDateInput(Number.NaN)).toBe("");
  });
});

describe("fromDateInput", () => {
  test("lands at noon, so the day survives the timezone that reads it back", () => {
    const ms = fromDateInput("2026-06-09");
    expect(ms).not.toBeNull();
    expect(new Date(ms ?? 0).getHours()).toBe(12);
  });

  /* A calendar has no hours in it, and a ClickUp date is an instant. Picking a
     new day for something due at 09:00 must not quietly make it noon. */
  test("keeps the time of day the value already had", () => {
    const before = new Date(2026, 5, 9, 9, 30, 15).getTime();
    const after = new Date(fromDateInput("2026-06-11", before) ?? 0);
    expect(toDateInput(after.getTime())).toBe("2026-06-11");
    expect(after.getHours()).toBe(9);
    expect(after.getMinutes()).toBe(30);
    expect(after.getSeconds()).toBe(15);
  });

  test("round-trips through the input value", () => {
    expect(toDateInput(fromDateInput("2026-06-09"))).toBe("2026-06-09");
    expect(toDateInput(fromDateInput("2027-12-31"))).toBe("2027-12-31");
  });

  test("a cleared input is a cleared date", () => {
    expect(fromDateInput("")).toBeNull();
    expect(fromDateInput("", Date.now())).toBeNull();
  });
});
