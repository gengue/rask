import { type JSX, Show } from "solid-js";
import type { Task } from "../lib/api.ts";
import { formatDue } from "../lib/format.ts";
import { AvatarStack } from "./Avatar.tsx";
import { PriorityIcon, StatusIcon } from "./StatusIcon.tsx";

const DUE_TONE: Record<string, string> = {
  overdue: "text-urgent",
  today: "text-high",
  soon: "text-ink-2",
  normal: "text-ink-3",
};

/**
 * One task, one line, 36px tall.
 *
 * Everything on the row is glanceable and nothing wraps: an overflowing title
 * is truncated rather than pushing the due date and avatars out of alignment.
 * Vertical rhythm is the whole point of a list you scan a hundred rows of.
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
  const pending = () => props.task.id.startsWith("tmp_");

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
        "bg-white/[0.05]": props.active,
        "hover:bg-white/[0.025]": !props.active,
        // A task that has not reached ClickUp yet is dimmed, not hidden.
        "opacity-55": pending(),
      }}
    >
      {/* A hairline on the left edge marks the cursor without moving anything. */}
      <span
        class="absolute top-0 bottom-0 left-0 w-[2px] bg-accent transition-opacity"
        classList={{ "opacity-100": props.active, "opacity-0": !props.active }}
      />

      <PriorityIcon priority={props.task.priority} class="shrink-0" />

      <Show when={props.task.customId}>
        {/* The one string a developer copies out of here, into a branch name
            or a commit message, so it opts back in to text selection. */}
        <span class="selectable w-[62px] shrink-0 truncate font-mono text-[11px] text-ink-3 tabular-nums">
          {props.task.customId}
        </span>
      </Show>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          props.onStatusClick(event);
        }}
        class="-m-1 shrink-0 rounded-[5px] p-1 hover:bg-white/10"
        title={props.task.status ?? "No status"}
      >
        <StatusIcon type={props.task.statusType} color={props.task.statusColor} />
      </button>

      <Show when={props.task.parentId}>
        {/* A subtask is otherwise indistinguishable from a top-level task. */}
        <span class="-ml-1.5 shrink-0 text-[11px] text-ink-4" title="Subtask">
          &#8618;
        </span>
      </Show>

      <span class="flex-1 truncate text-[13px] text-ink" classList={{ "text-white": props.active }}>
        {props.task.name}
      </span>

      <Show when={props.showList && props.task.listName}>
        {/* My Tasks spans 243 lists. Without this a row gives no clue which
            project it belongs to, and grouping by status does not help. */}
        <span class="max-w-[120px] shrink-0 truncate text-[11px] text-ink-3">
          {props.task.listName}
        </span>
      </Show>

      <Show when={props.task.tags.length > 0}>
        <div class="flex shrink-0 items-center gap-1">
          {props.task.tags.slice(0, 2).map((tag) => (
            <span
              class="rounded-[4px] border px-1.5 py-px text-[10px] leading-4"
              style={{
                "border-color": `${tag.bg ?? "#2a2c30"}55`,
                background: `${tag.bg ?? "#2a2c30"}1f`,
                color: tag.bg ?? "var(--color-ink-3)",
              }}
            >
              {tag.name}
            </span>
          ))}
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
    </div>
  );
}
