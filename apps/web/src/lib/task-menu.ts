import { isPlaceholder } from "@rask/clickup-client/vocabulary";

/**
 * What the right-click menu offers on a task, and the two addresses it copies.
 *
 * A plain function of the task rather than JSX in the shell, because the list
 * of entries is the part that has rules — a task the outbox has not shipped yet
 * has no upstream id, so half of them would 404 or come back as a 409.
 */

export type TaskAction =
  | "open"
  | "copy-link"
  | "copy-clickup"
  | "status"
  | "priority"
  | "archive"
  | "delete";

/** Structurally a `MenuItem`, without dragging the component's JSX types in here. */
export interface TaskMenuItem {
  id: TaskAction;
  label: string;
  hint?: string;
}

/** The address ClickUp itself uses for a task, and the one people paste around. */
export function clickUpTaskUrl(taskId: string): string {
  return `https://app.clickup.com/t/${taskId}`;
}

/**
 * Rask's own address for a task.
 *
 * Deliberately the same `/t/{id}` shape ClickUp uses: the catch-all route
 * already resolves that path (see `clickup-url.ts`), so this needs no route of
 * its own and a link survives the task moving between lists. The alternative —
 * the current URL with `?task=` on it — bakes in whichever view happened to be
 * open when it was copied.
 */
export function raskTaskUrl(origin: string, taskId: string): string {
  return `${origin.replace(/\/+$/, "")}/t/${taskId}`;
}

/**
 * One list, with the entries that cannot work without a ClickUp id marked.
 *
 * The alternative — a list per case — meant every label and keystroke written
 * out twice, which is how the two drift.
 */
const ITEMS: Array<TaskMenuItem & { needsClickUpId?: true }> = [
  { id: "open", label: "Open", hint: "o" },
  { id: "copy-link", label: "Copy link", needsClickUpId: true },
  { id: "copy-clickup", label: "Copy ClickUp URL", needsClickUpId: true },
  { id: "status", label: "Change status", hint: "s" },
  { id: "priority", label: "Set priority", hint: "p" },
  { id: "archive", label: "Archive", needsClickUpId: true },
  { id: "delete", label: "Delete", needsClickUpId: true },
];

export function taskMenuItems(task: { id: string }): TaskMenuItem[] {
  // A task the outbox has not shipped yet has no id ClickUp would recognise:
  // the two links resolve to nothing, and the two writes answer with a 409.
  const pending = isPlaceholder(task.id);
  return ITEMS.filter((item) => !(pending && item.needsClickUpId));
}
