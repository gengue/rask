import { createEffect, createMemo, createSignal, Index, type JSX, onCleanup, Show } from "solid-js";
import type { Task } from "../lib/api.ts";
import { reasonFor } from "../lib/inbox.ts";
import { setUi, toggleGroup, ui } from "../lib/ui.ts";
import { flatItems, listColumns, viewIsFeed, viewListId, viewLoading } from "../lib/view.ts";
import { sameRange, visibleRange } from "../lib/windowing.ts";
import { InboxRow } from "./InboxRow.tsx";
import { Chevron } from "./Sidebar.tsx";
import { StatusIcon } from "./StatusIcon.tsx";
import { TaskRow } from "./TaskRow.tsx";
import { SlowLoad } from "./Unresolved.tsx";

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

  const emptyTitle = () => {
    if (ui.search) return "No matches";
    return viewIsFeed() ? "You are caught up" : "Nothing here";
  };
  const emptyHint = () => {
    if (ui.search) return "Try a different search";
    return viewIsFeed() ? "Changes to your tasks land here" : "Press c to create a task";
  };

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
              {/* An empty feed is an achievement, not a gap to fill, and "press
                  c to create a task" is advice for the wrong page entirely. */}
              <div class="text-md">{emptyTitle()}</div>
              <div class="text-ink-3 text-xs">{emptyHint()}</div>
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
          {/*
           * `<Index>` rather than an imperative loop. The loop built fresh DOM
           * for every item on every re-run, and Solid's array reconciler keys
           * on node identity, so one task changing anywhere in the loaded set
           * tore down and recreated every visible row — avatars re-decoded,
           * :hover dropped, text selection died. Index gives each position a
           * signal instead: a data change re-renders only the positions whose
           * item actually changed (see `reuseItems`), and a scroll shifts
           * content through existing nodes instead of replacing them.
           *
           * The `<Show>` decides row-versus-header per position. Non-keyed, so
           * it only rebuilds when a position changes kind — which regrouping
           * can do — and an unchanged branch updates through prop getters.
           */}
          <Index each={items().slice(range().start, range().end)}>
            {(item, offset) => {
              const index = () => range().start + offset;
              const row = () => {
                const value = item();
                return value.kind === "row" ? value : null;
              };
              const header = () => {
                const value = item();
                return value.kind === "header" ? value : null;
              };
              return (
                <div
                  class="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${offsets()[index()] ?? 0}px)` }}
                >
                  <Show
                    when={row()}
                    fallback={
                      <button
                        type="button"
                        aria-expanded={!header()?.collapsed}
                        onClick={() => {
                          const value = header();
                          if (value) toggleGroup(value.groupId);
                        }}
                        class="flex h-[34px] w-full items-center gap-2 border-line/45 border-b bg-wash px-5 text-left"
                      >
                        <span class="-ml-1 text-ink-3">
                          <Chevron open={!header()?.collapsed} />
                        </span>
                        <Show when={ui.groupBy === "status"}>
                          <StatusIcon
                            type={header()?.statusType ?? null}
                            color={header()?.color ?? null}
                            size={13}
                          />
                        </Show>
                        <span class="font-medium text-sm text-ink capitalize tracking-[-0.005em]">
                          {header()?.label}
                        </span>
                        <span class="rounded bg-chip px-1.5 text-xs text-ink-3 tabular-nums">
                          {header()?.count}
                        </span>
                      </button>
                    }
                  >
                    {(current) => {
                      /*
                       * Two row shapes, chosen per row rather than per view.
                       *
                       * A feed holds both: a task nobody said anything about is
                       * still a task row, and swapping the whole list to the
                       * comment shape would leave those rows with an empty
                       * sentence where their status used to be.
                       */
                      const said = () => (viewIsFeed() ? reasonFor(current().task.id) : undefined);
                      const open = () => {
                        setUi("cursor", rowIndices().indexOf(index()));
                        props.onOpen(current().task);
                      };

                      return (
                        <Show
                          when={said()}
                          fallback={
                            <TaskRow
                              task={current().task}
                              showList={viewListId() === null}
                              columns={listColumns()}
                              active={rowIndices()[ui.cursor] === index()}
                              selected={props.openTaskId === current().task.id}
                              onOpen={open}
                              onStatusClick={(event) => props.onStatusClick(current().task, event)}
                            />
                          }
                        >
                          {(reason) => (
                            <InboxRow
                              task={current().task}
                              reason={reason()}
                              active={rowIndices()[ui.cursor] === index()}
                              selected={props.openTaskId === current().task.id}
                              onOpen={open}
                            />
                          )}
                        </Show>
                      );
                    }}
                  </Show>
                </div>
              );
            }}
          </Index>
        </div>
      </Show>
    </div>
  );
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
    <div>
      <SlowLoad />
      {Array.from({ length: 14 }, (_, i) => (
        <div aria-hidden="true" class="flex h-9 items-center gap-3 border-line/45 border-b px-5">
          <span class="size-3.5 shrink-0 rounded-full bg-chip" />
          <span class="h-2 w-[52px] shrink-0 rounded bg-wash" />
          <span class="h-2 rounded bg-wash" style={{ width: `${28 + ((i * 37) % 42)}%` }} />
        </div>
      ))}
    </div>
  );
}
