import { beforeEach, describe, expect, test } from "bun:test";

/**
 * Which Custom Fields the user asked to see, and where.
 *
 * Like the subtask columns, the value is in what survives a reload — and in
 * the one rule with teeth: pin and hide exclude each other, because a field
 * cannot be both always and never on screen.
 */

const store = new Map<string, string>();

// `bun test` has no DOM. A Map is the whole contract this module uses.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

/** Re-imported per test, because the module reads storage once at import. */
async function load(seed: Record<string, string> = {}) {
  store.clear();
  for (const [key, value] of Object.entries(seed)) store.set(key, value);
  return await import(`../src/lib/field-prefs.ts?t=${Math.random()}`);
}

beforeEach(() => store.clear());

describe("list columns", () => {
  test("are per list, ordered by choice, and survive the reload", async () => {
    const first = await load();
    first.toggleColumn("list-a", "stakeholder");
    first.toggleColumn("list-a", "bv");
    first.toggleColumn("list-b", "bv");

    const second = await load(Object.fromEntries(store));

    expect(second.columnsFor("list-a")).toEqual(["stakeholder", "bv"]);
    expect(second.columnsFor("list-b")).toEqual(["bv"]);
    expect(second.columnsFor("list-c")).toEqual([]);
  });

  test("toggling off removes just that column", async () => {
    const prefs = await load();
    prefs.toggleColumn("list-a", "stakeholder");
    prefs.toggleColumn("list-a", "bv");
    prefs.toggleColumn("list-a", "stakeholder");
    expect(prefs.columnsFor("list-a")).toEqual(["bv"]);
  });

  test("junk in the key falls back to none chosen", async () => {
    const prefs = await load({ "rask.fields.columns": "{oh no" });
    expect(prefs.columnsFor("list-a")).toEqual([]);
  });
});

describe("detail pins and hides", () => {
  test("survive the reload", async () => {
    const first = await load();
    first.toggleHiddenField("noise");
    first.togglePinnedField("bv");

    const second = await load(Object.fromEntries(store));

    expect(second.hiddenFields().has("noise")).toBe(true);
    expect(second.pinnedFields().has("bv")).toBe(true);
  });

  test("pinning a hidden field unhides it, and hiding a pinned one unpins it", async () => {
    const prefs = await load();

    prefs.toggleHiddenField("f");
    prefs.togglePinnedField("f");
    expect(prefs.hiddenFields().has("f")).toBe(false);
    expect(prefs.pinnedFields().has("f")).toBe(true);

    prefs.toggleHiddenField("f");
    expect(prefs.pinnedFields().has("f")).toBe(false);
    expect(prefs.hiddenFields().has("f")).toBe(true);
  });

  test("a toggle back off survives too", async () => {
    const first = await load();
    first.toggleHiddenField("f");
    first.toggleHiddenField("f");

    const second = await load(Object.fromEntries(store));
    expect(second.hiddenFields().size).toBe(0);
  });
});
