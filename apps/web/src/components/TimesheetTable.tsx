import { createEffect, createResource, createSignal, For, type JSX, Show } from "solid-js";
import { api, type TimesheetRow } from "../lib/api.ts";
import { formatDuration, toDateInput } from "../lib/format.ts";
import { heldValue } from "../lib/resource.ts";
import { TimeEntryModal } from "./TimeEntryModal.tsx";

/**
 * My week: one row per task tracked against, seven day columns, totals.
 *
 * Still not ClickUp's editor — no cell takes typing. The name opens the task
 * and a day cell opens "Add time" for that task on that day, which is the one
 * thing you come to a sheet wanting to do to a number that is missing.
 * Numbers come from ClickUp live (see the API route), the status chip and the
 * path under each name from the mirror.
 *
 * The bars under the day headers are scaled against the week's heaviest day,
 * so the shape of the week survives even when nobody hit eight hours.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface Week {
  start: number;
  end: number;
  now: number;
  rows: TimesheetRow[];
}

/** "Sun" … "Sat", Sunday-first to match the grid the server answers with. */
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * The `day`-th column of the week that starts at `weekStart`, as a local date.
 *
 * Calendar arithmetic, not `weekStart + day * DAY_MS`: a week containing a DST
 * change has a 23- or 25-hour day in it, and the fixed step slides every column
 * after the fold onto the wrong date. That was harmless while the dates were
 * only labels; the cells are now clickable and the date they name is what gets
 * written to ClickUp.
 *
 * Local getters, unlike the UTC ones the labels used to read. `start` is the
 * epoch of the viewer's own Sunday midnight, so east of UTC its UTC date is the
 * Saturday before — the whole header row was a day behind in those zones.
 *
 * ponytail: the *numbers* in the columns are still bucketed by the server with
 * a fixed 24h step (`timesheet.ts`), so in the two weeks a year that hold a
 * clock change its boundaries sit an hour off the dates named here. An hour of
 * one week's work lands one column over, twice a year; fixing it properly means
 * teaching the route calendar days, which is a server change and a wider one
 * than a clickable cell. Exported for its test.
 */
export function columnDate(weekStart: number, day: number): Date {
  const d = new Date(weekStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + day);
}

