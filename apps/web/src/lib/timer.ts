import { createSignal } from "solid-js";
import { ApiError, api, type TimeEntry } from "./api.ts";
import { formatDuration } from "./format.ts";
import { pushToast } from "./toast.ts";

/**
 * The one timer this person has running, anywhere.
 *
 * Deliberately not in the task collection: a timer is not a task, and the
 * collection is keyed by task id with one row per task. This is one row per
 * *user*, which is why it gets a module of its own — the same reasoning that
 * gives `toast.ts` and `sse.ts` theirs.
 *
 * Nothing here is mirrored. ClickUp owns the running timer; this is a cache of
 * what it last told us, filled from three places: the read at app start, the
 * `timer` SSE event (which is how a second tab hears about the first one), and
 * the response to our own start and stop.
 */
const [running, setRunning] = createSignal<TimeEntry | null>(null);

export { running };

/**
 * Wall clock, ticking only while something is running.
 *
 * The elapsed time is `now() - entry.start`, recomputed, never accumulated. It
 * matters: a background tab has its intervals throttled to once a minute or
 * worse, and a counter that added a second per tick would silently fall behind
 * by however long the user was reading something else. Deriving it means a
 * throttled tab is merely coarse, and correct again the moment it is focused.
 *
 * ponytail: `now` is the browser's clock, so a machine whose clock is wrong
 * shows a wrong counter. The recorded interval is computed by ClickUp from its
 * own clock at start and stop, so the stored data is right either way and only
 * the display drifts. Worth fixing with a server-time offset the day somebody
 * reports it, not before.
 */
const [now, setNow] = createSignal(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

function tick(active: boolean): void {
  if (active && ticker === null) {
    setNow(Date.now());
    ticker = setInterval(() => setNow(Date.now()), 1000);
  } else if (!active && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** Replaces what we believe is running. The only writer of the signal. */
export function setRunningTimer(entry: TimeEntry | null): void {
  setRunning(entry);
  tick(entry !== null);
}

/** Milliseconds on the running timer right now, or null if nothing is running. */
export function elapsed(): number | null {
  const entry = running();
  if (!entry?.start) return null;
  return Math.max(0, now() - entry.start);
}

/** True when this task is the one being tracked. Drives the toggle and the row marker. */
export function isTracking(taskId: string): boolean {
  return running()?.taskId === taskId;
}

/** Reads ClickUp's answer once, at app start. Recovers a reload, and a timer
 * started on another device. A failure here is not worth a toast: the user did
 * not ask for anything, and the indicator simply stays empty. */
export async function hydrateTimer(): Promise<void> {
  try {
    const { entry } = await api.runningTimer();
    setRunningTimer(entry);
  } catch {
    setRunningTimer(null);
  }
}

/**
 * An interval that ended, said out loud.
 *
 * The toast is the only record anybody gets of a timer that stopped, and one of
 * the three ways to stop one is a side effect of starting another. `fallback`
 * covers the entry ClickUp returns with no task on it, which the higher plans
 * allow.
 */
function announceStop(stopped: TimeEntry | null, fallback?: string): void {
  if (!stopped) return;
  pushToast({
    tone: "info",
    title: `Stopped ${formatDuration(stopped.durationMs)}`,
    detail: stopped.taskName ?? fallback,
  });
}

/** Says what went wrong, then replaces the local guess with ClickUp's answer. */
function announceFailure(error: unknown, title: string): void {
  pushToast({
    tone: "error",
    title,
    detail: error instanceof ApiError ? error.message : undefined,
  });
  void hydrateTimer();
}

/**
 * Starts on a task, or stops if that task is already the one running.
 *
 * The toggle lives here rather than in the key handler so the palette command,
 * the detail button and `t` cannot drift apart. Starting elsewhere stops the
 * previous timer server-side, which is why the start path announces a stop too.
 */
export async function toggleTimer(task: { id: string; name: string }): Promise<void> {
  try {
    if (isTracking(task.id)) {
      const { stopped } = await api.stopTimer();
      setRunningTimer(null);
      announceStop(stopped, task.name);
      return;
    }

    const { started, stopped } = await api.startTimer(task.id);
    setRunningTimer(started);
    announceStop(stopped, "the timer that was running");
  } catch (error) {
    setRunningTimer(null);
    announceFailure(error, "Could not change the timer");
  }
}

/**
 * Stops whatever is running, from the indicator rather than from a task.
 *
 * Not routed through `toggleTimer`: ClickUp allows an entry with no task on the
 * higher plans, and a toggle keyed on a null task id would read as "not
 * tracking this" and try to start a timer on an empty string.
 */
export async function stopTimer(): Promise<void> {
  if (!running()) return;
  try {
    const { stopped } = await api.stopTimer();
    setRunningTimer(null);
    announceStop(stopped);
  } catch (error) {
    announceFailure(error, "Could not stop the timer");
  }
}
