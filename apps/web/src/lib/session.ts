import { createSignal } from "solid-js";
import { type Assignee, api, type DocRef, type Me, type Space } from "./api.ts";

/**
 * Who is signed in and what the workspace looks like.
 *
 * Loaded once and shared as signals rather than a resource per component: the
 * sidebar, the command palette, the My Tasks filter and the list title all need
 * this, and four independent fetches of the same thing is exactly the waste
 * Rask is meant to avoid.
 */
export const [me, setMe] = createSignal<Me | null>(null);
export const [spaces, setSpaces] = createSignal<Space[]>([]);
/** Docs that hang off the Workspace itself. Their own section in the sidebar. */
export const [workspaceDocs, setWorkspaceDocs] = createSignal<DocRef[]>([]);
export const [members, setMembers] = createSignal<Assignee[]>([]);

export async function loadSession(): Promise<void> {
  const [user, tree, directory] = await Promise.all([api.me(), api.hierarchy(), api.members()]);
  setMe(user);
  setSpaces(tree.spaces);
  setWorkspaceDocs(tree.docs);
  setMembers(directory);
}

export async function reloadHierarchy(): Promise<void> {
  const tree = await api.hierarchy();
  setSpaces(tree.spaces);
  setWorkspaceDocs(tree.docs);
}

/** Resolves a list id to its name without another round trip. */
export function listName(listId: string): string | null {
  for (const space of spaces()) {
    for (const list of space.lists) if (list.id === listId) return list.name;
    for (const folder of space.folders) {
      for (const list of folder.lists) if (list.id === listId) return list.name;
    }
  }
  return null;
}
