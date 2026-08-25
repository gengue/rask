import { createSignal } from "solid-js";
import { api, type InboxRead, type InboxReason, type Task } from "./api.ts";
import { me, setMe } from "./session.ts";
import { loadPage, type TaskPageResult } from "./store.ts";
import { pushToast } from "./toast.ts";
import { viewIsFeed } from "./view.ts";

/**
 * What changed on your tasks while you were not looking.
 *
 * ClickUp has no notifications API — the v2 spec vendored in
 * `packages/clickup-client/openapi` has no endpoint for the inbox, its read
 * state, or an activity feed — so none of this is mirrored from upstream. It is
 * derived from what the mirror already holds: `tasks.date_updated` for when
 * something happened, `task_assignees` for whether it was yours, and one
 * timestamp per user for where you had read up to.
 *
 * Comments are the exception, and the reason they are worth their own path:
 * a comment *is* an event. It has an author, a body and a time, so a row backed
 * by one can say who said what — which is the sentence the task half cannot
 * form. `apps/api/src/queries.ts` has the three signals and their ranking.
 *
 * The rest is still the mirror's ceiling. For a task change the inbox can say
 * *that* it changed and show what it looks like now, but not what it changed
 * from, or who changed it. Saying "Ana moved this to Done" needs an event per
 * change, which needs the webhook `history_items` that `docs/webhooks.md`
 * deliberately ignores. Nothing here should ever grow a label it cannot back up.
 */

/**
 * How far back the inbox looks when you have been reading it.
 *
 * Only a floor. The window is always at least this wide so the page has
 * something to show the moment after you clear it, and wider whenever you have
 * been away longer — see `inboxCutoff`. Seven days because that is roughly the
 * span in which "did I miss anything" is still a question worth asking.
 */
export const INBOX_WINDOW_DAYS = 7;

const WINDOW_MS = INBOX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The instant you last opened the inbox, in epoch milliseconds. */
export function inboxSeenAt(): number {
  const seen = me()?.inboxSeenAt;
  // Before `/api/me` lands there is no answer, and "everything is unread" is
  // the wrong guess to make on a badge. Nothing is, until we know.
  return seen ? Date.parse(seen) : Date.now();
}

/**
 * The oldest change the inbox loads.
 *
 * The earlier of "a week ago" and "your last visit", so the loaded set is
 * always a superset of the unread one. If it were just the window, a fortnight
 * away would leave the badge counting rows the page never fetched; if it were
 * just the visit, clearing the inbox would leave a blank page.
 */
export function inboxCutoff(): number {
  return cutoffFrom(inboxSeenAt(), Date.now());
}

/** `inboxCutoff` without the clock or the session, so it can be checked. */
export function cutoffFrom(seenAt: number, now: number): number {
  return Math.min(seenAt, now - WINDOW_MS);
}

/**
 * What the feed is showing: only what is new, or the window behind it.
 *
 * Unread by default, because an inbox you cannot empty is not an inbox. The
 * other scope exists so clearing is not destruction — the thing you just marked
 * read is one click away rather than gone until somebody touches it again.
 */
export const [inboxScope, setInboxScope] = createSignal<"unread" | "window">("unread");

/**
 * The instant the unread dots measure from, or null when nothing is measuring.
 *
 * Read by the rows rather than passed to them: they render through a windowed
 * `<Index>`, and threading an inbox-shaped flag through the list would put it
 * on every view that has nothing to do with the inbox. Null off the feed, so
 * the dot is off by construction rather than by whoever remembers `false`.
 *
 * Derived rather than captured. It used to be frozen on mount because arriving
 * marked the inbox read and the dots would have cleared in the frame that drew
 * them — but arriving no longer marks anything, so this can follow the read
 * mark directly, and pressing Mark all read clears the dots in the same frame.
 * That *is* the feedback that the button did something.
 */
export function unreadSince(): number | null {
  return viewIsFeed() ? inboxSeenAt() : null;
}

/** Whether a task changed after `seenAt`. Both in epoch milliseconds. */
export function isUnread(task: Task, seenAt: number): boolean {
  return task.dateUpdated !== null && Date.parse(task.dateUpdated) > seenAt;
}

/**
 * What was said, keyed by task. Empty until a window has been read.
 *
 * The server picks one comment per task, so this is a map rather than a list:
 * the feed is still a feed of tasks, and the reason is what a row says about
 * itself.
 */
export const [reasons, setReasons] = createSignal<ReadonlyMap<string, InboxReason>>(new Map());

/** What was said on this task, if anything was. */
export function reasonFor(taskId: string): InboxReason | undefined {
  return reasons().get(taskId);
}

/**
 * Entries dismissed one at a time, keyed by task.
 *
 * An exception list over `inboxSeenAt`, not a replacement for it: the watermark
 * answers "everything up to here" and these answer "and this one too". Marking
 * the whole inbox read passes every one of them, which is why the server drops
 * them in the same transaction rather than letting the table grow forever.
 */
