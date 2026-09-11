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

/** When the tree was last read, which is what `watchHierarchy` paces itself by. */
let treeReadAt = 0;

export async function loadSession(): Promise<void> {
  const [user, tree, directory] = await Promise.all([api.me(), api.hierarchy(), api.members()]);
  treeReadAt = Date.now();
  setMe(user);
  setSpaces(tree.spaces);
  setWorkspaceDocs(tree.docs);
  setMembers(directory);
}

export async function reloadHierarchy(): Promise<void> {
  const tree = await api.hierarchy();
  treeReadAt = Date.now();
  setSpaces(tree.spaces);
  setWorkspaceDocs(tree.docs);
}

/**
 * How long the sidebar is allowed to keep showing a name ClickUp has dropped.
 *
 * The worker re-walks the tree on the same period, so a rename is visible
 * within ten minutes worst case and five on average. That is the whole budget:
 * Lists get renamed a handful of times a year, and the cost of halving it is
 * paid every second of every day by everyone.
 */
const TREE_REFRESH_MS = 5 * 60_000;

/**
 * Keeps the tree fresh under a tab nobody has reloaded.
 *
 * Deliberately a poll and not an SSE event. The change feed watches
 * `tasks.synced_at`, and there is no equivalent column for the tree: the
 * hierarchy walk upserts every Space, Folder and List it reads, so their
 * `synced_at` moves every five minutes whether or not a name changed. Telling a
 * real change from a re-read means comparing the tree itself, once a second,
 * forever, for something that changes a few times a year. A tab asking for it
 * every five minutes is four small indexed selects against that.
 *
 * Hidden tabs do not ask, and a tab coming back to the foreground asks
 * immediately unless it already has — otherwise alt-tabbing between ClickUp and
 * Rask would be one request per flip.
 */
export function watchHierarchy(): () => void {
  const refresh = (): void => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - treeReadAt < TREE_REFRESH_MS) return;
    // Stamped before the request, not after: two ticks must not overlap, and a
    // failed read is a reason to wait rather than to retry in a tight loop.
    treeReadAt = Date.now();
    // Swallowed on purpose. A tree that did not arrive is the one already on
    // screen, the next tick tries again, and `connected` is what tells someone
    // the API is unreachable.
    void reloadHierarchy().catch(() => {});
  };

  const timer = setInterval(refresh, TREE_REFRESH_MS);
  document.addEventListener("visibilitychange", refresh);

  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", refresh);
  };
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
