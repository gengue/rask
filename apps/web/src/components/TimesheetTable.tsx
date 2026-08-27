import { createResource, For, type JSX, Show } from "solid-js";
import { api, type TimesheetRow } from "../lib/api.ts";
import { formatDuration } from "../lib/format.ts";

/**
 * My week: one row per task tracked against, seven day columns, totals.
 *
 * An informative sheet, not ClickUp's editor — the cells read and open the
 * task; they do not take typing. Numbers come from ClickUp live (see the API
 * route), the status chip and the path under each name from the mirror.
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

function dayLabel(instant: number): string {
  const d = new Date(instant);
  return `${DAY_LABELS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function TimesheetTable(): JSX.Element {
  // One fetch per mount. There is no week navigation yet on purpose: today is
  // the week people come for, and a pager without an in-cell editor to answer
  // "what did I do Tuesday" invites a screen nobody opens twice.
  const [week] = createResource<Week>(api.timesheet);

  /** Longest tracked day this week; the header bars scale against it. */
  const maxDay = () => {
    const data = week();
    if (!data) return 0;
    return Math.max(1, ...data.rows.flatMap((row) => row.days.map((d) => d?.durationMs ?? 0)));
  };

  return (
    <div class="flex-1 overflow-auto px-6 py-5">
      <Show
        when={!week.error}
        fallback={
          <p class="text-ink-4 text-sm">
            Could not read time from ClickUp
            {week.error instanceof Error ? `: ${week.error.message}` : "."}
          </p>
        }
      >
        <Show when={week()} fallback={<p class="text-ink-4 text-sm">Loading…</p>}>
          {(data) => (
            <>
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
                          <th class="pb-2 pl-3 text-right align-bottom">
                            <div class="font-normal text-ink-4 text-xs">
                              {dayLabel(data().start + day() * DAY_MS)}
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
                    {(row) => <SheetRow weekStart={data().start} now={data().now} row={row} />}
                  </For>
                  <Show when={data().rows.length === 0}>
                    <tr>
                      <td colspan="8" class="pt-6 text-ink-4 text-sm">
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
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}

function SheetRow(props: { weekStart: number; now: number; row: TimesheetRow }): JSX.Element {
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
      <For each={props.row.days}>
        {(cell) => (
          <td class="py-2 pl-3 text-right align-top text-xs tabular-nums">
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
