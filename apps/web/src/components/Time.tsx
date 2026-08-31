import { createEffect, createResource, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { ApiError, api, type NewTimeEntry, type TimeEntry } from "../lib/api.ts";
import { parseDuration } from "../lib/duration.ts";
import {
  formatClock,
  formatDuration,
  formatRelative,
  fromDateInput,
  toDateInput,
} from "../lib/format.ts";
import { reconcileStorage } from "../lib/reconcile-storage.ts";
import { heldValue } from "../lib/resource.ts";
import { elapsed, isTracking, running, stopTimer, toggleTimer } from "../lib/timer.ts";
import { pushToast } from "../lib/toast.ts";
import { Avatar } from "./Avatar.tsx";
import { TimeEntryModal } from "./TimeEntryModal.tsx";

/**
 * Time tracked on a task.
 *
 * The only panel in the app whose contents are not in the mirror. Entries are
 * read from ClickUp when the section is expanded, the way `spaces/:id/tags` is
 * read when the tag menu opens — one request beats another table to keep in
 * step for something nobody filters or sorts by.
 *
 * Everyone's entries are here, not just yours. Editing and deleting are offered
 * on all of them, because Rask cannot tell who is an admin: the workspace
 * endpoint in ClickUp's vendored spec carries no `role`, and hiding the buttons
 * from anyone but the entry's author would take the ability away from the
 * admins who do have it. ClickUp decides, and says so through a toast.
 */
export function TimeEntries(props: { taskId: string }): JSX.Element {
  /*
   * Collapsed until asked for, and not fetched until then either.
   *
   * The log sits between the description and the conversation, and a task
   * tracked for a month holds enough rows to push the comments below the fold
   * of a panel someone opened to read them. Collapsing is also what makes the
   * section cheap: the fetch costs a real ClickUp request out of the viewer's
   * own 100/min, and it used to be spent on every task opened. The total is
   * still up in the property rail either way.
   */
  const [open, setOpen] = createSignal(false);
  const [logging, setLogging] = createSignal(false);

  const [entries, { refetch, mutate }] = createResource(
    () => (open() ? props.taskId : null),
    (id) => api.timeEntries(id).then((r) => r.entries),
    /*
     * Reconciled, not replaced. A refetch answers with all-new row objects,
     * and `<For>` keys by reference, so every refresh — including the one that
     * follows stopping a timer — tore down and rebuilt every visible row. The
     * same fix, for the same blink, as the task detail's resource.
     */
    { storage: reconcileStorage },
  );

  // Another task is another log: fold it back, and drop the rows. Folding
  // alone only postpones the leak — the panel is one instance across task
  // switches, so without the clear, expanding on task B replays task A's
  // entries for the whole ClickUp round trip while B's fetch runs.
  createEffect(() => {
    props.taskId;
    setOpen(false);
    setLogging(false);
    mutate(undefined);
  });

  /*
   * `heldValue`, never `entries()`. This resource talks to ClickUp — an
   * expired token answers 409, so the plain read can throw over a panel nobody
   * was looking at; and every expand after the first is a fetch in flight, so
   * the plain read suspended the whole page to the router's boundary for the
   * length of a ClickUp round trip. The section says it failed and the rest of
   * the task survives.
   */
  const rows = () => heldValue(entries) ?? [];
  const failed = () => entries.state === "errored";

  /*
   * A stopped timer leaves an interval this list does not have.
   *
   * Watching the transition rather than refetching after our own toggle,
   * because this task's timer can also be stopped from the sidebar band, from
   * another tab over SSE, or by someone starting a timer somewhere else. All of
   * them arrive here as tracking going true then false.
   */
  let wasTracking = false;
  createEffect(() => {
    const tracking = isTracking(props.taskId);
    // Only while the list is showing: folded, the next expand fetches fresh.
    if (open() && wasTracking && !tracking) void refetch();
    wasTracking = tracking;
  });

  const remove = async (entry: TimeEntry) => {
    // Optimistic: the row is gone from ClickUp by the time the refetch lands,
    // and leaving it on screen in between reads as "the delete did nothing".
    mutate((current) => (current ?? []).filter((row) => row.id !== entry.id));
    try {
      await api.deleteTimeEntry(entry.id, props.taskId);
    } catch (error) {
      pushToast({
        tone: "error",
        title: "Could not delete that entry",
        detail: error instanceof ApiError ? error.message : undefined,
      });
    }
    void refetch();
  };

  const save = async (entry: TimeEntry, patch: { description?: string; durationMs?: number }) => {
    try {
      const body: Parameters<typeof api.patchTimeEntry>[1] = {};
      if (patch.description !== undefined) body.description = patch.description;
      /*
       * A duration is written as a span, because the endpoint refuses `start`
       * without `end`. The start is left where it is and the end moves: an
       * entry says when the work began, and correcting how long it ran should
       * not quietly reschedule it.
       */
      if (patch.durationMs !== undefined && entry.start !== null) {
        body.span = { start: entry.start, end: entry.start + patch.durationMs };
      }
      const { entry: updated } = await api.patchTimeEntry(entry.id, body);
      mutate((current) => (current ?? []).map((row) => (row.id === updated.id ? updated : row)));
    } catch (error) {
      pushToast({
        tone: "error",
        title: "Could not save that entry",
        detail: error instanceof ApiError ? error.message : undefined,
      });
      void refetch();
    }
  };

  /** Writes an interval that already happened, then lets the refetch confirm it. */
  const log = async (input: NewTimeEntry) => {
    try {
      const { entry } = await api.createTimeEntry(props.taskId, input);
      // Into place rather than on top: the list reads newest-first, and an
      // entry logged for last Tuesday belongs with last Tuesday's.
      mutate((current) =>
        [entry, ...(current ?? [])].sort((a, b) => (b.start ?? 0) - (a.start ?? 0)),
      );
    } catch (error) {
      pushToast({
        tone: "error",
        title: "Could not log that time",
        detail: error instanceof ApiError ? error.message : undefined,
      });
    }
    // Either way: on success it settles the race with the expand's own fetch,
    // which may still be in flight and would answer without the new entry; on
    // failure it clears whatever state the section was stuck in.
    void refetch();
  };

  return (
    <section class="border-line/70 border-t px-5 py-4">
      {/* "Time entries", not "Time": the total and the start button are up in
          the property rail, and two sections of one panel answering to the same
          word is how you end up reading both to find out which is which. The
          count follows `Attachments`. */}
      <h3 class="flex items-baseline pb-3 font-medium text-xs text-ink-4">
        <button
          type="button"
          onClick={() => setOpen(!open())}
          aria-expanded={open()}
          class="flex items-baseline gap-1.5 uppercase tracking-[0.04em] hover:text-ink-2"
        >
          <span aria-hidden="true" class="inline-block w-2 text-[9px]">
            {open() ? "▾" : "▸"}
          </span>
          Time entries
          <Show when={open() && rows().length > 0}>
            <span class="tabular-nums lowercase">{rows().length}</span>
          </Show>
        </button>
        {/* The same slot `Attachments` gives "Add file". */}
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setLogging(true);
          }}
          class="ml-auto font-normal text-ink-4 text-xs hover:text-ink-2"
        >
          Log time
        </button>
      </h3>

      <Show when={open()}>
        {/* Inside the fold, so collapsing the section also puts the form away
            rather than leaving it floating under a closed header. */}
        <Show when={logging()}>
          <LogForm
            onCancel={() => setLogging(false)}
            onSubmit={(input) => {
              setLogging(false);
              void log(input);
            }}
          />
        </Show>

        <Show
          when={rows().length > 0 || entries.loading}
          fallback={
            <p class="text-ink-4 text-xs">
              {failed() ? "Could not read time from ClickUp." : "No time tracked yet."}
            </p>
          }
        >
          <ul class="space-y-1">
            <For each={rows()}>
              {(entry) => <Row entry={entry} onSave={save} onDelete={remove} />}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}

