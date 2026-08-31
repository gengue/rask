import type { DocRef, Space } from "./api.ts";

/**
 * Which nodes of the workspace tree have to be open for a row to be visible.
 *
 * Pure walks over the hierarchy, kept out of the sidebar because that is what
 * makes them testable: the failure they exist to stop is silent. A deep link to
 * something three levels down lands on a tree that never unfolds, and the row
 * is simply not there — no error, nothing to click, nothing in the console.
 */

/** The Space, and Folder if there is one, holding this List. */
export function pathToList(spaces: Space[], listId: string): string[] | null {
  for (const space of spaces) {
    if (space.lists.some((list) => list.id === listId)) return [space.id];
    for (const folder of space.folders) {
      if (folder.lists.some((list) => list.id === listId)) return [space.id, folder.id];
    }
  }
  return null;
}

/**
 * The same, for a Doc — which can hang off any of the three levels.
 *
 * Null for a Doc filed at the Workspace: those live in their own section below
 * the tree, where there is nothing to unfold.
 */
export function pathToDoc(spaces: Space[], docId: string): string[] | null {
  const has = (docs: DocRef[]) => docs.some((doc) => doc.id === docId);

  for (const space of spaces) {
    if (has(space.docs)) return [space.id];
    for (const list of space.lists) {
      if (has(list.docs)) return [space.id];
    }
    for (const folder of space.folders) {
      if (has(folder.docs)) return [space.id, folder.id];
      for (const list of folder.lists) {
        if (has(list.docs)) return [space.id, folder.id];
      }
    }
  }
  return null;
}
