import { afterEach, describe, expect, test } from "bun:test";
import type { InboxReason, Task } from "../src/lib/api.ts";
import {
  byRecency,
  cutoffFrom,
  INBOX_WINDOW_DAYS,
  inboxPredicate,
  isUnread,
  setReasons,
} from "../src/lib/inbox.ts";

/**
 * What the inbox shows, as arithmetic.
 *
 * Pure functions on purpose: the page, the unread dot and the sidebar badge all
 * have to agree on "yours, and changed since" or the count says one thing and
 * the list shows another. One definition, three readers, and this is where it
 * is checked.
 */

const DAY = 86_400_000;
const now = Date.parse("2026-08-25T12:00:00.000Z");
const ago = (days: number) => new Date(now - days * DAY).toISOString();

const ANNA = "u-anna";
const BEN = "u-ben";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    customId: null,
    name: "A task",
    status: "Open",
    statusColor: null,
    statusType: "open",
    priority: null,
    dueDate: null,
    startDate: null,
    dateUpdated: ago(1),
    dateCreated: ago(30),
    listId: "list",
    spaceId: null,
    parentId: null,
    tags: [],
    url: null,
    listName: null,
    deletedAt: null,
    archived: false,
    assignees: [{ id: ANNA, username: "anna", initials: "A", color: null, avatar: null }],
    ...overrides,
  };
}

describe("inboxPredicate", () => {
  const since = now - 2 * DAY;

  test("keeps a task of yours that changed after the cutoff", () => {
    expect(inboxPredicate(ANNA, since)(task({ id: "a", dateUpdated: ago(1) }))).toBe(true);
  });

  test("drops a change older than the cutoff", () => {
    expect(inboxPredicate(ANNA, since)(task({ id: "a", dateUpdated: ago(3) }))).toBe(false);
  });

  test("drops somebody else's task", () => {
    const bens = task({
      id: "a",
      assignees: [{ id: BEN, username: "ben", initials: "B", color: null, avatar: null }],
    });

    expect(inboxPredicate(ANNA, since)(bens)).toBe(false);
  });

  test("drops an archived task, which the page would not have shown either", () => {
    /*
     * These arrive whether or not the page asked for them: the change feed
     * carries archives on purpose so open clients can reconcile, and the
     * collection keeps them. The inbox page is a server read that excludes
     * them, so counting one here is a badge that will not go down however many
     * times you visit.
     */
    const archived = task({ id: "a", archived: true, dateUpdated: ago(1) });

    expect(inboxPredicate(ANNA, since)(archived)).toBe(false);
  });

  test("drops a task with no date_updated rather than counting it as new", () => {
    // `Date.parse(null)` is NaN and every comparison against NaN is false, but
    // only because the null is checked first. This is the assertion that says
    // so, because the badge counting untimestamped rows is invisible until
    // somebody wonders why it never reaches zero.
    expect(inboxPredicate(ANNA, since)(task({ id: "a", dateUpdated: null }))).toBe(false);
  });

  test("keeps everything assigned when we do not yet know who is asking", () => {
    // Deep-linking to /inbox mounts before /api/me answers. The server already
    // filtered by assignee, so showing its rows beats showing an empty page.
    const bens = task({
      id: "a",
      assignees: [{ id: BEN, username: "ben", initials: "B", color: null, avatar: null }],
    });

    expect(inboxPredicate(undefined, since)(bens)).toBe(true);
  });
});

describe("inboxPredicate, with something said", () => {
  const since = now - 2 * DAY;

  const reason = (over: Partial<InboxReason> = {}): InboxReason => ({
    taskId: "a",
    commentId: "c1",
    kind: "mention",
    authorId: BEN,
    authorName: "ben",
    authorAvatar: null,
    excerpt: "have a look at this",
    at: ago(1),
    latestAt: ago(1),
    ...over,
  });

  const bensTask = () =>
    task({
      id: "a",
      // Stale, and not yours. Nothing but the comment can put it in the feed.
      dateUpdated: ago(30),
      assignees: [{ id: BEN, username: "ben", initials: "B", color: null, avatar: null }],
    });

  afterEach(() => setReasons(new Map()));

  test("keeps a mention on somebody else's task", () => {
    /*
     * The case Tier B exists for. Somebody pulled you into a task that is not
     * yours and whose own clock has not moved in a month — an assignee check or
     * an mtime check would each drop it on its own.
     */
    setReasons(new Map([["a", reason()]]));

    expect(inboxPredicate(ANNA, since)(bensTask())).toBe(true);
  });

  test("drops it once the window has moved past what was said", () => {
    setReasons(new Map([["a", reason({ at: ago(10), latestAt: ago(10) })]]));

    expect(inboxPredicate(ANNA, since)(bensTask())).toBe(false);
  });

  test("keeps it when the shown line is old but the conversation is not", () => {
    /*
     * The row shows the strongest reason, which can be a mention from last
     * week; unread is about the latest thing said, which can be this morning.
     * Reading unread off the shown line marks a moving thread as read and the
     * badge counts one fewer than the window it is counting.
     */
    setReasons(new Map([["a", reason({ at: ago(10), latestAt: ago(1) })]]));

    expect(inboxPredicate(ANNA, since)(bensTask())).toBe(true);
  });

  test("drops it when the task is archived, reason or not", () => {
    // The page is a server read that excludes archived tasks, so counting one
    // here is a badge that will not go down however many times you visit.
    setReasons(new Map([["a", reason()]]));

    expect(inboxPredicate(ANNA, since)(task({ ...bensTask(), archived: true }))).toBe(false);
  });

  test("still keeps your own changed task with nothing said on it", () => {
    // The Tier A half has to survive the Tier B one being empty.
    expect(inboxPredicate(ANNA, since)(task({ id: "b", dateUpdated: ago(1) }))).toBe(true);
  });
});

describe("isUnread", () => {
  test("is exclusive at the mark, so reading the inbox twice clears it", () => {
    // A task changed at exactly the instant we marked it read is read. `>=`
    // here leaves one row that never stops being new.
    const seenAt = Date.parse(ago(1));

    expect(isUnread(task({ id: "a", dateUpdated: ago(1) }), seenAt)).toBe(false);
    expect(isUnread(task({ id: "a", dateUpdated: ago(0.5) }), seenAt)).toBe(true);
  });
});

describe("byRecency", () => {
  test("sorts newest change first", () => {
    const rows = [
      task({ id: "old", dateUpdated: ago(5) }),
      task({ id: "new", dateUpdated: ago(1) }),
      task({ id: "middle", dateUpdated: ago(3) }),
    ];

    expect([...rows].sort(byRecency).map((row) => row.id)).toEqual(["new", "middle", "old"]);
  });
});

describe("cutoffFrom", () => {
  const window = INBOX_WINDOW_DAYS * DAY;

  test("reaches back a week for somebody who just read it", () => {
    // Otherwise arriving a second after marking it read shows an empty page,
    // and the feature reads as broken the very first time it works.
    expect(cutoffFrom(now, now)).toBe(now - window);
  });

  test("reaches back further for somebody who has been away longer", () => {
    // The badge counts everything since the last visit. If the window did not
    // widen to match, it would count rows the page never loaded — a number
    // beside a list that does not contain them.
    const away = now - 30 * DAY;

    expect(cutoffFrom(away, now)).toBe(away);
  });

  test("never narrows below the window", () => {
    // A read mark in the future — a clock skew, a bad clock on a device that
    // wrote it — must not be able to empty the page.
    expect(cutoffFrom(now + 10 * DAY, now)).toBe(now - window);
  });
});
