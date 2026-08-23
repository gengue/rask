import type { Task } from "./api.ts";
import { formatDue, PRIORITY_LABELS } from "./format.ts";
import type { GroupBy } from "./ui.ts";

export interface GroupHeader {
  kind: "header";
  id: string;
  label: string;
  count: number;
  color: string | null;
  statusType: string | null;
}

export interface GroupRow {
  kind: "row";
  id: string;
  task: Task;
}

export type FlatItem = GroupHeader | GroupRow;

/**
 * Groups tasks and flattens the result into one array.
 *
 * Flat is what the virtualizer needs: headers and rows share an index space, so
 * j/k walks the same list the eye does and scrolling never has to reason about
 * nested structures.
 */
export function groupTasks(tasks: Task[], groupBy: GroupBy): FlatItem[] {
  if (groupBy === "none") {
    return tasks.map((task) => ({ kind: "row", id: task.id, task }));
  }

  const groups = new Map<
    string,
    { label: string; color: string | null; type: string | null; tasks: Task[] }
  >();

  for (const task of tasks) {
    const key = groupKey(task, groupBy);
    const existing = groups.get(key.id);
    if (existing) existing.tasks.push(task);
    else groups.set(key.id, { label: key.label, color: key.color, type: key.type, tasks: [task] });
  }

  const order = FIXED_ORDER[groupBy] ?? [...groups.keys()];
  const sorted = [...groups.entries()].sort(
    (a, b) => rank(order, a[0]) - rank(order, b[0]) || a[1].label.localeCompare(b[1].label),
  );

  return sorted.flatMap(([id, group]): FlatItem[] => [
    {
      kind: "header",
      id: `header:${id}`,
      label: group.label,
      count: group.tasks.length,
      color: group.color,
      statusType: group.type,
    },
    ...group.tasks.map((task): FlatItem => ({ kind: "row", id: task.id, task })),
  ]);
}

/**
 * Groupings whose order is the meaning, not the alphabet.
 *
 * Due dates and priorities both run from "deal with this" to "do not", and
 * sorting either of them by label would put "Low" above "Urgent". Everything
 * else — status, assignee, list — has no inherent order, so its groups come out
 * in the order the rows produced them.
 */
const FIXED_ORDER: Partial<Record<GroupBy, string[]>> = {
  due: ["overdue", "today", "soon", "later", "none"],
  priority: ["1", "2", "3", "4", "none"],
};

function rank(order: string[], id: string): number {
  const index = order.indexOf(id);
  // Unknown keys sort after known ones rather than jumping to the top.
  return index === -1 ? order.length : index;
}

function groupKey(
  task: Task,
  groupBy: GroupBy,
): { id: string; label: string; color: string | null; type: string | null } {
  if (groupBy === "list") {
    return {
      id: task.listId,
      label: task.listName ?? "Unknown list",
      color: null,
      type: null,
    };
  }

  if (groupBy === "assignee") {
    const first = task.assignees[0];
    return {
      id: first?.id ?? "none",
      label: first?.username ?? "Unassigned",
      color: first?.color ?? null,
      type: null,
    };
  }

  if (groupBy === "due") {
    const due = formatDue(task.dueDate);
    if (!due) return { id: "none", label: "No due date", color: null, type: null };
    const id = due.tone === "normal" ? "later" : due.tone;
    return { id, label: DUE_LABELS[id] ?? "Later", color: null, type: null };
  }

  if (groupBy === "priority") {
    if (task.priority == null) return { id: "none", label: "No priority", color: null, type: null };
    return {
      id: String(task.priority),
      label: PRIORITY_LABELS[task.priority] ?? String(task.priority),
      color: null,
      type: null,
    };
  }

  return {
    id: task.status ?? "none",
    label: task.status ?? "No status",
    color: task.statusColor,
    type: task.statusType,
  };
}

const DUE_LABELS: Record<string, string> = {
  overdue: "Overdue",
  today: "Today",
  soon: "This week",
  later: "Later",
  none: "No due date",
};