/**
 * When a manual entry begins, given the day picked and how long it ran.
 *
 * Anchored to its *end* on the current day — "log 2h" means the two hours just
 * worked, not two hours starting now — while a past day pins the entry to noon,
 * since nobody remembers the minute and noon keeps it on the date they picked
 * in every timezone ClickUp might render it in. Exported for its test: this is
 * the arithmetic that writes somebody's timesheet.
 */
export function entryStart(day: string, durationMs: number, now: number): number | null {
  if (day === toDateInput(now)) return now - durationMs;
  return fromDateInput(day);
}

/** Length, day, note. The day defaults to today; `entryStart` places the interval. */
function LogForm(props: {
  onCancel: () => void;
  onSubmit: (input: NewTimeEntry) => void;
}): JSX.Element {
  // `toDateInput`, not `toISOString().slice(0, 10)`: that slices the UTC day,
  // which after a timezone's midnight is yesterday's date in the picker.
  const today = toDateInput(Date.now());
  const [length, setLength] = createSignal("");
  const [day, setDay] = createSignal(today);
  const [note, setNote] = createSignal("");
  // `autofocus` only fires while the document parses; this form mounts on a
  // click, so the focus is placed by hand the way the command palette's is.
  let lengthInput!: HTMLInputElement;
  onMount(() => lengthInput.focus());

  const submit = (event: Event) => {
    event.preventDefault();
    const durationMs = parseDuration(length());
    if (durationMs === null || durationMs <= 0) {
      pushToast({
        tone: "error",
        title: "That is not a length I can read",
        detail: "Try 1h 30m, 1:30, or 1.5.",
      });
      return;
    }

    const start = entryStart(day() || today, durationMs, Date.now());
    if (start === null) return;

    props.onSubmit({
      start,
      durationMs,
      description: note().trim() || undefined,
    });
  };

  return (
    <form class="flex items-center gap-2 pb-2" onSubmit={submit}>
      <input
        ref={lengthInput}
        value={length()}
        onInput={(event) => setLength(event.currentTarget.value)}
        placeholder="1h 30m"
        aria-label="Length"
        class="w-16 shrink-0 rounded-[4px] bg-chip px-1.5 py-0.5 text-right text-ink text-xs tabular-nums outline-none focus:ring-1 focus:ring-accent"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
      <input
        type="date"
        value={day()}
        max={today}
        onInput={(event) => setDay(event.currentTarget.value)}
        aria-label="Day"
        class="shrink-0 rounded-[4px] bg-chip px-1.5 py-0.5 text-ink text-xs outline-none focus:ring-1 focus:ring-accent"
      />
      <input
        value={note()}
        onInput={(event) => setNote(event.currentTarget.value)}
        placeholder="Note…"
        aria-label="Note"
        class="min-w-0 flex-1 rounded-[4px] bg-chip px-1.5 py-0.5 text-ink text-xs outline-none focus:ring-1 focus:ring-accent"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
      <button type="submit" class="shrink-0 px-1 py-0.5 font-medium text-accent text-xs">
        Save
      </button>
      <button
        type="button"
        onClick={props.onCancel}
        class="shrink-0 px-1 py-0.5 text-ink-4 text-xs hover:text-ink-2"
      >
        Cancel
      </button>
    </form>
  );
}

