import { type JSX, Show } from "solid-js";
import type { InboxReason, Task } from "../lib/api.ts";
import { isUnread, unreadSince } from "../lib/inbox.ts";
import { Avatar } from "./Avatar.tsx";

/**
 * One line of the feed, when the reason somebody should look is a comment.
 *
 * The same 36px as `TaskRow` and deliberately so: the list windows by a fixed
 * row height, and a feed that mixes two heights would either need measuring or
 * would scroll to the wrong offset. Two row shapes, one rhythm.
 *
 * What is bright and what is dim is the whole design here. A task row answers
 * "what is this and what state is it in", so the title leads. A comment row
 * answers "does this need me", and the answer is in the words somebody wrote —
 * so the message leads and the task name drops back to where `TaskRow` puts the
 * list name, as the context for a sentence rather than the subject of the row.
 */

/**
 * What each signal is called on screen, and what it looks like.
 *
 * Ranked in `notableComments`, so a row only ever shows the strongest reason it
 * has. The glyph is what makes that ranking legible at a glance: three kinds of
 * "somebody said something" that need three different amounts of attention.
 */
const KIND: Record<InboxReason["kind"], { label: string; path: string; tone: string }> = {
  // An "@". Drawn rather than typed so it sits on the same 15px grid as every
  // other glyph in the row instead of on the font's baseline.
  mention: {
    label: "Mentioned you",
    path: "M10.4 5.6a3.4 3.4 0 1 0 0 4.8M10.4 5.2v4.1a1.6 1.6 0 0 0 3.2 0V8a5.6 5.6 0 1 0-2.2 4.45",
    tone: "text-accent",
  },
  // An inbox tray: the comment was handed to you by name.
  assigned: {
    label: "Assigned you a comment",
    path: "M2.5 8.5h3l1 2h3l1-2h3M2.5 8.5 4 3.5h8l1.5 5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z",
    tone: "text-accent",
  },
  // A speech bubble. The blunt signal, so the dimmest of the three.
  comment: {
    label: "Commented",
    path: "M13.5 7.8c0 2.6-2.5 4.7-5.5 4.7a6.6 6.6 0 0 1-1.6-.2L3 13.5l1-2.4A4.4 4.4 0 0 1 2.5 7.8c0-2.6 2.5-4.7 5.5-4.7s5.5 2.1 5.5 4.7Z",
    tone: "text-ink-4",
  },
};

export function InboxRow(props: {
  task: Task;
  reason: InboxReason;
  active: boolean;
  selected: boolean;
  onOpen: () => void;
}): JSX.Element {
  const kind = () => KIND[props.reason.kind];
  const unread = () => {
    const since = unreadSince();
    if (since === null) return false;
    // The conversation's clock, not the task's — and the newest thing said on
    // it rather than the line being shown, which can be an older mention that
    // outranked it. A task touched since you looked with nothing new said on it
    // is not what this row is about.
    const at = props.reason.latestAt ?? props.reason.at;
    return at !== null ? Date.parse(at) > since : isUnread(props.task, since);
  };

  return (
    // Same contract as TaskRow: the listbox owns focus and the shell owns keys.
    // biome-ignore lint/a11y/useFocusableInteractive: listbox owns focus
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys handled in the shell
    <div
      id={`task-${props.task.id}`}
      role="option"
      aria-selected={props.selected}
      onClick={props.onOpen}
      class="group relative flex h-9 cursor-default items-center gap-3 border-line/45 border-b pr-5 pl-5 transition-colors duration-75"
      classList={{ "row-selected": props.active, "hover:bg-hover": !props.active }}
    >
      <span
        class="absolute top-0 bottom-0 left-0 w-[2px] bg-accent transition-opacity"
        classList={{ "opacity-100": props.active, "opacity-0": !props.active }}
      />

      <span
        class="size-1.5 shrink-0 rounded-full bg-accent transition-opacity"
        classList={{ "opacity-0": !unread() }}
        aria-hidden="true"
      />
      <Show when={unread()}>
        <span class="sr-only">Unread.</span>
      </Show>

      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        class={`shrink-0 ${kind().tone}`}
        role="img"
        aria-label={kind().label}
      >
        <title>{kind().label}</title>
        <path
          d={kind().path}
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>

      <Avatar
        user={{
          id: props.reason.authorId ?? "",
          username: props.reason.authorName,
          initials: null,
          color: null,
          avatar: props.reason.authorAvatar,
        }}
        size={18}
        class="shrink-0"
      />

      {/* Author and message in one run, so the eye reads a sentence rather than
          two columns it has to join up. The name carries the weight; the words
          carry the meaning. */}
      <span class="min-w-0 flex-1 truncate text-base">
        <Show when={props.reason.authorName}>
          <span class="font-medium text-ink">{props.reason.authorName}</span>
          <span class="text-ink-4">: </span>
        </Show>
        <span class="text-ink-2">{props.reason.excerpt || "—"}</span>
      </span>

      {/* Where TaskRow puts the list name, and for the same reason: it is the
          context of the row, not its subject. Sheds first when the row narrows. */}
      <span class="max-w-[180px] shrink-0 truncate text-xs text-ink-3 @max-row-tight:hidden">
        {props.task.name}
      </span>
    </div>
  );
}
