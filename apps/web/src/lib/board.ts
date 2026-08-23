import { createMemo, createSignal } from "solid-js";
import type { StatusDef, Task } from "./api.ts";
import type { FlatItem } from "./grouping.ts";
import { tasks } from "./store.ts";
import { type GroupBy, setUi, ui } from "./ui.ts";
import { flatItems, rowTasks, viewListId } from "./view.ts";

/**
 * The board, as data.
 *
 * Everything here is a pure function of what the list view already computed —
 * `flatItems` is the same grouped, filtered, flattened array the row list
 * renders, and a column is one run of it. That is why the board does not care
 * which of the four groupings is on, and why switching layout keeps the cursor
 * on the same task: both layouts index the same flat row list.
 *
 * The one thing grouping cannot give it is a status the list has and nobody is
 * in yet. Those columns come from the list definition, which is also what puts
 * them in ClickUp's order. Grouping orders by first appearance, which is fine
 * for headers you scroll past and wrong for columns: it makes "done" the first
 * one whenever the oldest task happens to be finished.
 */

export interface BoardColumn {
  id: string;
  label: string;
  color: string | null;
  statusType: string | null;
  /**
   * The status a card dropped here takes. Null when the column is not a
   * writable status: any grouping other than by status, and the "No status"
   * group, which nothing can be moved back into.
   */
  status: StatusDef | null;
  tasks: Task[];
  /**
   * Index of this column's first card in the flat row list `ui.cursor` walks.
   * Zero for a column with no cards, which the cursor can never be inside.
   */
  offset: number;
}

/** The current list's statuses, or empty in a view that spans several lists. */
export const [boardStatuses, setBoardStatuses] = createSignal<StatusDef[]>([]);

/** The card being dragged, so every column can dim and light up as it passes. */
export const [draggingId, setDraggingId] = createSignal<string | null>(null);

export const boardColumns = createMemo(() => toColumns(flatItems(), ui.groupBy, boardStatuses()));

/**
 * Whether a card can be moved between columns at all.
 *
 * Two conditions. The grouping has to be by status, because that is the only
 * column identity this app knows how to write. And the view has to be a single
 * list: My Tasks spans 243 lists with 243 status sets, so a column labelled
 * "in review" is only guaranteed to exist for the task under the pointer when
 * every card came from the same list. Elsewhere the board is read-only and `s`
 * is still how you change a status.
 */
export function boardWritable(): boolean {
  return ui.groupBy === "status" && viewListId() !== null;
}

export function toColumns(
  items: FlatItem[],
  groupBy: GroupBy,
  statuses: StatusDef[],
): BoardColumn[] {
  const columns: BoardColumn[] = [];
  let row = 0;

  for (const item of items) {
    if (item.kind === "header") {
      columns.push({
        id: item.id,
        label: item.label,
        color: item.color,
        statusType: item.statusType,
        status: null,
        tasks: [],
        offset: row,
      });
      continue;
    }

    // "No grouping" produces no headers at all, so the whole view is one column.
    let column = columns[columns.length - 1];
    if (!column) {
      column = {
        id: "all",
        label: "All tasks",
        color: null,
        statusType: null,
        status: null,
        tasks: [],
        offset: 0,
      };
      columns.push(column);
    }
    column.tasks.push(item.task);
    row++;
  }

  return groupBy === "status" ? asStatusColumns(columns, statuses) : columns;
}

/**
 * Attaches a writable status to every column, adds the ones nobody is in, and
 * puts them all in ClickUp's order.
 *
 * The status name comes off the first task rather than off the group label,
 * because the label is display text and the name is what goes back to ClickUp.
 * A group whose tasks have no status at all is the "No status" column and stays
 * unwritable.
 */
function asStatusColumns(columns: BoardColumn[], statuses: StatusDef[]): BoardColumn[] {
  const defs = [...statuses].sort((a, b) => (a.orderindex ?? 0) - (b.orderindex ?? 0));
  const byName = new Map(defs.map((def) => [def.status.toLowerCase(), def]));

  const known = columns.map((column) => {
    const name = column.tasks[0]?.status;
    if (!name) return column;
    return {
      ...column,
      status: byName.get(name.toLowerCase()) ?? {
        status: name,
        color: column.color,
        type: column.statusType,
      },
    };
  });

  /*
   * A status with no cards is still a column. Without it there is no way to
   * drag the first card into "In review", and a board that hides its empty
   * columns also hides the shape of the workflow.
   */
  const filled = new Set(known.map((column) => column.status?.status.toLowerCase()));
  const empty = defs
    .filter((def) => !filled.has(def.status.toLowerCase()))
    .map(
      (def): BoardColumn => ({
        id: `header:${def.status}`,
        label: def.status,
        color: def.color ?? null,
        statusType: def.type ?? null,
        status: def,
        tasks: [],
        offset: 0,
      }),
    );

  const order = new Map(defs.map((def, index) => [def.status.toLowerCase(), index]));
  const rank = (column: BoardColumn) =>
    order.get(column.status?.status.toLowerCase() ?? "") ?? defs.length;

  // Stable, so with no status definitions at all — a cross-list view, or the
  // frame before they arrive — the columns keep the order grouping gave them.
  return [...known, ...empty].sort((a, b) => rank(a) - rank(b));
}

// --- the cursor ------------------------------------------------------------

const DIRECTIONS: Record<string, "up" | "down" | "left" | "right"> = {
  j: "down",
  ArrowDown: "down",
  k: "up",
  ArrowUp: "up",
  h: "left",
  ArrowLeft: "left",
  l: "right",
  ArrowRight: "right",
};

