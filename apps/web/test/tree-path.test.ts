import { describe, expect, test } from "bun:test";
import type { DocRef, Space } from "../src/lib/api.ts";
import { pathToDoc, pathToList } from "../src/lib/tree-path.ts";

/**
 * What the sidebar has to unfold to show a row.
 *
 * The failure these prevent leaves nothing behind: a link to a Doc four levels
 * down opens the reader, and the tree beside it stays collapsed with the active
 * row inside a branch nobody can see. No error, no empty state, just a sidebar
 * that looks like it is showing something else.
 */

const doc = (id: string): DocRef => ({ id, name: id });

const SPACES: Space[] = [
  {
    id: "space-ai",
    name: "AI",
    docs: [doc("d-space")],
    lists: [{ id: "list-loose", name: "AI Tasks", docs: [doc("d-loose-list")] }],
    folders: [
      {
        id: "folder-execs",
        name: "Executives",
        docs: [doc("d-folder")],
        lists: [{ id: "list-in-folder", name: "Strategy", docs: [doc("d-nested-list")] }],
      },
    ],
  },
];

describe("pathToList", () => {
  test("a folderless List needs only its Space open", () => {
    expect(pathToList(SPACES, "list-loose")).toEqual(["space-ai"]);
  });

  test("a List in a Folder needs both", () => {
    expect(pathToList(SPACES, "list-in-folder")).toEqual(["space-ai", "folder-execs"]);
  });

  test("null for a List the tree does not hold", () => {
    expect(pathToList(SPACES, "list-elsewhere")).toBeNull();
  });
});

describe("pathToDoc", () => {
  test("a Doc on a Space needs its Space open", () => {
    expect(pathToDoc(SPACES, "d-space")).toEqual(["space-ai"]);
  });

  test("a Doc on a Folder needs the Folder too", () => {
    expect(pathToDoc(SPACES, "d-folder")).toEqual(["space-ai", "folder-execs"]);
  });

  /*
   * A List is a leaf that prints its Docs underneath it, so opening the branch
   * that contains the List is what makes the Doc visible — there is no node of
   * the List's own to unfold.
   */
  test("a Doc on a folderless List needs its Space", () => {
    expect(pathToDoc(SPACES, "d-loose-list")).toEqual(["space-ai"]);
  });

  test("a Doc on a List inside a Folder needs the Folder", () => {
    expect(pathToDoc(SPACES, "d-nested-list")).toEqual(["space-ai", "folder-execs"]);
  });

  /*
   * Workspace-level Docs are the majority in a real workspace and they live in
   * their own section below the tree. Returning a path for one would unfold a
   * branch that has nothing to do with what was opened.
   */
  test("null for a Doc that is not in the tree at all", () => {
    expect(pathToDoc(SPACES, "d-workspace")).toBeNull();
  });
});
