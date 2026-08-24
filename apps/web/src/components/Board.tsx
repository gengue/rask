import { createEffect, createMemo, createSignal, Index, type JSX, onCleanup, Show } from "solid-js";
import type { Task } from "../lib/api.ts";
import {
  type BoardColumn,
  boardColumns,
  boardWritable,
  CARD_GAP,
  cardOffsets,
  draggingId,
  moveToColumn,
} from "../lib/board.ts";
import { tasks } from "../lib/store.ts";
import { setUi, ui } from "../lib/ui.ts";
import { viewLoading } from "../lib/view.ts";
import { sameRange, visibleRange } from "../lib/windowing.ts";
import { BoardCard } from "./BoardCard.tsx";
import { StatusIcon } from "./StatusIcon.tsx";

const COLUMN_WIDTH = 272;

/**
 * The board: the same grouping the list uses, turned on its side.
 *
 * It renders from `flatItems` and writes through `tasks.update`, so it adds no
 * fetch, no collection and no second way to change a task. What it adds is a
 * second reading of one number: `ui.cursor` is an index into the flat row list
 * in both layouts, and here that index is read as a column plus a depth.
 *
 * Every column is its own scroller and windows itself. One column in the Bugs
 * list holds over a thousand cards; see `visibleRange` for the measurement.
 */
export function Board(props: {
  onOpen: (task: Task) => void;
  onStatusClick: (task: Task, event: MouseEvent) => void;
  openTaskId: string | null;
}): JSX.Element {
  /*
   * A status nobody is in has no tasks, so grouping cannot know it exists. The
   * list definition can, and it is also what puts the columns in the
   * workspace's own order rather than alphabetically. It is read once per list
   * in `lib/view.ts` — the filter menu needs the same set, and two components
   * fetching the same four rows was one fetch too many.
   */
  return (
    <div class="flex flex-1 gap-2.5 overflow-x-auto overflow-y-hidden px-4 pt-3 pb-4">
      <Show
        when={boardColumns().length > 0}
        fallback={
          <Show when={!viewLoading()} fallback={<SkeletonColumns />}>
            <div class="flex flex-1 flex-col items-center justify-center gap-1 text-ink-3">
              <div class="text-base">{ui.search ? "No matches" : "Nothing here"}</div>
              <div class="text-ink-3 text-xs">
                {ui.search ? "Try a different search" : "Press c to create a task"}
              </div>
            </div>
          </Show>
        }
      >
        {/* Index rather than For: `toColumns` builds fresh objects on every
            keystroke that touches the filter, and For keys on identity, so the
            whole board would be torn down and rebuilt — losing every column's
            scroll position — for a change of one card. The column count is
            stable; its contents are what move. */}
        <Index each={boardColumns()}>
          {(column) => (
            <Column
              column={column()}
              openTaskId={props.openTaskId}
              onOpen={props.onOpen}
              onStatusClick={props.onStatusClick}
            />
          )}
        </Index>
      </Show>
    </div>
  );
}

