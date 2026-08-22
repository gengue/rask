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

export function initialsOf(name: string | null, fallback: string | null): string {
  if (fallback) return fallback.slice(0, 2).toUpperCase();
  if (!name) return "?";
  const parts = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};
