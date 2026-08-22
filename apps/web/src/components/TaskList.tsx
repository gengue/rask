import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { Task } from "../lib/api.ts";
import { setUi, ui } from "../lib/ui.ts";
import { flatItems } from "../lib/view.ts";
import { StatusIcon } from "./StatusIcon.tsx";
import { TaskRow } from "./TaskRow.tsx";

const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 34;
const OVERSCAN = 8;

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

  const range = createMemo(() => {
    const tops = offsets();
    const count = items().length;
    if (count === 0) return { start: 0, end: 0 };
    const top = scrollTop();
    const bottom = top + (viewport() || 800);
    const start = Math.max(0, indexAt(tops, top, count) - OVERSCAN);
    const end = Math.min(count, indexAt(tops, bottom, count) + 1 + OVERSCAN);
    return { start, end };
  });

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
      class="relative flex-1 overflow-y-auto overflow-x-hidden"
    >
      <Show
        when={items().length > 0}
        fallback={
          <div class="flex h-full flex-col items-center justify-center gap-1 text-ink-3">
            <div class="text-[13px]">{ui.search ? "No matches" : "Nothing here"}</div>
            <div class="text-ink-4 text-xs">
              {ui.search ? "Try a different search" : "Press c to create a task"}
            </div>
          </div>
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

      nodes.push(
        <div
          class="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${tops[index] ?? 0}px)` }}
        >
          <Show
            when={item.kind === "row" ? item : null}
            fallback={
              <Show when={item.kind === "header" ? item : null}>
                {(header) => (
                  <div class="flex h-[34px] items-center gap-2 border-line/45 border-b bg-white/[0.018] px-5">
                    <Show when={ui.groupBy === "status"}>
                      <StatusIcon type={header().statusType} color={header().color} size={13} />
                    </Show>
                    <span class="font-medium text-[12.5px] text-ink capitalize tracking-[-0.005em]">
                      {header().label}
                    </span>
                    <span class="rounded bg-white/[0.06] px-1.5 text-[11px] text-ink-3 tabular-nums">
                      {header().count}
                    </span>
                  </div>
                )}
              </Show>
            }
          >
            {(row) => (
              <TaskRow
                task={row().task}
                active={rowIndices()[ui.cursor] === index}
                selected={props.openTaskId === row().task.id}
                onOpen={() => {
                  setUi("cursor", rowIndices().indexOf(index));
                  props.onOpen(row().task);
                }}
                onStatusClick={(event) => props.onStatusClick(row().task, event)}
              />
            )}
          </Show>
        </div>,
      );
    }

    return nodes;
  }
}

/** Largest index whose offset is <= `pixel`. Offsets ascend, so binary search. */
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
