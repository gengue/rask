import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { Task } from "../lib/api.ts";
import { setUi, ui } from "../lib/ui.ts";
import { flatItems, viewListId, viewLoading } from "../lib/view.ts";
import { sameRange, visibleRange } from "../lib/windowing.ts";
import { StatusIcon } from "./StatusIcon.tsx";
import { TaskRow } from "./TaskRow.tsx";

const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 34;
/* Not `windowing.ts`'s `OVERSCAN`, which is 4 and is what the board takes.
   Rows are half a card's height, so the list buys the same pixels of runway
   with twice the count. Named apart because a local `OVERSCAN` shadowing an
   exported `OVERSCAN` with a different value is a trap, not a default. */
const ROW_OVERSCAN = 8;

/**
 * The list, windowed by hand.
 *
 * ponytail: this replaces @tanstack/solid-virtual. Its Solid adapter resolves
 * the scroll element while the component body runs, before any ref exists, and
 * on the path where a sibling panel mounts first it binds to a 0x0 rect and
 * never re-measures, so the list renders nothing. Every row here is a known
 * fixed height, which makes the offsets a prefix sum and the visible range a
 * binary search. Thirty lines, no dependency, and no measurement to get wrong.
 *
 * Bring a virtualizer back the day rows need to be measured rather than
 * assumed, e.g. inline expansion or wrapped titles.
 */
export function TaskList(props: {
  onOpen: (task: Task) => void;
  onStatusClick: (task: Task, event: MouseEvent) => void;
  openTaskId: string | null;
}): JSX.Element {
  const [scroller, setScroller] = createSignal<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);

  const items = flatItems;

  /** Cumulative pixel offset of every item, plus the total at the end. */
  const offsets = createMemo(() => {
    const list = items();
    const result = new Float64Array(list.length + 1);
    for (let i = 0; i < list.length; i++) {
      result[i + 1] = (result[i] ?? 0) + (list[i]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT);
    }
    return result;
  });

  const totalHeight = () => offsets()[items().length] ?? 0;

  /** The row the keyboard cursor is on, announced via aria-activedescendant. */
  const activeId = () => {
    const index = rowIndices()[ui.cursor];
    const item = index === undefined ? null : items()[index];
    return item?.kind === "row" ? `task-${item.task.id}` : undefined;
  };

  // Same windowing the board uses. It was written twice, identically, once per
  // branch; one copy is enough and a scroll bug found here is then fixed there.
  const range = createMemo(
    () => visibleRange(offsets(), scrollTop(), viewport() || 800, ROW_OVERSCAN),
    undefined,
    // Why the comparator: see `sameRange`. Without it every scroll event
    // rebuilds the whole window, whether or not it moved.
    { equals: sameRange },
  );

  /** Indices that j/k can land on. Headers are skipped. */
  const rowIndices = createMemo(() =>
    items().reduce<number[]>((acc, item, index) => {
      if (item.kind === "row") acc.push(index);
      return acc;
    }, []),
  );

  createEffect(() => {
    const element = scroller();
    if (!element) return;
    setViewport(element.clientHeight);
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  // Keep the cursor in range when filtering shrinks the list under it.
  createEffect(() => {
    const max = rowIndices().length - 1;
    if (ui.cursor > max) setUi("cursor", Math.max(0, max));
  });

  // Follow the keyboard cursor, but only when it would otherwise be off-screen,
  // so paging through visible rows does not jerk the viewport.
  createEffect(() => {
    const index = rowIndices()[ui.cursor];
    const element = scroller();
    if (index === undefined || !element) return;

    const tops = offsets();
    const top = tops[index] ?? 0;
    const bottom = tops[index + 1] ?? top + ROW_HEIGHT;
    const height = element.clientHeight;

    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + height) element.scrollTop = bottom - height;
  });

  return (
    <div
      ref={setScroller}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      /* The size query context for TaskRow. It goes on the scroller rather
         than on the column above it because `container-type: inline-size`
         also makes the element a containing block for `position: fixed`
         descendants, and the header up there renders the filter and grouping
         menus, which are fixed and positioned in viewport coordinates. The
         queried size is the scroller's content box, so it is the width a row
         actually gets — scrollbar already subtracted. */
      class="@container relative flex-1 overflow-y-auto overflow-x-hidden"
    >
      <Show
        when={items().length > 0}
        fallback={
          <Show when={!viewLoading()} fallback={<SkeletonRows />}>
            <div class="flex h-full flex-col items-center justify-center gap-1 text-ink-3">
              <div class="text-base">{ui.search ? "No matches" : "Nothing here"}</div>
              <div class="text-ink-3 text-xs">
                {ui.search ? "Try a different search" : "Press c to create a task"}
              </div>
            </div>
          </Show>
        }
      >
        {/* biome-ignore lint/a11y/useAriaActivedescendantWithTabindex: the rule
            looks for React's `tabIndex`; Solid uses the DOM attribute name. */}
        <div
          role="listbox"
          aria-label="Tasks"
          tabindex="0"
          aria-activedescendant={activeId()}
          class="relative w-full outline-none"
          style={{ height: `${totalHeight()}px` }}
        >
          {renderWindow()}
        </div>
      </Show>
    </div>
  );

  function renderWindow(): JSX.Element {
    const { start, end } = range();
    const list = items();
    const tops = offsets();
    const nodes: JSX.Element[] = [];

    for (let index = start; index < end; index++) {
      const item = list[index];
      if (!item) continue;

      /*
       * A plain branch rather than two nested `<Show>`.
       *
       * `kind` is a field of a `FlatItem` that is built once and never edited,
       * so there is no reactivity for a `Show` to serve: when an item becomes
       * the other kind it is a different object at a different index and this
       * loop has already re-run. What the two cost is two components and two
       * memos per item per rebuild, to decide a ternary. Every prop below is
       * still a getter, so a row keeps tracking the cursor on its own.
       */
      nodes.push(
        <div
          class="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${tops[index] ?? 0}px)` }}
        >
          {item.kind === "row" ? (
            <TaskRow
              task={item.task}
              showList={viewListId() === null}
              active={rowIndices()[ui.cursor] === index}
              selected={props.openTaskId === item.task.id}
              onOpen={() => {
                setUi("cursor", rowIndices().indexOf(index));
                props.onOpen(item.task);
              }}
              onStatusClick={(event) => props.onStatusClick(item.task, event)}
            />
          ) : (
            <div class="flex h-[34px] items-center gap-2 border-line/45 border-b bg-wash px-5">
              <Show when={ui.groupBy === "status"}>
                <StatusIcon type={item.statusType} color={item.color} size={13} />
              </Show>
              <span class="font-medium text-sm text-ink capitalize tracking-[-0.005em]">
                {item.label}
              </span>
              <span class="rounded bg-chip px-1.5 text-xs text-ink-3 tabular-nums">
                {item.count}
              </span>
            </div>
          )}
        </div>,
      );
    }

    return nodes;
  }
}

/**
 * Placeholder rows at the real row height.
 *
 * The point is that nothing moves when the data lands: same 36px rhythm, same
 * columns. A spinner would be less work and would make every list load feel
 * like a page transition.
 */
function SkeletonRows(): JSX.Element {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 14 }, (_, i) => (
        <div class="flex h-9 items-center gap-3 border-line/45 border-b px-5">
          <span class="size-3.5 shrink-0 rounded-full bg-chip" />
          <span class="h-2 w-[52px] shrink-0 rounded bg-wash" />
          <span class="h-2 rounded bg-wash" style={{ width: `${28 + ((i * 37) % 42)}%` }} />
        </div>
      ))}
    </div>
  );
}
