import { beforeEach, expect, test } from "bun:test";
import { createTestDb, syncCursors } from "@rask/schema";
import { like } from "drizzle-orm";
import { coldLists } from "../src/sync.ts";

/** Which lists still owe somebody their first read. See `coldLists` for why. */

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
  // The bare row apps/api/src/index.ts writes when the browser asks for a list.
  await db.insert(syncCursors).values({ scope: "list", scopeId: `${PREFIX}fresh` });
  expect(await cold()).toEqual([`${PREFIX}fresh`]);
});

test("a list that has been read is not, however that read went", async () => {
  await db
    .insert(syncCursors)
    .values({ scope: "list", scopeId: `${PREFIX}read`, lastRunAt: new Date() });
  expect(await cold()).toEqual([]);
});

test("only lists, never the team cursor", async () => {
  await db.insert(syncCursors).values({ scope: "team", scopeId: `${PREFIX}team` });
  expect(await cold()).toEqual([]);
});
