import { afterAll, beforeEach, expect, test } from "bun:test";
import { clickUpDoc } from "@rask/clickup-client";
import { eq, inArray } from "drizzle-orm";
import { replaceDocs } from "../src/ingest.ts";
import { mapDoc } from "../src/map.ts";
import { docs } from "../src/schema.ts";
import { createTestDb } from "../src/test-db.ts";

/**
 * The Doc index, which is the one table here that deletes rows it was not given.
 *
 * That is deliberate — the walk behind it answers with every Doc in the
 * workspace, so absence really is deletion and a sidebar offering a Doc
 * somebody removed sends people to a 404. It is also the reason this file
 * exists: the delete is scoped to one team, and a mistake there empties a
 * workspace's sidebar with no error anywhere.
 */

const db = createTestDb();

const MINE = "docs-index-team";
const THEIRS = "docs-index-other-team";

const wipe = () => db.delete(docs).where(inArray(docs.teamId, [MINE, THEIRS]));

function doc(over: Record<string, unknown>) {
  return clickUpDoc.parse({
    id: "gh-1",
    name: "Notes",
    parent: { id: "90157146054", type: 4 },
    date_created: 1_786_731_888_405,
    date_updated: 1_787_833_798_853,
    ...over,
  });
}

beforeEach(wipe);
afterAll(wipe);

test("stores the parent ClickUp gave, number and all", async () => {
  await replaceDocs(db, MINE, [doc({ id: "gh-1", parent: { id: "t1", type: 1 } })].map(m(MINE)));

  const [row] = await db.select().from(docs).where(eq(docs.id, "gh-1"));

  expect(row?.parentType).toBe(1);
  expect(row?.parentId).toBe("t1");
  expect(row?.dateUpdated?.getTime()).toBe(1_787_833_798_853);
});

test("names an unnamed Doc so the tree never draws a blank row", async () => {
  await replaceDocs(db, MINE, [doc({ name: "   " })].map(m(MINE)));

  const [row] = await db.select().from(docs).where(eq(docs.id, "gh-1"));

  expect(row?.name).toBe("Doc");
});

test("a second pass updates rather than duplicating", async () => {
  await replaceDocs(db, MINE, [doc({ name: "Before" })].map(m(MINE)));
  await replaceDocs(db, MINE, [doc({ name: "After" })].map(m(MINE)));

  const rows = await db.select().from(docs).where(eq(docs.teamId, MINE));

  expect(rows).toHaveLength(1);
  expect(rows[0]?.name).toBe("After");
});

test("drops a Doc the walk no longer mentions, because it was deleted upstream", async () => {
  await replaceDocs(db, MINE, [doc({ id: "gh-1" }), doc({ id: "gh-2" })].map(m(MINE)));
  await replaceDocs(db, MINE, [doc({ id: "gh-1" })].map(m(MINE)));

  const ids = (await db.select().from(docs).where(eq(docs.teamId, MINE))).map((r) => r.id);

  expect(ids).toEqual(["gh-1"]);
});

/*
 * The scoping this file exists for. One team's walk must not be able to empty
 * another's index — and with `replaceDocs` deleting everything it was not
 * given, an unscoped delete would do exactly that on every sync.
 */
test("never touches another workspace's Docs", async () => {
  await replaceDocs(db, THEIRS, [doc({ id: "gh-theirs" })].map(m(THEIRS)));
  await replaceDocs(db, MINE, [doc({ id: "gh-mine" })].map(m(MINE)));

  const theirs = await db.select().from(docs).where(eq(docs.teamId, THEIRS));

  expect(theirs.map((r) => r.id)).toEqual(["gh-theirs"]);
});

/*
 * An empty answer is a real answer: a workspace whose last Doc was deleted has
 * none, and the index has to be able to say so. The caller is what refuses to
 * pass `[]` for a *failed* read — see `readDocIndex` in the worker.
 */
test("an empty pass empties that team's index", async () => {
  await replaceDocs(db, MINE, [doc({ id: "gh-1" })].map(m(MINE)));
  await replaceDocs(db, THEIRS, [doc({ id: "gh-theirs" })].map(m(THEIRS)));

  await replaceDocs(db, MINE, []);

  expect(await db.select().from(docs).where(eq(docs.teamId, MINE))).toEqual([]);
  expect(await db.select().from(docs).where(eq(docs.teamId, THEIRS))).toHaveLength(1);
});

function m(teamId: string) {
  return (d: Parameters<typeof mapDoc>[0]) => mapDoc(d, teamId);
}
