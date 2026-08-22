import { describe, expect, test } from "bun:test";
import { formatBytes } from "../src/lib/format.ts";

describe("formatBytes", () => {
  test("leaves small files in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("climbs a unit at 1024, not at 1000", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
    expect(formatBytes(11_268_593)).toBe("11 MB");
  });

  /* One decimal is the difference between 1.4 MB and 1 MB; past ten it is
     noise nobody reads. */
  test("drops the decimal once the number is big enough to speak for itself", () => {
    expect(formatBytes(9.4 * 1024 * 1024)).toBe("9.4 MB");
    expect(formatBytes(148 * 1024 * 1024)).toBe("148 MB");
  });

  test("stops at TB rather than inventing a unit", () => {
    expect(formatBytes(5 * 1024 ** 4)).toBe("5.0 TB");
    expect(formatBytes(5 * 1024 ** 5)).toBe("5120 TB");
  });

  test("says nothing when ClickUp gave no size", () => {
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});
