import { beforeEach, expect, test } from "bun:test";
import { createTestDb, syncCursors } from "@rask/schema";
import { and, eq, like } from "drizzle-orm";
import { coldLists } from "../src/sync.ts";

/**
 * Which lists still owe somebody their first read.
 *
 * Opening a list writes a cursor row and nothing else, so this predicate is the
 * whole difference between a list that fills in seconds and one that waits for
 * the next poll — ten minutes of it once a webhook is delivering. It has to
 * stay false for a list that has already been read, including one whose read
 * failed: `recordFailure` stamps `lastRunAt` precisely so a list ClickUp keeps
 * refusing falls back to the poll's backoff instead of being retried every
 * three seconds forever.
 */

const db = createTestDb();
const PREFIX = "cold-test-";

async function cold(): Promise<string[]> {
  const all = await coldLists(db);
  return all.filter((id) => id.startsWith(PREFIX)).sort();
}

beforeEach(async () => {
  await db.delete(syncCursors).where(like(syncCursors.scopeId, `${PREFIX}%`));
});

test("a list nobody has read yet is cold", async () => {
  await db.insert(syncCursors).values({ scope: "list", scopeId: `${PREFIX}fresh` });
  expect(await cold()).toEqual([`${PREFIX}fresh`]);
});

test("a list that has been read is not", async () => {
  await db
    .insert(syncCursors)
    .values({ scope: "list", scopeId: `${PREFIX}read`, lastRunAt: new Date() });
  expect(await cold()).toEqual([]);
});

test("a list whose read failed is not, so it backs off with the poll", async () => {
  await db.insert(syncCursors).values({
    scope: "list",
    scopeId: `${PREFIX}failed`,
    lastRunAt: new Date(),
    failures: 3,
    lastError: "GET /v2/list/x/task -> 404",
  });
  expect(await cold()).toEqual([]);
});

test("only lists, never the team cursor", async () => {
  await db.insert(syncCursors).values({ scope: "team", scopeId: `${PREFIX}team` });
  expect(await cold()).toEqual([]);
});

test("an empty result is the normal steady state", async () => {
  expect(await cold()).toEqual([]);
});

test("the cursor written when a list is opened is exactly what counts as cold", async () => {
  // Mirrors apps/api/src/index.ts: loading a list inserts the bare row.
  await db
    .insert(syncCursors)
    .values({ scope: "list", scopeId: `${PREFIX}opened` })
    .onConflictDoNothing();
  expect(await cold()).toEqual([`${PREFIX}opened`]);

  // And the sync that follows clears it, whatever the outcome.
  await db
    .update(syncCursors)
    .set({ lastRunAt: new Date() })
    .where(and(eq(syncCursors.scope, "list"), eq(syncCursors.scopeId, `${PREFIX}opened`)));
  expect(await cold()).toEqual([]);
});
