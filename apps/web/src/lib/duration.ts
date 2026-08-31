/**
 * Reading and placing a hand-written interval — the arithmetic behind the
 * "Add time" modal.
 *
 * Pure on purpose, and in a module of its own: this is what writes somebody's
 * timesheet, and the two functions below are the only place either decision is
 * made. A component that renders one of them cannot be unit-tested without a
 * DOM; these can, so the rules live here and the modal only draws them.
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;

/** `1:30` and `1:30:20` — hours, minutes, and optionally seconds. A leading
 *  digit is required, so a stray `:30` is refused rather than read as 30
 *  of something. */
const CLOCK = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/;

/** A bare number, `2` or `2.5`. See `parseDuration` for what it means. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

/** `2h30m`, `90m30s`, `45m` — one or more amounts, each with its unit. */
const UNITS = /^(?:\d+(?:\.\d+)?[hms])+$/;
const UNIT_TERM = /(\d+(?:\.\d+)?)([hms])/g;

/**
 * A length of time, in the shapes people type it.
 *
 * `2h 30m`, `2h30m`, `1:30`, `1:30:20`, `90m 30s`, `30s` and a bare `2.5` all
 * land on the same kind of answer. A bare number is **hours**, which is how a
 * timesheet is spoken about out loud ("two and a half on the migration") and
 * what ClickUp's own manual-entry field assumes.
 *
 * Anything unreadable returns null rather than 0. The difference between "I
 * could not understand that" and "you worked no time" is a row of somebody's
 * paid week, so the caller disables Save instead of writing a zero.
 *
 * ponytail: `parseDuration` in `format.ts` reads a bare number as *minutes*,
 * because it grew up next to the inline log form where `90` meant an hour and a
 * half. Two parsers with two answers for `2.5` is one parser too many; the
 * modal shows the parsed length back before you can save it, which is what
 * keeps the disagreement from costing anybody hours. Collapse them into this
 * one the day the owner picks a single meaning for a bare number.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const clock = CLOCK.exec(text);
  if (clock) {
    return (
      Number(clock[1]) * HOUR_MS + Number(clock[2]) * MINUTE_MS + Number(clock[3] ?? 0) * SECOND_MS
    );
  }

  if (DECIMAL.test(text)) return Math.round(Number(text) * HOUR_MS);

  // Whitespace is decoration here: `2h 30m` and `2h30m` are the same sentence.
  // Collapsing it first is what lets one anchored pattern prove the *whole*
  // string is terms — which is how `2h -30m` gets refused instead of quietly
  // becoming two hours.
  const compact = text.replace(/\s+/g, "");
  if (!UNITS.test(compact)) return null;

  let total = 0;
  for (const term of compact.matchAll(UNIT_TERM)) {
    const amount = Number(term[1] ?? 0);
    const unit = term[2];
    total += amount * (unit === "h" ? HOUR_MS : unit === "m" ? MINUTE_MS : SECOND_MS);
  }
  return Math.round(total);
}

/**
 * When an interval of `durationMs` logged against `day` begins.
 *
 * Two anchors, and only two. If the work can have ended just now and still have
 * begun on the day that was picked, it did — "log 2h" on a Tuesday afternoon
 * means the two hours behind you, not two starting now. Otherwise the interval
 * is hung off the end of the chosen day, 23:59:59 local minus its length, so it
 * stays on the date the person selected in whatever zone ClickUp renders it in.
 *
 * `day` is an `<input type="date">` value, `yyyy-mm-dd`, read as a local
 * calendar date. Unreadable returns null; the caller refuses to write.
 *
 * Two consequences worth knowing, both accepted:
 * - Logging against *today* shortly after midnight, longer than you have been
 *   awake, hangs the interval off tonight's 23:59:59 — a few hours in the
 *   future. It is still on the right date, which is the thing the sheet sums by.
 * - A duration longer than a day cannot fit on one, and spills backwards past
 *   midnight. Nothing else would be honest about a 25-hour entry.
 */
export function startFor(day: string, durationMs: number, now: number): number | null {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return null;

  const endOfDay = new Date(year, month - 1, date, 23, 59, 59, 0).getTime();
  if (Number.isNaN(endOfDay)) return null;

  // Compared as calendar parts rather than as formatted strings: the picker
  // pads its months and a hand-built `2026-8-20` does not, and a date that only
  // matches when it is spelled right is a date that silently takes the branch
  // it was not meant to.
  const backdated = now - durationMs;
  const at = new Date(backdated);
  const sameDay = at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === date;

  return sameDay ? backdated : endOfDay - durationMs;
}
