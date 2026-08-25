const MS_PER_DAY = 86_400_000;

/** Midnight-to-midnight difference, so "tomorrow" does not depend on the hour. */
function daysUntil(date: Date, now = new Date()): number {
  const a = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / MS_PER_DAY);
}

export interface DueLabel {
  text: string;
  tone: "overdue" | "today" | "soon" | "normal";
}

/** The ink a due label is painted in, per tone. Shared so a row, a card and a
 *  subtask cannot drift apart on what "overdue" looks like. */
export const DUE_TONE: Record<DueLabel["tone"], string> = {
  overdue: "text-urgent",
  today: "text-high",
  soon: "text-ink-2",
  normal: "text-ink-3",
};

/** Short, calendar-aware due date. "Today" beats "Jun 24" at a glance. */
export function formatDue(value: string | null, now = new Date()): DueLabel | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const days = daysUntil(date, now);

  if (days < 0) {
    const overdue = Math.abs(days);
    return {
      text: overdue === 1 ? "Yesterday" : overdue < 7 ? `${overdue}d ago` : shortDate(date),
      tone: "overdue",
    };
  }
  if (days === 0) return { text: "Today", tone: "today" };
  if (days === 1) return { text: "Tomorrow", tone: "soon" };
  // Inside the coming week a weekday name reads faster than a date.
  if (days < 7)
    return { text: date.toLocaleDateString(undefined, { weekday: "short" }), tone: "soon" };
  return { text: shortDate(date), tone: "normal" };
}

function shortDate(date: Date): string {
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * A duration in the shape ClickUp writes one: "45m", "2h", "1h 30m".
 *
 * Two units at most, and no seconds. An estimate is set in hours and minutes
 * and a tracked total is read to answer "roughly how long did that take" —
 * neither question gets a better answer from "1h 30m 12s".
 *
 * Zero reads as nothing, not "0m": ClickUp sends 0 for every task nobody has
 * ever tracked against, and a column of zeroes is noise pretending to be data.
 */
export function formatDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;

  const minutes = Math.round(ms / 60_000);
  if (minutes === 0) return "<1m";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function formatRelative(value: string | null, now = new Date()): string {
  if (!value) return "";
  const date = new Date(value);
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return shortDate(date);
}

/**
 * File size, at the precision a person actually reads.
 *
 * Powers of 1024 with the short units, which is what every file manager on the
 * machine shows. One decimal below 10 so 1.4 MB does not round to 1 MB, none
 * above it because nobody is comparing 148 MB to 149 MB.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A timer that is still going, `1:04:09`.
 *
 * Separate from `formatDuration` rather than a mode of it, because it answers a
 * different question. A tracked total is read to settle "roughly how long did
 * that take", where seconds are noise and nothing is worth saying as nothing. A
 * running counter has to visibly move or it looks frozen, and it is never
 * absent: zero seconds elapsed is `0:00`, not blank.
 */
export function formatClock(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "0:00";

  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/**
 * The inverse of `formatDuration`, tolerant of how people actually type.
 *
 * `1h 30m`, `1h30m`, `1:30`, `90m`, `1.5h` and a bare `90` (read as minutes,
 * which is what a bare number means on a timesheet) all land on the same value.
 * Anything it cannot read returns null rather than 0 — the difference between
 * "I could not understand that" and "you worked no time" is a row of somebody's
 * week, so the caller refuses instead of writing a zero.
 */
export function parseDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  const clock = /^(\d+):([0-5]?\d)$/.exec(text);
  if (clock) return (Number(clock[1]) * 60 + Number(clock[2])) * 60_000;

  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 60_000);

  const units = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?$/.exec(text);
  if (!units || (units[1] === undefined && units[2] === undefined)) return null;

  const hours = Number(units[1] ?? 0);
  const minutes = Number(units[2] ?? 0);
  return Math.round((hours * 60 + minutes) * 60_000);
}

export function initialsOf(name: string | null, fallback: string | null): string {
  if (fallback) return fallback.slice(0, 2).toUpperCase();
  if (!name) return "?";
  const [first, second] = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  if (!first) return "?";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

export const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};

/**
 * The value `<input type="date">` wants: `yyyy-mm-dd`, in the reader's own
 * timezone. `toISOString().slice(0, 10)` is the tempting one-liner and it is
 * wrong — it slices the UTC day, which near either end of the day is not the
 * day the label beside the input is showing.
 */
export function toDateInput(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * That value back as an instant, keeping the time of day it already had.
 *
 * A date input has no time in it, and a ClickUp date is a timestamp: rewriting
 * one from a calendar means deciding what the hours were. Whatever they were
 * before, if the field held anything — a due date at 09:00 moved to Thursday is
 * still due at 09:00, and a Custom Field configured to show a time keeps it
 * rather than losing it to a day nobody was editing.
 *
 * Noon when there was nothing, because midnight lands on the day before or
 * after as soon as another timezone reads it. Noon has twelve hours of slack
 * either way.
 */
export function fromDateInput(raw: string, previous: number | null = null): number | null {
  const [year, month, day] = raw.split("-").map(Number);
  if (!year || !month || !day) return null;

  const at = previous != null && Number.isFinite(previous) ? new Date(previous) : null;
  const ms = new Date(
    year,
    month - 1,
    day,
    at?.getHours() ?? 12,
    at?.getMinutes() ?? 0,
    at?.getSeconds() ?? 0,
    at?.getMilliseconds() ?? 0,
  ).getTime();
  return Number.isNaN(ms) ? null : ms;
}