function Row(props: {
  entry: TimeEntry;
  onSave: (entry: TimeEntry, patch: { description?: string; durationMs?: number }) => Promise<void>;
  onDelete: (entry: TimeEntry) => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);

  /*
   * The running entry cannot be edited: its duration is still being decided by
   * ClickUp, and writing a span over it would stop it in a way the user did not
   * ask for. It shows the counter from the header instead.
   */
  const editable = () => !props.entry.running && props.entry.start !== null;

  return (
    <li class="group/entry flex items-center gap-2 rounded-[5px] px-1 py-1 hover:bg-hover/60">
      <Avatar user={props.entry.user} size={18} />

      <Show
        when={editing()}
        fallback={
          <>
            <span
              class="w-14 shrink-0 text-right font-medium text-ink text-xs tabular-nums"
              classList={{ "text-high": props.entry.running }}
            >
              <Show when={!props.entry.running} fallback="running">
                {formatDuration(props.entry.durationMs)}
              </Show>
            </span>

            <button
              type="button"
              disabled={!editable()}
              onClick={() => setEditing(true)}
              class="flex-1 cursor-text truncate text-left text-ink-2 text-xs disabled:cursor-default"
            >
              {props.entry.description || (
                <span class="text-ink-4">{editable() ? "Add a note…" : "—"}</span>
              )}
            </button>

            <span class="shrink-0 text-ink-4 text-xs">
              {formatRelative(
                props.entry.start === null ? null : new Date(props.entry.start).toISOString(),
              )}
            </span>

            <Show when={editable()}>
              <button
                type="button"
                onClick={() => {
                  if (confirming()) void props.onDelete(props.entry);
                  else setConfirming(true);
                }}
                onBlur={() => setConfirming(false)}
                aria-label={confirming() ? "Confirm deleting this entry" : "Delete this time entry"}
                class="shrink-0 rounded-[4px] px-1 py-0.5 text-xs opacity-0 hover:bg-hover focus-visible:opacity-100 group-hover/entry:opacity-100"
                classList={{
                  "text-high opacity-100": confirming(),
                  "text-ink-4 hover:text-ink-2": !confirming(),
                }}
              >
                {/* Two steps, because ClickUp has no undo for this and the row
                    is somebody's paid hours. */}
                {confirming() ? "Sure?" : "Delete"}
              </button>
            </Show>
          </>
        }
      >
        <Editor entry={props.entry} onCancel={() => setEditing(false)} onSave={props.onSave} />
      </Show>
    </li>
  );
}