export const [reads, setReads] = createSignal<ReadonlyMap<string, string>>(new Map());

/**
 * The instant this task's entry is measured from.
 *
 * The later of the watermark and your own dismissal, so a row you cleared stays
 * cleared until something happens after you cleared it — and a second comment
 * on the same task does bring it back, because it is newer than both.
 */
export function markFor(taskId: string, since: number): number {
  const readAt = reads().get(taskId);
  const dismissed = readAt ? Date.parse(readAt) : Number.NaN;
  return Number.isNaN(dismissed) ? since : Math.max(since, dismissed);
}

/**
 * Marks one entry read, on screen before the server has answered.
 *
 * Optimistic because the row leaves the unread scope the moment this resolves,
 * and a click that does nothing for a round trip reads as a click that missed.
 * The rollback puts the row back rather than leaving it quietly gone.
 */
export async function markTaskRead(taskId: string): Promise<void> {
  const before = reads();
  setReads(new Map(before).set(taskId, new Date().toISOString()));
  try {
    const { readAt } = await api.markTaskRead(taskId);
    // The server's instant, which is the one the watermark is compared against.
    setReads(new Map(reads()).set(taskId, readAt));
  } catch (error) {
    setReads(before);
    pushToast({
      tone: "error",
      title: "Could not mark that as read",
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Yours, and changed since `since`. The page and the badge share this.
 *
 * Built on `isUnread` rather than repeating it, because the badge counts what
 * this keeps and the dots are drawn by that: two spellings of "changed since"
 * is two chances for a row to be counted and not marked, or the reverse.
 *
 * Archived rows are dropped here and not only by the server. They arrive
 * anyway — the change feed deliberately carries archives so open clients can
 * reconcile (`apps/api/src/changes.ts`) — and the page is a server read that
 * excludes them, so without this the badge counts entries the list will not
 * show and never reaches zero.
 *
 * `!userId` lets everything through, the same bargain My Tasks makes: before
 * `/api/me` answers, showing what the server already sent beats showing
 * nothing. The server filtered by assignee too, so the set is right; this is
 * only what keeps a row that arrives over SSE in the meantime from being taken
 * for somebody else's.
 */
export function inboxPredicate(userId: string | undefined, since: number): (task: Task) => boolean {
  const said = reasons();
  return (task) => {
    if (task.archived) return false;

    /*
     * A comment puts a task in the feed on its own, whoever the task belongs
     * to. That is the whole point of the mention signal: somebody pulled you
     * into a task that is not yours, and an assignee check would drop exactly
     * that row.
     */
    // The watermark, raised by your own dismissal of this row if there was one.
    const mark = markFor(task.id, since);

    const reason = said.get(task.id);
    // `latestAt`, not `at`: the row shows the strongest reason and this asks
    // whether anything at all was said since you looked. A mention from Tuesday
    // under this morning's "ok" is both.
    const latest = reason?.latestAt ?? reason?.at;
    if (latest && Date.parse(latest) > mark) return true;

    return (
      isUnread(task, mark) && (!userId || task.assignees.some((assignee) => assignee.id === userId))
    );
  };
}

/**
 * Whether this row is new to you, as the rows themselves ask it.
 *
 * The same predicate the page and the badge run, at the read mark rather than
 * at whichever scope is on screen — so the dot, the count and the list can
 * never disagree about what "unread" means. The assignee gate is skipped
 * because a row that is already on screen has passed it.
 */
export function isRowUnread(task: Task): boolean {
  const since = unreadSince();
  return since !== null && inboxPredicate(undefined, since)(task);
}

/**
 * Whether the last window read hit the server's row cap.
 *
 * The badge counts rows in the shared collection, so a window wider than one
 * page of it is a count that stops short and looks exact. The header beside a
 * truncated view already says "500+" for the same reason; this is that "+".
 */
export const [inboxTruncated, setInboxTruncated] = createSignal(false);

/**
 * When the feed last had something to say about this task.
 *
 * The conversation's clock where there is one, the task's otherwise. A mention
 * on a task nobody has touched in a fortnight belongs at the top of the feed on
 * the strength of the mention, not at the bottom on the strength of the task.
 */
export function entryAt(task: Task, reason: InboxReason | undefined): number {
  const at = reason?.latestAt ?? reason?.at ?? task.dateUpdated;
  return at ? Date.parse(at) : 0;
}

/** Newest first, by what the feed is about. Takes the reasons explicitly so it
 *  stays a pure function of its arguments. */
export function byEntryTime(said: ReadonlyMap<string, InboxReason>) {
  return (a: Task, b: Task) => entryAt(b, said.get(b.id)) - entryAt(a, said.get(a.id));
}

/**
 * The order the feed is holding, by task id.
 *
 * Chronological when it is built, and then frozen. That second half is the
 * point: `date_updated` moves for anything that touches a task — a status
 * change, a comment, ClickUp recording a minute of tracked time — and a list
 * that re-sorted on every one of those would slide a row out from under the
 * pointer that was about to click it. Worse, the window renders through an
 * `<Index>` keyed by position, so one row moving to the top rebuilds every row
 * above where it was: measured at 41 nodes on a 12-row screen, which is the
 * whole page flickering because somebody pressed start on a timer.
 *
 * Not a signal. Only the effect that builds the row list reads or writes it,
 * and that effect already re-runs on the rows themselves.
 */
let feedOrder = new Map<string, number>();
/** Ranks count down, so anything arriving later sorts above what is placed. */
let feedTop = 0;

/** Forgets the order. The feed re-seeds on its next load, so holding ranks for
 *  a page nobody is looking at is only a way to be wrong about it later. */
export function resetFeedOrder(): void {
  feedOrder = new Map();
  feedTop = 0;
}

/** Lays out the window the server just sent. The order everything else keeps. */
function seedFeedOrder(tasks: Task[], said: ReadonlyMap<string, InboxReason>): void {
  resetFeedOrder();
  for (const task of [...tasks].sort(byEntryTime(said))) feedOrder.set(task.id, feedTop++);
}

/**
 * Sorts rows into the order the feed is holding.
 *
 * A row nobody has placed yet arrived while you were reading — over SSE, or
 * because you switched scope — and goes on top, newest of them first. It keeps
 * that place until the next load, so the feed grows upwards instead of
 * reshuffling.
 */
export function inFeedOrder(rows: Task[]): Task[] {
  const said = reasons();
  const arrived = rows.filter((task) => !feedOrder.has(task.id)).sort(byEntryTime(said));
  // Backwards, so the newest arrival ends up with the smallest rank.
  for (let i = arrived.length - 1; i >= 0; i--) {
    const task = arrived[i];
    if (task) feedOrder.set(task.id, --feedTop);
  }
  return [...rows].sort((a, b) => (feedOrder.get(a.id) ?? 0) - (feedOrder.get(b.id) ?? 0));
}

/**
 * Pulls the window into the shared collection, and what was said with it.
 *
 * Closed tasks included: somebody finishing your task is the change you most
 * want to hear about, and it is the one an open-tasks-only read drops.
 *
 * Called at boot rather than only by the route, because the badge counts rows
 * from the same collection everything else reads. Without this the count would
 * be of whatever the open view happened to have loaded, which is a number that
 * looks authoritative and is not.
 */
let windowReads = 0;

export async function loadInbox(since = inboxCutoff()): Promise<TaskPageResult | null> {
  let latest: InboxReason[] = [];
  let dismissed: InboxRead[] = [];
  let window: Task[] = [];
  let truncated = false;

  const reading = ++windowReads;
  const page = await loadPage("Could not load the inbox", async () => {
    const answer = await api.inbox(since);
    latest = answer.reasons;
    dismissed = answer.reads;
    window = answer.tasks;
    truncated = answer.truncated;
    return answer;
  });

  /*
   * Ordered against the other window reads, not against the view.
   *
   * `loadPage` answers null once any later load has taken over the main panel,
   * which is the right question for "are these the rows on screen" and the
   * wrong one for these four. The boot read runs beside whichever route was
   * opened, so on a slow enough machine the route's load lands second and the
   * window's reasons were thrown away with a page nobody was going to render
   * anyway — leaving the badge blind to every row that is in the feed for a
   * comment rather than for an assignment. It undercounted by exactly those
   * rows, which is a number that looks authoritative and is not.
   */
  if (reading === windowReads) {
    const said = new Map(latest.map((reason) => [reason.taskId, reason]));
    setReasons(said);
    setReads(new Map(dismissed.map((read) => [read.taskId, read.readAt])));
    // Seeded from every task the window carried, not from the ones currently on
    // screen: switching to the other scope brings back rows that were filtered
    // out, and they belong where they were rather than on top as arrivals.
    seedFeedOrder(window, said);
    setInboxTruncated(truncated);
  }
  return page;
}

/**
 * Marks everything up to now as read.
 *
 * Pressed, never automatic. Arriving used to do this, which meant a glance at
 * the inbox silently cleared things nobody had read and left no control to undo
 * or repeat it — the badge went quiet and the list did not change, so there was
 * nothing on screen that looked like clearing.
 *
 * The instant is the server's, not ours: it is the one that gets stored, and a
 * browser whose clock runs fast would otherwise mark unread things it never
 * showed anybody.
 */
export async function markInboxSeen(): Promise<void> {
  const { inboxSeenAt: seenAt } = await api.markInboxSeen();
  const user = me();
  if (user) setMe({ ...user, inboxSeenAt: seenAt });
}
