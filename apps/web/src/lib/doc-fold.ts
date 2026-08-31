import { createSignal } from "solid-js";

/**
 * Which headings a reader has folded shut, remembered between sessions.
 *
 * Same bargain as the sidebar's open set, for the same reason: a fold that
 * resets on reload is one nobody makes twice, and the pages this exists for are
 * long enough that reopening the reader means folding the same six sections
 * again before you can see where you were.
 *
 * One key holding `pageId:sectionId` strings rather than a key per page, so the
 * whole thing is one read at import. Nothing prunes it — an id belongs to a
 * page and a heading that may both be gone, which costs a few bytes and no
 * behaviour, exactly as the sidebar's stale folder ids do.
 */
const KEY = "rask.doc.folded";

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // A corrupt key is not worth a page that will not render. Start open.
    return [];
  }
}

const [foldedIds, setFoldedIds] = createSignal<ReadonlySet<string>>(new Set(read()));

const key = (pageId: string, sectionId: string): string => `${pageId}:${sectionId}`;

export const isFolded = (pageId: string, sectionId: string): boolean =>
  foldedIds().has(key(pageId, sectionId));

export function toggleFold(pageId: string, sectionId: string): void {
  const next = new Set(foldedIds());
  if (!next.delete(key(pageId, sectionId))) next.add(key(pageId, sectionId));
  setFoldedIds(next);
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    // Private mode, or a full quota. Folding still works for this session.
  }
}