/**
 * Where `key` takes the cursor, or null when it takes it nowhere and the
 * keystroke belongs to the browser.
 *
 * `columns` is null in the list layout, where the rows are one flat run and
 * only up and down mean anything. On the board the same index is read as a
 * column plus an offset into it: j/k walk a column, h/l cross to the neighbour
 * at the same depth. Empty columns are skipped — there is nothing to land on.
 */
export function nextCursor(
  key: string,
  cursor: number,
  total: number,
  columns: BoardColumn[] | null,
): number | null {
  const direction = DIRECTIONS[key];
  if (!direction || total === 0) return null;
  const clamp = (index: number) => Math.max(0, Math.min(total - 1, index));

  if (!columns) {
    if (direction === "left" || direction === "right") return null;
    return clamp(direction === "down" ? cursor + 1 : cursor - 1);
  }

  const filled = columns.filter((column) => column.tasks.length > 0);
  const index = filled.findIndex(
    (column) => cursor >= column.offset && cursor < column.offset + column.tasks.length,
  );
  const current = filled[index];
  if (!current) return clamp(cursor);

  if (direction === "up" || direction === "down") {
    const row = cursor - current.offset + (direction === "down" ? 1 : -1);
    return current.offset + Math.max(0, Math.min(current.tasks.length - 1, row));
  }

  const target = filled[index + (direction === "right" ? 1 : -1)];
  if (!target) return null;
  return target.offset + Math.min(cursor - current.offset, target.tasks.length - 1);
}

// --- writing ---------------------------------------------------------------

/**
 * Moves a card to another column.
 *
 * The one write the board has, shared by the drop handler and the keyboard, and
 * it is `tasks.update` — the same optimistic path the status menu uses. The
 * collection applies it immediately, the API queues it for ClickUp, and if
 * ClickUp says no the collection rolls it back and the card returns to the
 * column it came from.
 */
export function moveToColumn(task: Task, column: BoardColumn): void {
  const status = column.status;
  if (!status || status.status === task.status) return;

  tasks.update(task.id, (draft) => {
    draft.status = status.status;
    draft.statusColor = status.color ?? null;
    draft.statusType = status.type ?? null;
  });
  follow(task.id);
}

/**
 * The keyboard's drag: the card under the cursor, one column over.
 *
 * Unlike h/l this counts empty columns, because moving a card into an empty
 * status is the whole reason those columns are drawn.
 */
export function shiftColumn(task: Task, delta: -1 | 1): void {
  const columns = boardColumns();
  const index = columns.findIndex((column) => column.tasks.some((row) => row.id === task.id));
  const target = index === -1 ? undefined : columns[index + delta];
  if (target) moveToColumn(task, target);
}

/**
 * Keeps the cursor on the card that just moved.
 *
 * Changing a status regroups the view under the cursor, so the index it holds
 * would otherwise be pointing at whichever card slid into that slot. Deferred
 * by a microtask because the regroup happens through the collection, the live
 * query and an effect before `rowTasks` is the new order.
 */
function follow(id: string): void {
  queueMicrotask(() => {
    const index = rowTasks().findIndex((task) => task.id === id);
    if (index >= 0) setUi("cursor", index);
  });
}

// --- geometry --------------------------------------------------------------

/**
 * How tall a card is, gap included.
 *
 * Known rather than measured, which is what lets a column window by hand the
 * way the row list does. Two heights, not one: the tag row is the only part of
 * a card that is either there or not, and reserving it everywhere would put
 * 22px of nothing under every task without a tag. The title does not vary — it
 * is clamped at two lines rather than wrapped, so a long one truncates instead
 * of pushing the card taller.
 */
export const CARD_GAP = 8;
const CARD_BASE = 78;
const CARD_TAGS = 22;

export function cardHeight(task: Task): number {
  return CARD_BASE + (task.tags.length > 0 ? CARD_TAGS : 0) + CARD_GAP;
}

/** Cumulative top of every card in a column, plus the column total at the end. */
export function cardOffsets(list: Task[]): Float64Array {
  const offsets = new Float64Array(list.length + 1);
  for (let index = 0; index < list.length; index++) {
    const task = list[index];
    offsets[index + 1] = (offsets[index] ?? 0) + (task ? cardHeight(task) : 0);
  }
  return offsets;
}

/**
 * The slice of a column worth rendering.
 *
 * A column here holds hundreds of cards and the Bugs list would put over a
 * thousand in one of them, so a column renders the window plus a few and
 * nothing else. Offsets ascend, so both ends are a binary search.
 *
 * Measured rather than assumed, on a seeded list of 1,000 tasks with 980 of
 * them in one status, in a 1414px window. Windowed: 38 cards in the DOM, 662
 * elements under <main>, 26ms to switch into the board and 4.6ms median per
 * scroll step. The same board with this function returning the whole column:
 * 1,000 cards, 14,773 elements, 4,289ms — a layout switch that drops four
 * seconds of frames. The cap on a view is 500 rows today, which only moves
 * that number to about two seconds.
 *
 * Capping instead — "+980 more" under the first fifty — was the alternative.
 * It is less code, and it would have made the count in the column header a
 * lie about what the column contains.
 */
export function visibleRange(
  offsets: Float64Array,
  scrollTop: number,
  height: number,
  overscan = 4,
): { start: number; end: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, indexAt(offsets, scrollTop, count) - overscan);
  const end = Math.min(count, indexAt(offsets, scrollTop + height, count) + 1 + overscan);
  return { start, end };
}

/** Largest index whose offset is <= `pixel`. */
function indexAt(offsets: Float64Array, pixel: number, count: number): number {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((offsets[mid] ?? 0) <= pixel) low = mid;
    else high = mid - 1;
  }
  return low;
}
