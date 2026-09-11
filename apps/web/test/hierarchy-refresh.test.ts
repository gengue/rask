import { afterEach, beforeEach, expect, test } from "bun:test";

/**
 * The poll that keeps the sidebar from showing a List name ClickUp has dropped.
 *
 * Nothing here is about the request itself; it is about the two guards around
 * it, both of which fail silently. A visibility check inverted by one `!` turns
 * every backgrounded tab into a request every five minutes and the tab you are
 * actually looking at into one that never refreshes — and neither shows up as
 * anything but a name that is wrong, which is what this whole change is fixing.
 */

/** The listener `watchHierarchy` registers, so the test can be the browser. */
let onVisibilityChange: (() => void) | null = null;
let visibility: DocumentVisibilityState = "visible";
let now = 1_000_000;
let hierarchyRequests = 0;

const realFetch = globalThis.fetch;
const realNow = Date.now;

// Set before the import below, because `api.ts` and its dependencies are free
// to touch `document` while they are being evaluated.
globalThis.document = {
  get visibilityState() {
    return visibility;
  },
  addEventListener(type: string, handler: () => void) {
    if (type === "visibilitychange") onVisibilityChange = handler;
  },
  removeEventListener(type: string) {
    if (type === "visibilitychange") onVisibilityChange = null;
  },
} as unknown as Document;

const { loadSession, watchHierarchy, spaces } = await import("../src/lib/session.ts");

const EMPTY_TREE = { spaces: [], docs: [] };

beforeEach(() => {
  hierarchyRequests = 0;
  visibility = "visible";
  Date.now = () => now;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = typeof input === "string" ? input : input.toString();
    if (path === "/api/hierarchy") hierarchyRequests++;
    const body = path === "/api/hierarchy" ? EMPTY_TREE : path === "/api/me" ? { id: "u1" } : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

/** Past the refresh window, so the next check is allowed to ask. */
function waitOutTheWindow(): void {
  now += 6 * 60_000;
}

test("a tab in the background does not ask", async () => {
  const stop = watchHierarchy();
  waitOutTheWindow();

  visibility = "hidden";
  onVisibilityChange?.();

  expect(hierarchyRequests).toBe(0);
  stop();
});

test("coming back to the foreground asks, and asks once", async () => {
  const stop = watchHierarchy();
  waitOutTheWindow();

  onVisibilityChange?.();
  // Alt-tabbing back and forth is not a reason to ask again.
  onVisibilityChange?.();
  onVisibilityChange?.();

  // The read is fired and not awaited, which is the point of the timestamp
  // being stamped before it rather than after.
  await Promise.resolve();
  expect(hierarchyRequests).toBe(1);

  waitOutTheWindow();
  onVisibilityChange?.();
  await Promise.resolve();
  expect(hierarchyRequests).toBe(2);

  stop();
});

test("the load that populated the tree counts as a read", async () => {
  await loadSession();
  expect(spaces()).toEqual([]);
  hierarchyRequests = 0;

  const stop = watchHierarchy();
  // No clock movement: `loadSession` just read the tree, so a tab that gains
  // focus a second later has nothing to ask for.
  onVisibilityChange?.();

  expect(hierarchyRequests).toBe(0);
  stop();
});

test("stopping unregisters the listener", () => {
  const stop = watchHierarchy();
  expect(onVisibilityChange).not.toBeNull();
  stop();
  expect(onVisibilityChange).toBeNull();
});
