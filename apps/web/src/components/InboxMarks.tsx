import { type JSX, Show } from "solid-js";
import type { Task } from "../lib/api.ts";
import { isRowUnread, markTaskRead, unreadSince } from "../lib/inbox.ts";

/**
 * The two marks a feed row carries: whether it is new, and how to say you have
 * seen it.
 *
 * Both live here rather than in the rows because there are two row shapes —
 * `TaskRow` and `InboxRow` — and they have to agree about what unread means and
 * where the control sits. They read `unreadSince` themselves rather than taking
 * a prop: the rows render through a windowed `<Index>`, and threading an
 * inbox-shaped flag through the list would put it on every view that has
 * nothing to do with the inbox. Off the feed both draw nothing, by
 * construction rather than by whoever remembers to pass `false`.
 */

/** Whether the feed is on screen at all. Both marks are inert otherwise. */
function inFeed(): boolean {
  return unreadSince() !== null;
}

/**
 * The dot, in a slot that is always there while the feed is.
 *
 * Drawn for every row and filled for the ones you have not seen. Showing it
 * only when unread would step the whole row sideways at the boundary between
 * new and already-read.
 */
export function UnreadDot(props: { task: Task }): JSX.Element {
  const unread = () => isRowUnread(props.task);

  return (
    <Show when={inFeed()}>
      <span
        class="size-1.5 shrink-0 rounded-full bg-accent transition-opacity"
        classList={{ "opacity-0": !unread() }}
        title={unread() ? "Changed since your last visit" : undefined}
        // The dot is decoration; the word below is what gets announced. A label
        // on the dot itself would have every read row say "Read".
        aria-hidden="true"
      />
      <Show when={unread()}>
        <span class="sr-only">Unread.</span>
      </Show>
    </Show>
  );
}

/**
 * Clears one row without touching the rest of the inbox.
 *
 * A check rather than an X: this is "I have seen this", not "delete". The
 * distinction is real — a comment posted after the click is newer than the mark
 * and brings the row back — and an X promises otherwise.
 *
 * Only on rows that are unread, because dismissing a read row does nothing, and
 * the slot is held open for the rest so the column does not jump as you scroll
 * past a mix of the two.
 *
 * ponytail: mouse only. It is `tabindex=-1` because the list is a listbox whose
 * rows are deliberately not tab stops — five hundred rows would be five hundred
 * of them — so the keyboard's way in is a shortcut on the list rather than
 * focus on the button, and that is not built yet. Until it is, this action is
 * unreachable without a pointer.
 */
export function MarkRead(props: { task: Task }): JSX.Element {
  const unread = () => isRowUnread(props.task);

  return (
    <Show when={inFeed()}>
      <span class="flex w-5 shrink-0 justify-end">
        <Show when={unread()}>
          <button
            type="button"
            tabindex={-1}
            title="Mark as read"
            aria-label={`Mark "${props.task.name}" as read`}
            onClick={(event) => {
              // The row opens the task; this one does not.
              event.stopPropagation();
              void markTaskRead(props.task.id).catch(() => {});
            }}
            class="-m-1 rounded-[5px] p-1 text-ink-4 opacity-0 transition-opacity hover:bg-hover hover:text-ink group-hover:opacity-100"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="m3.5 8.4 3 3 6-6.8"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </Show>
      </span>
    </Show>
  );
}
