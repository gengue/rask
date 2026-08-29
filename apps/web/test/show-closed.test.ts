import { beforeEach, describe, expect, test } from "bun:test";
import type { View } from "../src/lib/api.ts";

/**
 * Whether closed statuses are drawn, and whose answer wins.
 *
 * Two things kept losing it. The store held the flag per tab, so a reload
 * started over; and `applyView` wrote every saved view's `show_closed` over the
 * top, so opening the next tab did too. Both were invisible on a list and
 * obvious on a board — the Done column was there, then it was not — which is
 * why the round trip and the precedence are what is under test rather than the
 * predicate they feed.
 */

const store = new Map<string, string>();

// `bun test` has no DOM. A Map is the whole contract these modules use.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

function view(over: Partial<View> = {}): View {
  return {
    id: "gh-96195",
    listId: "901516038590",
    name: "Ventura AI",
    type: "board",
    isDefault: false,
    groupField: "status",
    showClosed: false,
    publicUrl: null,
    ...over,
  };
}

beforeEach(() => store.clear());

describe("a choice", () => {
  test("survives the reload", async () => {
    const first = await import(`../src/lib/ui.ts?t=${Math.random()}`);
    first.setShowClosed(true);

    const second = await import(`../src/lib/ui.ts?t=${Math.random()}`);

    expect(second.ui.showClosed).toBe(true);
  });

  test("survives even when it is to hide them again", async () => {
    // Absent and false are different states: read back as absent, the next
    // saved view would seed the toggle and undo the choice just made.
    store.set("rask.showClosed", "1");
    const first = await import(`../src/lib/ui.ts?t=${Math.random()}`);
    first.setShowClosed(false);

    const second = await import(`../src/lib/ui.ts?t=${Math.random()}`);

    expect(second.ui.showClosed).toBe(false);
  });

  test("starts hidden when nobody has made one", async () => {
    const { ui, readShowClosed } = await import(`../src/lib/ui.ts?t=${Math.random()}`);
    expect(readShowClosed()).toBe(null);
    expect(ui.showClosed).toBe(false);
  });
});

describe("a saved view", () => {
  // One instance of both modules, because `applyView` writes through the same
  // `ui` store this reads — a cache-busted copy would be a different store.
  const load = async () => ({
    ...(await import("../src/lib/ui.ts")),
    ...(await import("../src/lib/clickup-views.ts")),
  });

  test("seeds the toggle while nobody has an opinion", async () => {
    const { applyView, ui } = await load();

    applyView(view({ showClosed: true }));
    expect(ui.showClosed).toBe(true);

    applyView(view({ id: "gh-2", showClosed: false }));
    expect(ui.showClosed).toBe(false);
  });

  test("stops arguing once the reader has one", async () => {
    const { applyView, setShowClosed, ui } = await load();

    setShowClosed(true);
    // The regression this is here for: the next tab is a view with
    // `show_closed: false`, and clicking it used to take the Done column away.
    applyView(view({ showClosed: false }));
    expect(ui.showClosed).toBe(true);

    setShowClosed(false);
    applyView(view({ showClosed: true }));
    expect(ui.showClosed).toBe(false);
  });

  test("still applies the rest of itself", async () => {
    // The precedence is about one field. A view that stops setting the layout
    // is a board tab rendering rows.
    const { applyView, setShowClosed, ui } = await load();

    setShowClosed(true);
    applyView(view({ type: "board", groupField: "assignee", showClosed: false }));

    expect(ui.layout).toBe("board");
    expect(ui.groupBy).toBe("assignee");
    expect(ui.cursor).toBe(0);
  });
});