function Column(props: {
  column: BoardColumn;
  openTaskId: string | null;
  onOpen: (task: Task) => void;
  onStatusClick: (task: Task, event: MouseEvent) => void;
}): JSX.Element {
  const [scroller, setScroller] = createSignal<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  const [over, setOver] = createSignal(false);

  const offsets = createMemo(() => cardOffsets(props.column.tasks));
  const height = () => offsets()[props.column.tasks.length] ?? 0;
  // Why the comparator: see `sameRange`. Without it every scroll event rebuilds
  // the column, whether or not it moved — and a rebuild mid-drag detaches the
  // card being dragged.
  const range = createMemo(
    () => visibleRange(offsets(), scrollTop(), viewport() || 800),
    undefined,
    {
      equals: sameRange,
    },
  );

  /** The cards inside the window. `<Index>` below diffs this per position. */
  const windowTasks = createMemo(() => {
    const { start, end } = range();
    return props.column.tasks.slice(start, end);
  });

  /** Where the cursor is inside this column, or -1 when it is elsewhere. */
  const cursor = () => {
    const index = ui.cursor - props.column.offset;
    return index >= 0 && index < props.column.tasks.length ? index : -1;
  };

  const droppable = () => boardWritable() && props.column.status !== null && draggingId() !== null;

  createEffect(() => {
    const element = scroller();
    if (!element) return;
    setViewport(element.clientHeight);
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  // Follow the cursor, vertically inside this column and horizontally across
  // the board, but only when it would otherwise be off-screen.
  createEffect(() => {
    const index = cursor();
    const element = scroller();
    if (index < 0 || !element) return;

    element.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const top = offsets()[index] ?? 0;
    const bottom = offsets()[index + 1] ?? top;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  });

  return (
    <section
      class="flex h-full shrink-0 flex-col"
      style={{ width: `${COLUMN_WIDTH}px` }}
      aria-label={props.column.label}
    >
      <header class="flex h-7 shrink-0 items-center gap-2 px-2">
        <Show when={ui.groupBy === "status"}>
          <StatusIcon type={props.column.statusType} color={props.column.color} size={13} />
        </Show>
        <span class="truncate font-medium text-ink text-sm capitalize tracking-[-0.005em]">
          {props.column.label}
        </span>
        <span class="rounded bg-chip px-1.5 text-ink-3 text-xs tabular-nums">
          {props.column.tasks.length}
        </span>
      </header>

      {/* biome-ignore lint/a11y/useAriaActivedescendantWithTabindex: the rule
          looks for React's `tabIndex`; Solid uses the DOM attribute name. */}
      <div
        ref={setScroller}
        role="listbox"
        tabindex="0"
        aria-label={props.column.label}
        aria-activedescendant={
          cursor() >= 0 ? `task-${props.column.tasks[cursor()]?.id}` : undefined
        }
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onDragOver={(event) => {
          if (!droppable()) return;
          // Without this the browser refuses the drop, silently.
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          setOver(true);
        }}
        onDragLeave={(event) => {
          // dragleave also fires crossing into a child, so check we really left.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const id = event.dataTransfer?.getData("text/plain");
          const task = id ? tasks.get(id) : undefined;
          if (task) moveToColumn(task, props.column);
        }}
        class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-[8px] border border-transparent bg-wash p-1.5 outline-none transition-colors"
        classList={{
          "border-accent bg-accent-soft": over() && droppable(),
          // Everything that can take the card being dragged says so at once, so
          // the target is visible before the pointer gets there.
          "border-line": !over() && droppable(),
        }}
      >
        <div class="relative w-full" style={{ height: `${height()}px` }}>
          {/*
           * `<Index>` for the same reason the column list above uses it, one
           * level down: the imperative loop this replaces rebuilt every card
           * in the window whenever any task in the loaded set changed, which
           * also detached a card mid-drag. Column task references are stable
           * for unchanged tasks, so only the card that changed re-renders.
           */}
          <Index each={windowTasks()}>
            {(task, offset) => {
              const index = () => range().start + offset;
              return (
                <div
                  class="absolute inset-x-0"
                  style={{
                    transform: `translateY(${offsets()[index()] ?? 0}px)`,
                    "padding-bottom": `${CARD_GAP}px`,
                  }}
                >
                  <BoardCard
                    task={task()}
                    active={ui.cursor === props.column.offset + index()}
                    selected={props.openTaskId === task().id}
                    draggable={boardWritable()}
                    onOpen={() => {
                      setUi("cursor", props.column.offset + index());
                      props.onOpen(task());
                    }}
                    onStatusClick={(event) => props.onStatusClick(task(), event)}
                  />
                </div>
              );
            }}
          </Index>
        </div>

        <Show when={props.column.tasks.length === 0}>
          <div class="flex h-16 items-center justify-center text-ink-4 text-xs">
            {droppable() ? "Drop here" : "Empty"}
          </div>
        </Show>
      </div>
    </section>
  );

}

/**
 * Three columns of placeholder cards, at the real card height.
 *
 * Same reason the list has skeleton rows: a list view opened straight into the
 * board would otherwise say "Nothing here" for as long as the fetch takes, on a
 * list with four hundred tasks in it.
 */
function SkeletonColumns(): JSX.Element {
  return (
    <div class="flex gap-2.5" aria-hidden="true">
      {[0, 1, 2].map((column) => (
        <div class="flex flex-col gap-2" style={{ width: `${COLUMN_WIDTH}px` }}>
          <div class="flex h-7 items-center gap-2 px-2">
            <span class="size-3.5 rounded-full bg-chip" />
            <span class="h-2 w-20 rounded bg-wash" />
          </div>
          {Array.from({ length: 5 }, (_, card) => (
            <div class="h-[70px] rounded-[7px] border border-line bg-elevated px-2.5 py-2">
              <span
                class="block h-2 rounded bg-wash"
                style={{ width: `${52 + ((column * 3 + card * 11) % 40)}%` }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
