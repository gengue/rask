import { beforeEach, describe, expect, test } from "bun:test";

/**
 * What the sidebar remembers.
 *
 * The tree could always render three levels; nobody could reach the third,
 * because every reload collapsed it and Tickets, then Infra, then Requests is
 * not a walk anyone repeats. So the value here is entirely in what survives a
 * reload, which means the localStorage round trip is the thing under test, not
 * an implementation detail behind it.
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
  return await import(`../src/lib/sidebar-state.ts?t=${Math.random()}`);
}

beforeEach(() => store.clear());

describe("expansion", () => {
  test("survives the reload that used to collapse it", async () => {
    const first = await load();
    first.toggleOpen("space-tickets");
    first.toggleOpen("folder-infra");

    const second = await load(Object.fromEntries(store));
    expect(second.isOpen("space-tickets")).toBe(true);
    expect(second.isOpen("folder-infra")).toBe(true);
  });

  test("toggling twice closes", async () => {
    const state = await load();
    state.toggleOpen("space-tickets");
    state.toggleOpen("space-tickets");
    expect(state.isOpen("space-tickets")).toBe(false);
  });

  test("revealPath only ever opens", async () => {
    // A deep link opens the branch it lands in. Closing what the user
    // deliberately collapsed, because the route happens to be inside it, is the
    // sidebar arguing with them.
    const state = await load();
    state.toggleOpen("space-ai");
    state.revealPath(["space-tickets", "folder-infra"]);

    expect(state.isOpen("space-ai")).toBe(true);
    expect(state.isOpen("space-tickets")).toBe(true);
    expect(state.isOpen("folder-infra")).toBe(true);
  });
});

describe("pins", () => {
  test("survive a reload", async () => {
    const first = await load();
    first.togglePinned("list-requests");

    const second = await load(Object.fromEntries(store));
    expect(second.isPinned("list-requests")).toBe(true);
    expect([...second.pinned()]).toEqual(["list-requests"]);
  });

  test("toggling twice unpins", async () => {
    const state = await load();
    state.togglePinned("list-requests");
    state.togglePinned("list-requests");
    expect(state.isPinned("list-requests")).toBe(false);
  });
});

describe("bad storage", () => {
  test("a corrupt key starts closed rather than breaking the sidebar", async () => {
    const state = await load({ "rask.sidebar.open": "{not json" });
    expect(state.isOpen("space-tickets")).toBe(false);
  });

  test("a key holding the wrong shape is ignored, not trusted", async () => {
    // Whatever wrote `{"a":1}` was not this module. Reading it as a set of ids
    // would put junk in the DOM as `open` state.
    const state = await load({ "rask.sidebar.pinned": '{"a":1}' });
    expect([...state.pinned()]).toEqual([]);
  });

  test("non-string entries are dropped, the rest kept", async () => {
    const state = await load({ "rask.sidebar.open": '["space-1",7,null,"space-2"]' });
    expect(state.isOpen("space-1")).toBe(true);
    expect(state.isOpen("space-2")).toBe(true);
  });
});
