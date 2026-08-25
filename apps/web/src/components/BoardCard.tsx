import { isPlaceholder } from "@rask/clickup-client/vocabulary";
import { type JSX, Show } from "solid-js";
import type { Task } from "../lib/api.ts";
import { CARD_GAP, cardHeight, draggingId, setDraggingId } from "../lib/board.ts";
import { DUE_TONE, formatDue } from "../lib/format.ts";
import { ui } from "../lib/ui.ts";
import { AvatarStack } from "./Avatar.tsx";
import { PriorityIcon, StatusIcon } from "./StatusIcon.tsx";

/**
 * One task, as a card.
 *
 * The row earned its five columns by being scanned a hundred at a time; a card
 * is read one at a time, in a 264px column, so the same five facts are stacked
 * instead of aligned. What it carries is what the row carries, minus status:
 * on a board grouped by status the column is the status, and a glyph repeating
 * it on every card is 500 pixels saying nothing. Group by due date or assignee
 * and it comes back, because then the column no longer answers it.
 *
 * The list name is the one thing the row has that the card does not. The row
 * gives it up below 690px for a reason that only gets stronger at 264: "group
 * by list" is one keystroke away and puts the same fact in a column header,
 * once per column instead of once per card.
 *
 * The title is clamped at two lines rather than wrapped. That is what makes a
 * card's height knowable without measuring it, which is what lets a column with
 * a thousand cards in it window by hand — see `cardHeight`.
 */
export function BoardCard(props: {
  task: Task;
  active: boolean;
  selected: boolean;
  /** False in a view that cannot write status. See `boardWritable`. */
  draggable: boolean;
  onOpen: () => void;
  onStatusClick: (event: MouseEvent) => void;
}): JSX.Element {
  const due = () => formatDue(props.task.dueDate);
  const pending = () => isPlaceholder(props.task.id);

  return (
    // Same reasoning as the row: the column is the listbox and holds focus,
    // cards are options pointed at by aria-activedescendant, and every key is
    // handled by the one listener in the shell.
    // biome-ignore lint/a11y/useFocusableInteractive: the column owns focus
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys handled in the shell
    <div
      id={`task-${props.task.id}`}
      role="option"
      aria-selected={props.selected}
      onClick={props.onOpen}
      draggable={props.draggable && !pending()}
      onDragStart={(event) => {
        event.dataTransfer?.setData("text/plain", props.task.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        setDraggingId(props.task.id);
      }}
      onDragEnd={() => setDraggingId(null)}
      class="flex cursor-default flex-col rounded-[7px] border bg-elevated px-2.5 py-2 transition-colors duration-75"
      style={{ height: `${cardHeight(props.task) - CARD_GAP}px` }}
      classList={{
        "border-accent bg-accent-soft": props.active,
        "border-line hover:border-line-strong": !props.active,
        // A card mid-drag is still where it was; the ghost under the pointer is
        // the copy that moved.
        "opacity-40": draggingId() === props.task.id,
        // A task that has not reached ClickUp yet is dimmed, not hidden.
        "opacity-55": pending(),
      }}
    >
      <div class="line-clamp-2 h-9 text-base text-ink leading-[18px]">
        <Show when={props.task.parentId}>
          {/* A subtask is otherwise indistinguishable from a top-level task. */}
          <span class="mr-1 text-ink-4" title="Subtask">
            &#8618;
          </span>
        </Show>
        {props.task.name}
      </div>

      <Show when={props.task.tags.length > 0}>
        {/* Same chip as the row: the tag's colour on the border and behind it,
            the label in a theme ink, because the legibility of an 11px word
            cannot depend on which colour someone picked in ClickUp. */}
        <div class="mt-1 flex h-[18px] items-center gap-1 overflow-hidden">
          {props.task.tags.slice(0, 3).map((tag) => {
            const tint = tag.bg ?? "var(--color-line-strong)";
            return (
              <span
                class="shrink-0 rounded-[4px] border px-1.5 text-ink-2 text-xs leading-4"
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

      <div class="mt-1.5 flex h-5 items-center gap-2">
        <Show when={ui.groupBy !== "status"}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onStatusClick(event);
            }}
            class="-m-1 shrink-0 rounded-[5px] p-1 hover:bg-hover"
            title={props.task.status ?? "No status"}
          >
            <StatusIcon type={props.task.statusType} color={props.task.statusColor} size={13} />
          </button>
        </Show>

        <PriorityIcon priority={props.task.priority} class="shrink-0" />

        <Show when={props.task.customId}>
          {/* The one string a developer copies out of here, into a branch name
              or a commit message, so it opts back in to text selection. */}
          <span class="selectable truncate font-mono text-ink-3 text-xs tabular-nums">
            {props.task.customId}
          </span>
        </Show>

        <div class="min-w-0 flex-1" />

        <Show when={due()}>
          {(label) => (
            <span class={`shrink-0 text-xs ${DUE_TONE[label().tone]}`}>{label().text}</span>
          )}
        </Show>

        <div class="shrink-0">
          <AvatarStack users={props.task.assignees} max={2} ring="ring-elevated" />
        </div>
      </div>
    </div>
  );
}
