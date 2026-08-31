import { createSignal } from "solid-js";

/**
 * Which Custom Fields the user asked to see, and where.
 *
 * Three choices, three keys. List columns are per list — the field that earns
 * 110px on a deals list is noise on a bugs list, which is also how ClickUp
 * scopes its own columns. The detail panel's pins and hides are global,
 * because the panel opens tasks from any list and a field hidden as clutter is
 * clutter everywhere.
 *
 * Per browser, not per workspace, like the sidebar's expansion and the subtask
 * columns: these are reading preferences, they cost nothing when lost, and a
 * server table would be a migration plus a write path for something the mirror
 * has no other reason to know.
 */

const COLUMNS_KEY = "rask.fields.columns";
const HIDDEN_KEY = "rask.fields.hidden";
const PINNED_KEY = "rask.fields.pinned";

function readColumns(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const clean: Record<string, string[]> = {};
    for (const [listId, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids)) {
        clean[listId] = ids.filter((id): id is string => typeof id === "string");
      }
    }
    return clean;
  } catch {
    // A corrupt key is not worth broken lists. Start with none chosen.
    return {};
  }
}

function readIds(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode, or a full quota. The choice still holds for this session.
  }
}

const [columns, setColumns] = createSignal<Record<string, string[]>>(readColumns());
const [hiddenIds, setHiddenIds] = createSignal<ReadonlySet<string>>(new Set(readIds(HIDDEN_KEY)));
const [pinnedIds, setPinnedIds] = createSignal<ReadonlySet<string>>(new Set(readIds(PINNED_KEY)));

/** The columns chosen for one list, in the order they were chosen. */
export const columnsFor = (listId: string): string[] => columns()[listId] ?? [];

export function toggleColumn(listId: string, fieldId: string): void {
  const current = columnsFor(listId);
  const next = current.includes(fieldId)
    ? current.filter((id) => id !== fieldId)
    : [...current, fieldId];
  const all = { ...columns(), [listId]: next };
  if (next.length === 0) delete all[listId];
  setColumns(all);
  write(COLUMNS_KEY, all);
}

export const hiddenFields = hiddenIds;
export const pinnedFields = pinnedIds;

/**
 * Hide and pin exclude each other: a field cannot be both always on screen and
 * never on screen, so flipping one side on takes the other off.
 */
export function toggleHiddenField(fieldId: string): void {
  const next = new Set(hiddenIds());
  if (!next.delete(fieldId)) {
    next.add(fieldId);
    dropPin(fieldId);
  }
  setHiddenIds(next);
  write(HIDDEN_KEY, [...next]);
}

export function togglePinnedField(fieldId: string): void {
  const next = new Set(pinnedIds());
  if (!next.delete(fieldId)) {
    next.add(fieldId);
    const hidden = new Set(hiddenIds());
    if (hidden.delete(fieldId)) {
      setHiddenIds(hidden);
      write(HIDDEN_KEY, [...hidden]);
    }
  }
  setPinnedIds(next);
  write(PINNED_KEY, [...next]);
}

function dropPin(fieldId: string): void {
  const pinned = new Set(pinnedIds());
  if (!pinned.delete(fieldId)) return;
  setPinnedIds(pinned);
  write(PINNED_KEY, [...pinned]);
}
