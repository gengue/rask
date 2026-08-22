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

/** Search, facet filters and grouping, shared by the list and the keyboard. */
export const flatItems = createMemo<FlatItem[]>(() => {
  const query = ui.search.trim().toLowerCase();
  const { status, assignee, tag } = ui.filters;

  const filtered = viewTasks().filter((task) => {
    if (status && task.status !== status) return false;
    if (assignee && !task.assignees.some((user) => user.id === assignee)) return false;
    if (tag && !task.tags.some((t) => t.name === tag)) return false;
    if (!query) return true;
    return (
      task.name.toLowerCase().includes(query) ||
      (task.customId?.toLowerCase().includes(query) ?? false)
    );
  });

  return groupTasks(filtered, ui.groupBy);
});

/** Facet values present in the current view. Filtering by a value with no rows
 *  is never useful, so the options come from the data rather than a config. */
export const facets = createMemo(() => {
  const statuses = new Map<string, { value: string; color: string | null; type: string | null }>();
  const assignees = new Map<string, { value: string; label: string }>();
  const tags = new Map<string, { value: string; color: string | null }>();

  for (const task of viewTasks()) {
    if (task.status && !statuses.has(task.status)) {
      statuses.set(task.status, {
        value: task.status,
        color: task.statusColor,
        type: task.statusType,
      });
    }
    for (const user of task.assignees) {
      if (!assignees.has(user.id)) {
        assignees.set(user.id, { value: user.id, label: user.username ?? user.id });
      }
    }
    for (const tag of task.tags) {
      if (!tags.has(tag.name)) tags.set(tag.name, { value: tag.name, color: tag.bg ?? null });
    }
  }

  return {
    statuses: [...statuses.values()],
    assignees: [...assignees.values()].sort((a, b) => a.label.localeCompare(b.label)),
    tags: [...tags.values()].sort((a, b) => a.value.localeCompare(b.value)),
  };
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
