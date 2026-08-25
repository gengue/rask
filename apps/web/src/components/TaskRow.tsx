import { isPlaceholder } from "@rask/clickup-client/vocabulary";
import { type JSX, Show } from "solid-js";
import type { Task } from "../lib/api.ts";
import { DUE_TONE, formatDue } from "../lib/format.ts";
import { AvatarStack } from "./Avatar.tsx";
import { MarkRead, UnreadDot } from "./InboxMarks.tsx";
import { PriorityIcon, StatusIcon } from "./StatusIcon.tsx";

/**
 * One task, one line, 36px tall.
 *
 * Everything on the row is glanceable and nothing wraps: an overflowing title
 * is truncated rather than pushing the due date and avatars out of alignment.
 * Vertical rhythm is the whole point of a list you scan a hundred rows of.
 *
 * As the row narrows it gives up columns rather than squeezing all of them,
 * and the title is the last thing to give up space — it is the only column
 * that says which task this is. The order, widest and least load-bearing
 * first:
 *
 *  1. Tags, below --container-row-full. They are the only column whose width
 *     is unbounded by anything (two chips of arbitrary label, 0-130px), the
 *     only one already reachable another way — the tag facet in the header
 *     filters by exactly this — and the only one that answers no question you
 *     ask while scanning. What, when, who and what state are the other four.
 *  2. The list name, below --container-row-tight. It only appears in
 *     cross-list views at all, and where it appears "group by list" is one
 *     keystroke away and puts the same information in the group header
 *     instead, once per group rather than once per row.
 *  3. The custom id would be next, at about 550px: it is a copy target rather
 *     than a scan target, read on the way to pasting it into a branch name,
 *     and by then the task is open. Not implemented, because 550px of row is
 *     a window narrower than any this app claims to support.
 *
 * Priority, status, due and avatars never shed. They are 152px between them,
 * and they are the four questions a list gets scanned to answer.
 *
 * The queries are against the list's container rather than the viewport
 * because the row narrows for two unrelated reasons: the window shrinks, or
 * the detail panel opens beside it. At 1440 with a task open the row is 764px
 * and has to shed, and no media query can tell.
 */
export function TaskRow(props: {
  task: Task;
  active: boolean;
  selected: boolean;
  /** Cross-list views show which list a row came from; a list view does not. */
  showList: boolean;
  onOpen: () => void;
  onStatusClick: (event: MouseEvent) => void;
}): JSX.Element {
  const due = () => formatDue(props.task.dueDate);
  const pending = () => isPlaceholder(props.task.id);

  return (
    // Rows stay out of the tab order on purpose. The listbox holds focus and
    // points at the current row with aria-activedescendant, which is the ARIA
    // pattern for a keyboard-driven list and keeps 500 rows from becoming 500
    // tab stops. Key handling lives in the app shell for the same reason.
    // biome-ignore lint/a11y/useFocusableInteractive: listbox owns focus
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys handled in the shell
    <div
      id={`task-${props.task.id}`}
      role="option"
      aria-selected={props.selected}
      onClick={props.onOpen}
      class="group relative flex h-9 cursor-default items-center gap-3 border-line/45 border-b pr-5 pl-5 transition-colors duration-75"
      classList={{
        "row-selected": props.active,
        "hover:bg-hover": !props.active,
        // A task that has not reached ClickUp yet is dimmed, not hidden.
        "opacity-55": pending(),
      }}
    >
      {/* A hairline on the left edge marks the cursor without moving anything. */}
      <span
        class="absolute top-0 bottom-0 left-0 w-[2px] bg-accent transition-opacity"
        classList={{ "opacity-100": props.active, "opacity-0": !props.active }}
      />

      <UnreadDot task={props.task} />

      <PriorityIcon priority={props.task.priority} class="shrink-0" />

      <Show when={props.task.customId}>
        {/* The one string a developer copies out of here, into a branch name
            or a commit message, so it opts back in to text selection. */}
        <span class="selectable w-[62px] shrink-0 truncate font-mono text-xs text-ink-3 tabular-nums">
          {props.task.customId}
        </span>
      </Show>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          props.onStatusClick(event);
        }}
        class="-m-1 shrink-0 rounded-[5px] p-1 hover:bg-hover"
        title={props.task.status ?? "No status"}
      >
        <StatusIcon type={props.task.statusType} color={props.task.statusColor} />
      </button>

      <Show when={props.task.parentId}>
        {/* A subtask is otherwise indistinguishable from a top-level task. */}
        <span class="-ml-1.5 shrink-0 text-xs text-ink-4" title="Subtask">
          &#8618;
        </span>
      </Show>

      {/* The title is already the brightest ink in the row; the active row used
          to nudge it to pure white, a difference of one step on a 4-step ladder
          that nobody could see and that turns invisible on a light background. */}
      <span class="flex-1 truncate text-base text-ink">{props.task.name}</span>

      <Show when={props.showList && props.task.listName}>
        {/* My Tasks spans 243 lists. Without this a row gives no clue which
            project it belongs to, and grouping by status does not help. */}
        <span class="max-w-[120px] shrink-0 truncate text-xs text-ink-3 @max-row-tight:hidden">
          {props.task.listName}
        </span>
      </Show>

      <Show when={props.task.tags.length > 0}>
        <div class="flex shrink-0 items-center gap-1 @max-row-full:hidden">
          {props.task.tags.slice(0, 2).map((tag) => {
            /*
             * The tag colour paints the border and a wash behind it; the label
             * is a theme ink.
             *
             * It used to be the label. That put the legibility of an 11px word
             * in the hands of whoever picked the colour in ClickUp — a dark
             * tag was invisible on the dark theme, and a pale one would be
             * invisible on the light theme. The chip is still recognisably the
             * tag's colour, and the word is still readable, which is the part
             * we can actually be responsible for.
             */
            const tint = tag.bg ?? "var(--color-line-strong)";
            return (
              <span
                class="rounded-[4px] border px-1.5 py-px text-ink-2 text-xs leading-4"
                style={{
                  "border-color": `color-mix(in srgb, ${tint} 45%, transparent)`,
                  background: `color-mix(in srgb, ${tint} 14%, transparent)`,
                }}
              >
                {tag.name}
              </span>
            );
          })}
        </div>
      </Show>

      <Show when={due()}>
        {(label) => (
          <span class={`w-[72px] shrink-0 text-right text-xs ${DUE_TONE[label().tone]}`}>
            {label().text}
          </span>
        )}
      </Show>

      <div class="shrink-0">
        <AvatarStack users={props.task.assignees} />
      </div>

      <MarkRead task={props.task} />
    </div>
  );
}