function Editor(props: {
  entry: TimeEntry;
  onCancel: () => void;
  onSave: (entry: TimeEntry, patch: { description?: string; durationMs?: number }) => Promise<void>;
}): JSX.Element {
  const [length, setLength] = createSignal(formatDuration(props.entry.durationMs) ?? "");
  const [note, setNote] = createSignal(props.entry.description);

  const submit = (event: Event) => {
    event.preventDefault();
    const parsed = parseDuration(length());
    if (parsed === null) {
      // Refusing beats writing a zero: an unreadable box is a typo, and a typo
      // that silently becomes "no time worked" is the worst available answer.
      pushToast({
        tone: "error",
        title: "That is not a length I can read",
        detail: "Try 1h 30m, 1:30, or 1.5.",
      });
      return;
    }

    const patch: { description?: string; durationMs?: number } = {};
    if (note() !== props.entry.description) patch.description = note();
    if (parsed !== props.entry.durationMs) patch.durationMs = parsed;

    props.onCancel();
    if (patch.description !== undefined || patch.durationMs !== undefined) {
      void props.onSave(props.entry, patch);
    }
  };

  return (
    <form class="flex flex-1 items-center gap-2" onSubmit={submit}>
      <input
        value={length()}
        onInput={(event) => setLength(event.currentTarget.value)}
        aria-label="Length"
        class="w-14 shrink-0 rounded-[4px] bg-chip px-1.5 py-0.5 text-right text-ink text-xs tabular-nums outline-none focus:ring-1 focus:ring-accent"
      />
      <input
        value={note()}
        onInput={(event) => setNote(event.currentTarget.value)}
        placeholder="Note…"
        aria-label="Note"
        // The row was clicked in order to be edited; landing anywhere else
        // would mean a second click before typing.
        autofocus
        class="flex-1 rounded-[4px] bg-chip px-1.5 py-0.5 text-ink text-xs outline-none focus:ring-1 focus:ring-accent"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
      <button type="submit" class="shrink-0 px-1 py-0.5 font-medium text-accent text-xs">
        Save
      </button>
      <button
        type="button"
        onClick={props.onCancel}
        class="shrink-0 px-1 py-0.5 text-ink-4 text-xs hover:text-ink-2"
      >
        Cancel
      </button>
    </form>
  );
}

/**
 * The running timer, wherever the user is.
 *
 * Rendered by the shell, not by the sidebar it used to live in. The sidebar is
 * a drawer below `dock` and a task expanded with `f` hides the main panel's
 * header, so both of the places this could sit in the layout disappear under
 * conditions somebody has a timer running in. A timer you cannot see is a timer
 * that runs all night, and the whole point of this is to be able to stop one
 * without navigating back to the task.
 *
 * Bottom right: the toasts already own bottom left, and a running timer is the
 * one thing on screen that has to outlast them.
 */
export function RunningTimer(props: { onOpen: (taskId: string) => void }): JSX.Element {
  return (
    <Show when={running()}>
      {(entry) => (
        <div class="floating fixed right-4 bottom-4 z-50 flex h-9 max-w-[280px] items-center gap-2 rounded-lg pr-1.5 pl-3">
          <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-high" />
          <button
            type="button"
            onClick={() => entry().taskId && props.onOpen(entry().taskId ?? "")}
            disabled={!entry().taskId}
            class="min-w-0 flex-1 truncate text-left text-ink-2 text-xs hover:text-ink disabled:hover:text-ink-2"
            title={entry().taskName ?? undefined}
          >
            {entry().taskName ?? "Tracking"}
          </button>
          <span class="shrink-0 font-medium text-ink text-xs tabular-nums">
            {formatClock(elapsed())}
          </span>
          <button
            type="button"
            /* `stopTimer`, not the toggle: ClickUp allows an entry with no task,
               and a toggle keyed on a null id reads as "not tracking this". */
            onClick={() => void stopTimer()}
            aria-label="Stop the running timer"
            class="shrink-0 rounded-[5px] px-1.5 py-1 text-ink-3 text-xs hover:bg-hover hover:text-ink"
          >
            Stop
          </button>
        </div>
      )}
    </Show>
  );
}

