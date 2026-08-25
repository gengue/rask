import { createSignal } from "solid-js";
import { api, type InboxReason, type Task } from "./api.ts";
import { me, setMe } from "./session.ts";
import { loadPage, type TaskPageResult } from "./store.ts";

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
 * The instant the unread dots measure from, or null when nothing is measuring.
 *
 * Read by `TaskRow`, which is why this is a signal rather than a prop: the row
 * is rendered through a windowed `<Index>` and threading a flag from the route
 * through the list to it would put an inbox-shaped argument on every view that
 * has nothing to do with the inbox. Null everywhere but the inbox, so the dot
 * is off by construction rather than by whoever remembers to pass `false`.
 *
 * It is captured when the route mounts and does not follow `inboxSeenAt`,
 * because opening the inbox is what marks it read: read from the user's record
 * the dots would all clear in the same frame that drew them.
 */
export const [unreadSince, setUnreadSince] = createSignal<number | null>(null);

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
    const reason = said.get(task.id);
    // `latestAt`, not `at`: the row shows the strongest reason and this asks
    // whether anything at all was said since you looked. A mention from Tuesday
    // under this morning's "ok" is both.
    const latest = reason?.latestAt ?? reason?.at;
    if (latest && Date.parse(latest) > since) return true;

    return (
      isUnread(task, since) &&
      (!userId || task.assignees.some((assignee) => assignee.id === userId))
    );
  };
}

/**
 * Whether the last window read hit the server's row cap.
 *
 * The badge counts rows in the shared collection, so a window wider than one
 * page of it is a count that stops short and looks exact. The header beside a
 * truncated view already says "500+" for the same reason; this is that "+".
 */
export const [inboxTruncated, setInboxTruncated] = createSignal(false);

/** Newest change first. A feed is read in the order things happened. */
export function byRecency(a: Task, b: Task): number {
  return Date.parse(b.dateUpdated ?? "") - Date.parse(a.dateUpdated ?? "");
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
export async function loadInbox(since = inboxCutoff()): Promise<TaskPageResult | null> {
  let latest: InboxReason[] = [];

  const page = await loadPage("Could not load the inbox", async () => {
    const answer = await api.inbox(since);
    latest = answer.reasons;
    return answer;
  });

  // Null means a newer load superseded this one, and its reasons are the stale
  // half of the same answer. Leave both to whichever load lands last.
  if (page) {
    setReasons(new Map(latest.map((reason) => [reason.taskId, reason])));
    setInboxTruncated(page.truncated);
  }
  return page;
}

/**
 * Marks everything up to now as read.
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
