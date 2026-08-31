import { afterAll, beforeEach, expect, test } from "bun:test";
import { DOC_PARENT } from "@rask/clickup-client";
import { createTestDb, docs, folders, lists, spaces } from "@rask/schema";
import { eq } from "drizzle-orm";
import { getHierarchy } from "../src/queries.ts";

/**
 * Where a Doc lands in the sidebar tree.
 *
 * Worth its own file because every way of getting this wrong is silent. A Doc
 * filed under the wrong parent type still renders, in the wrong place; one
 * whose type has no node simply vanishes, and the sidebar looks like a
 * workspace that has fewer Docs than it does. ClickUp's numbers are the whole
 * mapping and they do not line up with the view parents they resemble — 7 is
 * Everything here and the Workspace is 12.
 */

const db = createTestDb();

const TEAM = "hier-docs-team";
const SPACE = "hier-docs-space";
const FOLDER = "hier-docs-folder";
const LIST_IN_FOLDER = "hier-docs-list-folder";
const LOOSE_LIST = "hier-docs-list-loose";

async function wipe() {
  await db.delete(docs).where(eq(docs.teamId, TEAM));
  await db.delete(lists).where(eq(lists.spaceId, SPACE));
  await db.delete(folders).where(eq(folders.spaceId, SPACE));
  await db.delete(spaces).where(eq(spaces.id, SPACE));
}

/** Only this test's Space, so a shared database cannot change the answer. */
async function tree() {
  const all = await getHierarchy(db);
  return {
    space: all.spaces.find((s) => s.id === SPACE),
    workspaceDocs: all.docs.filter((d) => d.id.startsWith("d-")),
  };
}

function doc(id: string, name: string, parentType: number, parentId: string) {
  return { id, teamId: TEAM, name, parentType, parentId };
}

beforeEach(async () => {
  await wipe();
  await db.insert(spaces).values({ id: SPACE, teamId: TEAM, name: "AI" });
  await db.insert(folders).values({ id: FOLDER, spaceId: SPACE, name: "Executives" });
  await db.insert(lists).values([
    { id: LIST_IN_FOLDER, spaceId: SPACE, folderId: FOLDER, name: "Strategy" },
    { id: LOOSE_LIST, spaceId: SPACE, folderId: null, name: "AI Tasks" },
  ]);
});

afterAll(wipe);

test("hangs each Doc off the node its parent type names", async () => {
  await db
    .insert(docs)
    .values([
      doc("d-space", "AI Release notes", DOC_PARENT.space, SPACE),
      doc("d-folder", "Team charter", DOC_PARENT.folder, FOLDER),
      doc("d-list", "Sprint notes", DOC_PARENT.list, LIST_IN_FOLDER),
    ]);

  const { space } = await tree();

  expect(space?.docs.map((d) => d.name)).toEqual(["AI Release notes"]);
  expect(space?.folders[0]?.docs.map((d) => d.name)).toEqual(["Team charter"]);
  expect(space?.folders[0]?.lists[0]?.docs.map((d) => d.name)).toEqual(["Sprint notes"]);
});

/*
 * 4, 5 and 6 mean the same thing for a view and for a Doc; 7 does not. On a
 * view it is the Workspace, on a Doc it is Everything, and the Workspace is 12.
 * Reusing `VIEW_PARENT` would put every workspace Doc under a Space that does
 * not exist and drop it from the tree without a word.
 */
test("keeps Everything and Workspace Docs, in the section outside the tree", async () => {
  await db
    .insert(docs)
    .values([
      doc("d-workspace", "Company handbook", DOC_PARENT.workspace, TEAM),
      doc("d-everything", "Scratch", DOC_PARENT.everything, TEAM),
    ]);

  const { space, workspaceDocs } = await tree();

  expect(workspaceDocs.map((d) => d.name).sort()).toEqual(["Company handbook", "Scratch"]);
  // And nowhere in the tree, or they would appear twice.
  expect(space?.docs).toEqual([]);
});

/*
 * Task Docs are the majority by count and they already have a home in the task
 * panel. Hanging them off the List their task lives in would scatter a hundred
 * rows through the sidebar under names that mean nothing out of context.
 */
test("leaves a task's Docs out of the tree entirely", async () => {
  await db.insert(docs).values([doc("d-task", "Flights inbox", DOC_PARENT.task, "86cb4ckva")]);

  const { space, workspaceDocs } = await tree();

  expect(workspaceDocs).toEqual([]);
  expect(space?.docs).toEqual([]);
  expect(space?.lists.flatMap((l) => l.docs)).toEqual([]);
});

test("an archived Doc is not in the tree", async () => {
  await db
    .insert(docs)
    .values([{ ...doc("d-space", "Old notes", DOC_PARENT.space, SPACE), archived: true }]);

  const { space } = await tree();

  expect(space?.docs).toEqual([]);
});

test("a List with no Docs still carries the empty array the tree expects", async () => {
  const { space } = await tree();

  const loose = space?.lists.find((l) => l.id === LOOSE_LIST);
  expect(loose?.docs).toEqual([]);
});