/**
 * The tracked total, and the two things you do with it, in the property rail.
 *
 * The entry log further down is a record you go looking for; starting a timer
 * and writing down an hour you already worked are both things you do on the way
 * past, so they belong with status and priority rather than below the subtasks.
 *
 * Two controls, not one. The row used to be a single button that toggled the
 * timer, which left the total — the thing the row is actually showing — with
 * nothing to click. Now the readout opens "Add time" and the timer keeps a
 * button of its own; the two answer to different verbs and a mis-click costs a
 * dismissable dialog rather than an interval nobody meant to start.
 */
export function TimeControl(props: {
  taskId: string;
  taskName: string;
  /**
   * ClickUp's own total, not the sum of the entries listed further down.
   *
   * The two can disagree, and when they do this one is right: that list only
   * shows entries belonging to somebody in the `users` table, so a deactivated
   * member's hours are missing from a sum and present here.
   */
  timeSpent: number | null;
  /** Fired once ClickUp has taken a manual entry, so the task can be re-read. */
  onLogged?: () => void;
}): JSX.Element {
  const tracking = () => isTracking(props.taskId);
  const [adding, setAdding] = createSignal(false);

  return (
    <div class="-mx-1.5 flex h-6 w-full items-center gap-1">
      <button
        type="button"
        onClick={() => void toggleTimer({ id: props.taskId, name: props.taskName })}
        /* Distinct from the floating pill's "Stop the running timer". Two
           controls doing the same thing may share a page; two controls
           answering to the same name may not. */
        aria-label={tracking() ? "Stop tracking this task" : "Start tracking this task"}
        title={tracking() ? "Stop  t" : "Start  t"}
        class="flex size-6 shrink-0 items-center justify-center rounded-[5px] hover:bg-hover"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="6.1"
            stroke="currentColor"
            stroke-width="1.4"
            class={tracking() ? "text-high" : "text-ink-4"}
          />
          {/* Play when idle, stop when running — the ring stays either way, so
              the control keeps its shape while the verb inside it changes. */}
          <Show
            when={tracking()}
            fallback={<path d="M6.6 5.3 11 8l-4.4 2.7z" fill="currentColor" class="text-ink-4" />}
          >
            <rect
              x="5.9"
              y="5.9"
              width="4.2"
              height="4.2"
              rx="0.8"
              fill="currentColor"
              class="text-high"
            />
          </Show>
        </svg>
      </button>

      <button
        type="button"
        onClick={() => setAdding(true)}
        aria-label="Add time to this task"
        class="group/add flex h-6 flex-1 items-center gap-2 rounded-[5px] px-1.5 text-left hover:bg-hover"
      >
        <Show
          when={tracking()}
          fallback={
            <span class="text-base text-ink-2" classList={{ "text-ink-4": !props.timeSpent }}>
              {formatDuration(props.timeSpent) ?? "None"}
            </span>
          }
        >
          <span class="text-base text-high tabular-nums">{formatClock(elapsed())}</span>
          {/* The counter replacing the total used to read as the total vanishing
              — a start "blinked" hours away. Both, so nothing disappears. */}
          <Show when={props.timeSpent}>
            <span class="text-ink-4 text-xs">+ {formatDuration(props.timeSpent)}</span>
          </Show>
        </Show>

        {/* Hidden until the control is reached, since the number beside it is
            the row's actual content. On focus as well as hover: tabbing here
            has to say what Enter will do. */}
        <span class="ml-auto shrink-0 text-ink-4 text-xs opacity-0 group-focus-visible/add:opacity-100 group-hover/add:opacity-100">
          Add time
        </span>
      </button>

      <Show when={adding()}>
        <TimeEntryModal
          taskId={props.taskId}
          taskName={props.taskName}
          // Today, because the rail is where you land after finishing the work.
          day={toDateInput(Date.now())}
          onClose={() => setAdding(false)}
          onSaved={() => props.onLogged?.()}
        />
      </Show>
    </div>
  );
}