function dayLabel(date: Date): string {
  return `${DAY_LABELS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** "Aug 23" — the bare date, for the range title. No weekday: the column
 *  headers under it already name the days, and the title repeating them reads
 *  as noise on a line whose job is to say which week. */
function dateLabel(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Whether the week starting at `start` is the one containing `now`.
 *
 * Folded the way the server folds it — shift into wall time, read the UTC
 * getters, shift back — so the two ends cannot disagree about which Sunday a
 * week begins on. The tz offset is what the browser already told the server.
 */
function isThisWeek(now: number, start: number): boolean {
  const tz = -new Date().getTimezoneOffset();
  const local = new Date(now + tz * 60_000);
  const midnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - local.getUTCDay(),
  );
  return midnight - tz * 60_000 === start;
}

/** Forward navigation stops at the current week: no hours exist past it yet. */
function canGoForward(week: Week | null | undefined): boolean {
  if (!week) return false;
  return !isThisWeek(week.now, week.start);
}

/**
 * Sunday 00:00 of the week containing `instant`, the browser's zone — the
 * same fold the server runs on the anchor. Client-side copy, because the
 * title must be computable from the click alone: a range derived from the
 * answer blanks mid-flight and drags the navigation bar's layout with it.
 */
function weekStartOf(instant: number): number {
  const tz = -new Date().getTimezoneOffset();
  const local = new Date(instant + tz * 60_000);
  const midnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - local.getUTCDay(),
  );
  return midnight - tz * 60_000;
}

export function TimesheetTable(): JSX.Element {
  /**
   * The week on screen: an epoch inside it, seeded with today.
   *
   * Not `null`: Solid skips a sourced resource whose source starts falsy, and
   * this page would sit on "Loading…" until a button was pressed. Today's
   * instant means "the current week", which the server snaps to its Sunday —
   * the same call answers both cases, one shape throughout.
   */
  const [anchor, setAnchor] = createSignal<number>(Date.now());
  const [week, { refetch }] = createResource(anchor, (a) => api.timesheet(a));

  /** The cell "Add time" was opened from: which task, and which day of it. */
  const [adding, setAdding] = createSignal<{
    taskId: string;
    taskName: string;
    day: string;
  } | null>(null);

  /**
   * The last good sheet, held by us rather than by the resource.
   *
   * A source change resets the resource — and `latest` with it — for a beat
   * before the new fetch lands, which unmounted the whole grid and left the
   * pane blank however clever the dim on top was. This signal only ever holds
   * answers that arrived, so the table stays mounted across navigations by
   * construction and the dim/chip have somewhere to live.
   */
  const [sheet, setSheet] = createSignal<Week | null>(null);
  createEffect(() => {
    // `heldValue`, because `week()` re-throws a failed fetch into this effect,
    // and with no ErrorBoundary that took the page down before the error line
    // in the render below ever got to say what happened.
    const current = heldValue(week);
    if (current) setSheet(current);
  });

  /**
   * True from the click that changes weeks until the new answer is rendered.
   *
   * Both sides are Sundays — the anchor folded locally, the answer as the
   * server snapped it — so the comparison converges when the asked week is
   * the one on screen. (An earlier version compared the raw anchor against
   * the answer and never converged; the dim never lifted.)
   */
  const navigating = () => {
    const current = sheet();
    if (!current) return false;
    return weekStartOf(anchor()) !== current.start;
  };

  const shift = (days: number) => {
    // Re-anchor from the sheet's own start rather than from today, so two
    // clicks always move exactly two weeks even across a DST boundary.
    setAnchor((sheet() ?? { start: Date.now() }).start + days * DAY_MS);
  };

  /** Longest tracked day on the sheet; the header bars scale against it. */
  const maxDay = () => {
    const data = sheet();
    if (!data) return 0;
    return Math.max(1, ...data.rows.flatMap((row) => row.days.map((d) => d?.durationMs ?? 0)));
  };

  return (
    <div class="flex flex-1 flex-col overflow-auto px-6 py-5">
      {/* ‹ Anterior · range · Siguiente ›. "Next" dies on the current week:
          the future has no hours to show, and a page that says so reads as
          broken rather than as empty. */}
      <div class="flex items-center gap-3 pb-4">
        <button
          type="button"
          onClick={() => shift(-7)}
          class="rounded-[5px] px-2 py-1 text-ink-2 text-xs hover:bg-hover hover:text-ink"
        >
          ‹ Previous
        </button>
        {/* From the anchor, never from the answer: the range is known the
            moment the button is pressed, and a title that blanks mid-flight
            takes the bar's layout with it. */}
        <span class="flex-1 text-center font-medium text-ink text-xs">
          {dateLabel(columnDate(weekStartOf(anchor()), 0))} —{" "}
          {dateLabel(columnDate(weekStartOf(anchor()), 6))}
          <Show when={!navigating() && isThisWeek(Date.now(), weekStartOf(anchor()))}>
            <span class="ml-2 rounded bg-chip px-1.5 py-0.5 font-normal text-ink-4">this week</span>
          </Show>
        </span>
        <button
          type="button"
          disabled={!canGoForward(sheet())}
          onClick={() => shift(7)}
          class="rounded-[5px] px-2 py-1 text-ink-2 text-xs enabled:hover:bg-hover enabled:hover:text-ink disabled:text-ink-4"
        >
          Next ›
        </button>
      </div>
      <Show
        when={!week.error}
        fallback={
          <p class="text-ink-4 text-sm">
            Could not read time from ClickUp
            {week.error instanceof Error ? `: ${week.error.message}` : "."}
          </p>
        }
      >
        {/* The sheet signal only ever holds answers that arrived, so the grid
            stays mounted across a navigation — dimmed, with the chip over it —
            instead of unmounting to a blank pane while the resource resets. */}
        <Show when={sheet()} fallback={<p class="text-ink-4 text-sm">Loading…</p>}>
          {(data) => (
            <div class="relative transition-opacity" classList={{ "opacity-40": navigating() }}>
              <Show
                when={!navigating()}
                fallback={
                  <div class="absolute inset-x-0 top-0 z-10 flex justify-center">
                    <span
                      aria-live="polite"
                      class="floating rounded-full px-3 py-1 text-ink-2 text-xs"
                    >
                      Loading week…
                    </span>
                  </div>
                }
              >
                <span />
              </Show>
              <table class="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr class="text-left">
                    <th class="pb-2 pr-3 font-normal text-ink-4 text-xs">Task</th>
                    <For each={data().rows[0]?.days ?? Array.from({ length: 7 }, () => null)}>
                      {(_, day) => {
                        const total = data().rows.reduce(
                          (sum, row) => sum + (row.days[day()]?.durationMs ?? 0),
                          0,
                        );
                        const bar = Math.round((total / maxDay()) * 100);
                        return (
                          <th class="max-dock:hidden max-dock:pb-2 max-dock:pl-3 pb-2 text-right align-bottom">
                            <div class="font-normal text-ink-4 text-xs">
                              {dayLabel(columnDate(data().start, day()))}
                            </div>
                            <div class="font-medium text-ink-2 text-xs tabular-nums">
                              {formatDuration(total) ?? "—"}
                            </div>
                            <div class="mt-1 h-1 w-full overflow-hidden rounded-full bg-chip">
                              <div
                                class="h-full rounded-full bg-accent/70"
                                style={{ width: `${bar}%` }}
                              />
                            </div>
                          </th>
                        );
                      }}
                    </For>
                    <th class="pb-2 pl-3 text-right align-bottom font-normal text-ink-4 text-xs">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={data().rows}>
                    {(row) => (
                      <SheetRow
                        weekStart={data().start}
                        row={row}
                        onAddTime={(day) =>
                          setAdding({
                            taskId: row.taskId,
                            taskName: row.taskName,
                            day: toDateInput(columnDate(data().start, day).getTime()),
                          })
                        }
                      />
                    )}
                  </For>
                  <Show when={data().rows.length === 0}>
                    <tr>
                      <td colspan="2" class="pt-6 text-ink-4 text-sm">
                        Nothing tracked this week yet.
                      </td>
                    </tr>
                  </Show>
                </tbody>
              </table>

              {/* Grand total sits apart rather than as one more row: it sums a
                  different thing — people's weeks, not tasks — and a bold cell
                  in the Total column would read as one more task's sum. */}
              <p class="mt-4 text-right text-ink-2 text-xs tabular-nums">
                Week total{" "}
                <span class="font-medium text-ink text-base">
                  {formatDuration(data().rows.reduce((sum, row) => sum + row.totalMs, 0)) ?? "0h"}
                </span>
              </p>
            </div>
          )}
        </Show>
      </Show>

      {/* Outside the grid rather than inside the cell that opened it: a dialog
          rendered from a `<td>` inherits the table's layout, and the row it
          hangs off is replaced wholesale by the refetch it triggers. */}
      <Show when={adding()}>
        {(cell) => (
          <TimeEntryModal
            taskId={cell().taskId}
            taskName={cell().taskName}
            day={cell().day}
            onClose={() => setAdding(null)}
            // The whole week, because a manual entry moves the day column, the
            // row total, the header bars and the grand total all at once.
            onSaved={() => void refetch()}
          />
        )}
      </Show>
    </div>
  );
}

function SheetRow(props: {
  weekStart: number;
  row: TimesheetRow;
  /** The day column that was clicked, 0 = Sunday. */
  onAddTime: (day: number) => void;
}): JSX.Element {
  const path = (): string | null => {
    const location = props.row.location;
    if (!location?.includes(" / ")) return null;
    return location.slice(location.indexOf(" / ") + 3);
  };

  return (
    <tr class="group border-line/60 border-t">
      <td class="max-w-[340px] py-2 pr-3">
        <a
          href={`/?task=${encodeURIComponent(props.row.taskId)}&expanded=true`}
          class="block rounded-[5px] px-1 py-0.5 -mx-1 hover:bg-hover"
        >
          <span class="line-clamp-1 font-medium text-ink">{props.row.taskName}</span>
          <span class="mt-0.5 flex items-center gap-1.5">
            <StatusChip row={props.row} />
            <Show when={path()}>
              {(p) => <span class="truncate text-ink-4 text-xs">{p()}</span>}
            </Show>
          </span>
        </a>
      </td>
      {/* Every day of an existing row is a way in, including the empty ones —
          a blank Wednesday is exactly where somebody notices they forgot to
          track something. Rows the sheet does not have need a task picker,
          which this version does not carry. */}
      <For each={props.row.days}>
        {(cell, day) => (
          <td class="max-dock:hidden py-2 pl-3 text-right align-top text-xs tabular-nums">
            <button
              type="button"
              onClick={() => props.onAddTime(day())}
              aria-label={`Add time to ${props.row.taskName} on ${dayLabel(
                columnDate(props.weekStart, day()),
              )}`}
              class="-mx-1 w-full rounded-[5px] px-1 py-0.5 text-right hover:bg-hover"
            >
              <Show when={cell} fallback={<span class="text-ink-4">—</span>}>
                {(value) => (
                  <span
                    classList={{
                      "text-high": value().running,
                      "text-ink-2": !value().running,
                    }}
                  >
                    {formatDuration(value().durationMs)}
                  </span>
                )}
              </Show>
            </button>
          </td>
        )}
      </For>
      <td class="py-2 pl-3 text-right align-top font-medium text-ink text-xs tabular-nums">
        {formatDuration(props.row.totalMs)}
      </td>
    </tr>
  );
}

/**
 * A bare dot in the row's status colour, then the word.
 *
 * Not `StatusIcon`'s clock-and-check set: that vocabulary means "this task's
 * state has these actions" here in a place with no actions at all, and a
 * coloured point says the same thing at a third of the ink.
 */
function StatusChip(props: { row: TimesheetRow }): JSX.Element {
  return (
    <Show when={props.row.status} fallback={<span class="text-ink-4 text-xs">—</span>}>
      {(status) => (
        <span class="flex shrink-0 items-center gap-1 text-ink-3 text-xs">
          <span
            class="size-1.5 rounded-full"
            style={{ background: props.row.statusColor ?? "#87909e" }}
          />
          {status()}
        </span>
      )}
    </Show>
  );
}
