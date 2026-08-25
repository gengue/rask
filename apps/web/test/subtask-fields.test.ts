import { beforeEach, describe, expect, test } from "bun:test";

/**
 * Which columns the subtask rows draw.
 *
 * All of the value is in what survives a reload — a choice that resets is worse
 * than no choice at all, because the reader has to make it again every time
 * they open a task. So the localStorage round trip is the thing under test.
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
  return await import(`../src/lib/subtask-fields.ts?t=${Math.random()}`);
}

beforeEach(() => store.clear());

describe("the default", () => {
  test("is what the list row already carries", async () => {
    const { showsField } = await load();
    expect(showsField("due")).toBe(true);
    expect(showsField("assignees")).toBe(true);
    expect(showsField("estimate")).toBe(false);
    expect(showsField("tracked")).toBe(false);
  });
});

describe("a choice", () => {
  test("survives the reload", async () => {
    const first = await load();
    first.toggleSubtaskField("tracked");
    first.toggleSubtaskField("due");

    const second = await load(Object.fromEntries(store));

    expect(second.showsField("tracked")).toBe(true);
    expect(second.showsField("due")).toBe(false);
    expect(second.showsField("assignees")).toBe(true);
  });

  test("survives even when it is to show nothing at all", async () => {
    // Absent and empty are different states. Reading an empty list back as the
    // default would turn two columns on again for someone who had just turned
    // every one of them off.
    const first = await load();
    for (const field of ["due", "assignees"] as const) first.toggleSubtaskField(field);

    const second = await load(Object.fromEntries(store));

    expect([...second.subtaskFields()]).toEqual([]);
  });
});

describe("a storage key that is not ours", () => {
  test("falls back rather than rendering a column that does not exist", async () => {
    const { showsField, subtaskFields } = await load({
      "rask.subtasks.fields": '["due","invented","tracked"]',
    });
    expect([...subtaskFields()]).toEqual(["due", "tracked"]);
    expect(showsField("due")).toBe(true);
  });

  test("survives junk", async () => {
    const { subtaskFields } = await load({ "rask.subtasks.fields": "{oh no" });
    expect([...subtaskFields()]).toEqual(["due", "assignees"]);
  });
});
