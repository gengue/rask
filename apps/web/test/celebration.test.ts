import { describe, expect, test } from "bun:test";
import { justClosed } from "../src/lib/celebration.tsx";

/**
 * The banner has to fire on finishing and only on finishing. The failure that
 * matters is silent: fire on "closed → done" and every re-file of finished
 * work rings the bell; miss "open → closed" and the feature quietly never
 * happens. Both directions are one predicate, so both are pinned here.
 */
describe("justClosed", () => {
  test("finishing fires, whichever finished type it lands on", () => {
    expect(justClosed("open", "done")).toBe(true);
    expect(justClosed("custom", "closed")).toBe(true);
    expect(justClosed(null, "done")).toBe(true);
  });

  test("a lateral move between finished types is not a second victory", () => {
    expect(justClosed("done", "closed")).toBe(false);
    expect(justClosed("closed", "done")).toBe(false);
  });

  test("reopening, staying open, and untouched status all stay quiet", () => {
    expect(justClosed("done", "open")).toBe(false);
    expect(justClosed("open", "custom")).toBe(false);
    expect(justClosed("open", undefined)).toBe(false);
    expect(justClosed(undefined, undefined)).toBe(false);
  });
});
