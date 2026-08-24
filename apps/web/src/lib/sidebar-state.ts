import { createSignal } from "solid-js";

/**
 * What the sidebar remembers between sessions: which nodes are open, and which
 * lists are pinned.
 *
 * Both were per-component signals that reset on every reload, which made a list
 * three levels down effectively unreachable: Tickets, then Infra, then
 * Requests, every single time. Depth the tree could render but nobody would
 * walk twice.
 *
 * Ids, not paths. A folder renamed in ClickUp keeps its expansion; a folder
 * deleted leaves an id nothing matches, which costs a few bytes and no
 * behaviour, so nothing prunes them.
 */
const OPEN_KEY = "rask.sidebar.open";
const PINNED_KEY = "rask.sidebar.pinned";

function read(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // A corrupt key is not worth a broken sidebar. Start closed.
    return [];
  }
}

function write(key: string, values: Iterable<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...values]));
  } catch {
    // Private mode, or a full quota. The tree still works for this session.
  }
}

const [openIds, setOpenIds] = createSignal<ReadonlySet<string>>(new Set(read(OPEN_KEY)));
const [pinnedIds, setPinnedIds] = createSignal<ReadonlySet<string>>(new Set(read(PINNED_KEY)));

export const isOpen = (id: string): boolean => openIds().has(id);

export function toggleOpen(id: string): void {
  const next = new Set(openIds());
  if (!next.delete(id)) next.add(id);
  setOpenIds(next);
  write(OPEN_KEY, next);
}

/**
 * Opens every node on the way to a list, so a deep link lands with its branch
 * unfolded instead of somewhere the sidebar cannot show.
 */
export function revealPath(ids: readonly string[]): void {
  const next = new Set(openIds());
  const before = next.size;
  for (const id of ids) next.add(id);
  if (next.size === before) return;
  setOpenIds(next);
  write(OPEN_KEY, next);
}

export const pinned = pinnedIds;

export const isPinned = (id: string): boolean => pinnedIds().has(id);

export function togglePinned(id: string): void {
  const next = new Set(pinnedIds());
  if (!next.delete(id)) next.add(id);
  setPinnedIds(next);
  write(PINNED_KEY, next);
}
