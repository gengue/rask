import { createSignal } from "solid-js";

/**
 * Which columns the subtask list draws next to a name.
 *
 * A subtask row used to be a status glyph and a title, which said nothing about
 * whose it was or when it was wanted — the two questions a parent is opened to
 * answer. Rather than guess a fourth time, the row is what the reader says it
 * is: a recruiting parent wants assignees, a build task wants the estimate
 * against the tracked total.
 *
 * Per browser, not per workspace. This is a reading preference about a panel,
 * so it lives in localStorage next to the sidebar's expansion rather than in
 * the mirror, and it costs nothing when it is lost.
 */
export type SubtaskField = "due" | "estimate" | "tracked" | "assignees";

export const SUBTASK_FIELDS: ReadonlyArray<{ id: SubtaskField; label: string }> = [
  { id: "due", label: "Due date" },
  { id: "estimate", label: "Estimate" },
  { id: "tracked", label: "Tracked time" },
  { id: "assignees", label: "Assignees" },
];

const KEY = "rask.subtasks.fields";

/** What the panel showed before anybody chose: the two the list row carries. */
const DEFAULT: SubtaskField[] = ["due", "assignees"];

const isField = (value: unknown): value is SubtaskField =>
  SUBTASK_FIELDS.some((field) => field.id === value);

function read(): SubtaskField[] {
  try {
    const raw = localStorage.getItem(KEY);
    // Absent is not the same as empty: turning every column off is a choice,
    // and reading it back as the default would undo it on the next reload.
    if (raw == null) return DEFAULT;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isField) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

const [fields, setFields] = createSignal<ReadonlySet<SubtaskField>>(new Set(read()));

export const subtaskFields = fields;

export const showsField = (field: SubtaskField): boolean => fields().has(field);

export function toggleSubtaskField(field: SubtaskField): void {
  const next = new Set(fields());
  if (!next.delete(field)) next.add(field);
  setFields(next);
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    // Private mode, or a full quota. The choice still holds for this session.
  }
}

/**
 * A boolean reading preference with the same lifecycle as the columns above:
 * read once at import, flipped from a button, kept in localStorage so a reload
 * does not undo it.
 */
function persistedFlag(key: string, fallback: boolean) {
  const read = (): boolean => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : raw === "1";
    } catch {
      return fallback;
    }
  };
  const [flag, setFlag] = createSignal(read());
  const toggle = (): void => {
    const next = !flag();
    setFlag(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Private mode, or a full quota. The choice still holds for this session.
    }
  };
  return [flag, toggle] as const;
}

/**
 * Whether the panel's subtask rows hide the ones already closed.
 *
 * Distinct from the list view's `showClosed`: that is about which tasks a view
 * shows, this is about how much of a parent's history the panel replays. The
 * header keeps counting done/total either way, so nothing hidden is unsaid.
 */
export const [hideDoneSubtasks, toggleHideDoneSubtasks] = persistedFlag(
  "rask.subtasks.hideDone",
  false,
);

/** Whether the expanded task view draws its subtasks as an index rail on the left. */
export const [subtaskIndexOpen, toggleSubtaskIndex] = persistedFlag("rask.subtasks.index", false);
