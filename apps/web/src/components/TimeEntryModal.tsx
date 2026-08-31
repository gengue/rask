import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { ApiError, api } from "../lib/api.ts";
import { parseDuration, startFor } from "../lib/duration.ts";
import { formatDuration } from "../lib/format.ts";
import { pushToast } from "../lib/toast.ts";

/**
 * "Add time": an interval that already happened, written straight to ClickUp.
 *
 * Two ways in — the tracked-time readout on a task, and a day cell on the
 * timesheet — and one dialog, because they are the same sentence with a
 * different day already filled in. Both save through
 * `POST /api/tasks/:id/time-entries`, which waits for ClickUp rather than
 * queuing an outbox row. Not for the reason a timer start does — this payload
 * carries its own interval, so a late drain would still record the right hours
 * — but because there is no `time_entries` table for a queued row to be
 * optimistic against, and because the outbox's retry plus its `STALE_SENDING`
 * reclaim would cheerfully log the same afternoon twice. `apps/api/src/time.ts`
 * has the whole argument.
 *
 * Length is the only thing typed. The start instant is derived (`startFor`),
 * because a manual entry is answering "how long", and asking for a clock time
 * as well is how a two-field form becomes a four-field one nobody fills in.
 */
export function TimeEntryModal(props: {
  taskId: string;
  /** Shown in the dialog's heading so the sheet's cells say what they will write to. */
  taskName?: string | null;
  /** `yyyy-mm-dd` the date picker opens on: today, or the cell that was clicked. */
  day: string;
  onClose: () => void;
  /** Fired after ClickUp accepted the entry — the caller refreshes what it shows. */
  onSaved?: () => void;
}): JSX.Element {
  const [length, setLength] = createSignal("");
  const [day, setDay] = createSignal(props.day);
  const [saving, setSaving] = createSignal(false);

  let lengthInput!: HTMLInputElement;

  const durationMs = () => parseDuration(length());
  /** Null while the box is empty: an untouched field has not made a mistake yet. */
  const unreadable = () => length().trim() !== "" && durationMs() === null;
  const savable = () => {
    const ms = durationMs();
    return !saving() && ms !== null && ms > 0 && startFor(day(), ms, Date.now()) !== null;
  };

  onMount(() => {
    /*
     * `autofocus` only fires while the document parses, and this dialog mounts
     * on a click — so the focus is placed by hand, the way the command
     * palette's is. `preventScroll` for the lightbox's reason: the task panel
     * is the scroll container, and focusing inside a fixed overlay is enough to
     * make the browser scroll whatever is behind it.
     */
    const restore = document.activeElement;
    lengthInput.focus({ preventScroll: true });
    onCleanup(() => {
      if (restore instanceof HTMLElement) restore.focus({ preventScroll: true });
    });
  });

  const save = async (event: Event) => {
    event.preventDefault();
    const ms = durationMs();
    if (ms === null || ms <= 0) return;

    const start = startFor(day(), ms, Date.now());
    if (start === null) return;

    setSaving(true);
    try {
      await api.createTimeEntry(props.taskId, { start, durationMs: ms });
      props.onSaved?.();
      props.onClose();
    } catch (error) {
      // The dialog stays open on failure, with what was typed still in it:
      // the entry was not written, and closing would read as though it was.
      setSaving(false);
      pushToast({
        tone: "error",
        title: "Could not log that time",
        detail: error instanceof ApiError ? error.message : undefined,
      });
    }
  };

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center pt-[16vh]">
      <button
        type="button"
        aria-label="Close"
        tabindex="-1"
        class="absolute inset-0 bg-scrim"
        onClick={props.onClose}
      />

      <form
        role="dialog"
        aria-modal="true"
        aria-label="Add time"
        onSubmit={save}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Stopped as well as prevented: the task panel closes on Escape too,
          // and one keystroke should not both cancel the entry and navigate
          // away from the task it was for.
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }}
        class="floating relative w-[380px] rounded-xl p-4"
      >
        <h2 class="pb-3 font-medium text-ink text-sm">
          Add time
          <Show when={props.taskName}>
            {(name) => <span class="ml-2 truncate font-normal text-ink-4 text-xs">{name()}</span>}
          </Show>
        </h2>

        <div class="flex items-center gap-2">
          <input
            ref={lengthInput}
            value={length()}
            onInput={(event) => setLength(event.currentTarget.value)}
            placeholder="2h 30m"
            aria-label="Length"
            aria-invalid={unreadable()}
            class="h-8 w-[120px] shrink-0 rounded-[5px] bg-chip px-2 text-ink text-md tabular-nums outline-none focus:ring-1 focus:ring-accent"
          />
          <input
            type="date"
            value={day()}
            onInput={(event) => setDay(event.currentTarget.value)}
            aria-label="Day"
            /* No `max`: correcting last week's sheet and blocking out time you
               have already committed to are both things people do here. */
            class="h-8 flex-1 rounded-[5px] bg-chip px-2 text-ink text-md outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* The parsed length, said back before it can be saved. This is the
            whole safety net for a free-form box whose bare numbers are hours:
            typing `90` shows `90h` and nobody saves that by accident.

            A fixed strip, so the dialog does not grow the first time a line
            appears in it and move Save out from under the pointer — but tall
            enough for the line it holds: `text-xs` inherits the body's 1.5
            ratio, so an 11px word wants 16.5px and `h-4` gave it ten. */}
        <p class="h-6 pt-1.5 text-xs" classList={{ "text-urgent": unreadable() }}>
          <Show
            when={unreadable()}
            fallback={
              <Show when={durationMs()}>
                {(ms) => <span class="text-ink-4">= {formatDuration(ms())}</span>}
              </Show>
            }
          >
            Try 2h 30m, 2:30, or 2.5
          </Show>
        </p>

        <div class="flex items-center justify-end gap-2 pt-3">
          <button
            type="button"
            onClick={props.onClose}
            class="rounded-[5px] px-2 py-1 text-ink-3 text-xs hover:bg-hover hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!savable()}
            class="rounded-[5px] bg-accent-soft px-2.5 py-1 font-medium text-accent text-xs enabled:hover:bg-accent/25 disabled:text-ink-4"
          >
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
