import { createMemo, createSignal } from "solid-js";
import type { Task } from "./api.ts";
import { type FlatItem, groupTasks } from "./grouping.ts";
import { ui } from "./ui.ts";

/**
 * What the main panel is currently showing.
 *
 * The route owns the query; this owns the result. Keeping it in one place is
 * what lets the keyboard layer act on "the task under the cursor" without the
 * shell knowing which route rendered it.
 */
export const [viewTasks, setViewTasks] = createSignal<Task[]>([]);
export const [viewTitle, setViewTitle] = createSignal("Tasks");
export const [viewListId, setViewListId] = createSignal<string | null>(null);

/** Search filter and grouping, applied once and shared by the list and the keyboard. */
export const flatItems = createMemo<FlatItem[]>(() => {
  const query = ui.search.trim().toLowerCase();
  const filtered = query
    ? viewTasks().filter(
        (task) =>
          task.name.toLowerCase().includes(query) ||
          (task.customId?.toLowerCase().includes(query) ?? false),
      )
    : viewTasks();
  return groupTasks(filtered, ui.groupBy);
});

/** Tasks in display order, headers removed. The cursor indexes into this. */
export const rowTasks = createMemo(() =>
  flatItems().flatMap((item) => (item.kind === "row" ? [item.task] : [])),
);

export function cursorTask(): Task | null {
  return rowTasks()[ui.cursor] ?? null;
}

/**
 * A row asking the shell to open the status menu for it.
 *
 * The shell owns every popover so there is only ever one open, but the click
 * originates deep inside a virtualized row. A signal beats threading a callback
 * through the list and the row.
 */
export const [statusRequest, setStatusRequest] = createSignal<{
  task: Task;
  anchor: { x: number; y: number };
} | null>(null);
