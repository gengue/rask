import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { InboxReason, Task } from "../src/lib/api.ts";
import {
  byEntryTime,
  cutoffFrom,
  INBOX_WINDOW_DAYS,
  inboxPredicate,
  inFeedOrder,
  isUnread,
  markFor,
  resetFeedOrder,
  setReads,
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

describe("dismissing one entry", () => {
  const since = now - 10 * DAY;

  afterEach(() => setReads(new Map()));

  test("takes the later of the watermark and your own dismissal", () => {
    // The watermark answers "everything up to here"; a dismissal answers "and
    // this one too". Taking the earlier of the two would make Mark all read
    // un-dismiss whatever you had already cleared past it.
    setReads(new Map([["a", ago(2)]]));

    expect(markFor("a", since)).toBe(Date.parse(ago(2)));
    expect(markFor("b", since)).toBe(since);
  });

  test("never moves the mark backwards", () => {
    // A dismissal older than the watermark is already covered by it, and the
    // server deletes those — but a clock that disagrees must not resurrect a
    // row either.
    setReads(new Map([["a", ago(30)]]));

    expect(markFor("a", since)).toBe(since);
  });

  test("drops a row you cleared", () => {
    setReads(new Map([["a", ago(0.5)]]));

    expect(inboxPredicate(ANNA, since)(task({ id: "a", dateUpdated: ago(1) }))).toBe(false);
  });

  test("brings it back when something happens after you cleared it", () => {
    /*
     * The difference between "I have seen this" and "never show me this task
     * again". A second comment lands after the dismissal and the row is new
     * again — which is why this is a timestamp and not a flag.
     */
    setReads(new Map([["a", ago(2)]]));

    expect(inboxPredicate(ANNA, since)(task({ id: "a", dateUpdated: ago(1) }))).toBe(true);
  });

  test("drops a comment row you cleared, and returns it on the next comment", () => {
    // Same rule on the other branch of the predicate: what was said is measured
    // against the same mark as what changed.
    const bens = task({
      id: "a",
      dateUpdated: ago(30),
      assignees: [{ id: BEN, username: "ben", initials: "B", color: null, avatar: null }],
    });
    setReasons(
      new Map([
        [
          "a",
          {
            taskId: "a",
            commentId: "c1",
            kind: "mention" as const,
            authorId: BEN,
            authorName: "ben",
            authorAvatar: null,
            excerpt: "have a look",
            at: ago(3),
            latestAt: ago(3),
          },
        ],
      ]),
    );

    setReads(new Map([["a", ago(2)]]));
    expect(inboxPredicate(ANNA, since)(bens)).toBe(false);

    setReads(new Map([["a", ago(4)]]));
    expect(inboxPredicate(ANNA, since)(bens)).toBe(true);

    setReasons(new Map());
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

describe("byEntryTime", () => {
  const none = new Map<string, InboxReason>();

  test("sorts newest change first", () => {
    const rows = [
      task({ id: "old", dateUpdated: ago(5) }),
      task({ id: "new", dateUpdated: ago(1) }),
      task({ id: "middle", dateUpdated: ago(3) }),
    ];

    expect([...rows].sort(byEntryTime(none)).map((row) => row.id)).toEqual([
      "new",
      "middle",
      "old",
    ]);
  });

  test("puts a fresh mention above a task that merely changed more recently", () => {
    /*
     * A mention lands on a task nobody has touched in a fortnight. It belongs
     * at the top on the strength of the mention, not at the bottom on the
     * strength of the task — sorting by `date_updated` alone buries exactly the
     * row somebody was addressed in.
     */
    const said = new Map<string, InboxReason>([
      [
        "mentioned",
        {
          taskId: "mentioned",
          commentId: "c1",
          kind: "mention",
          authorId: BEN,
          authorName: "ben",
          authorAvatar: null,
          excerpt: "have a look",
          at: ago(0.5),
          latestAt: ago(0.5),
        },
      ],
    ]);
    const rows = [
      task({ id: "touched", dateUpdated: ago(1) }),
      task({ id: "mentioned", dateUpdated: ago(14) }),
    ];

    expect([...rows].sort(byEntryTime(said)).map((row) => row.id)).toEqual([
      "mentioned",
      "touched",
    ]);
  });
});

describe("inFeedOrder", () => {
  // The order is module state on purpose — only the effect that builds the row
  // list touches it — so each test here starts from an empty feed rather than
  // from whatever the one above it placed.
  beforeEach(() => resetFeedOrder());
  afterEach(() => setReasons(new Map()));

  test("keeps a row where it was when its task changes underneath it", () => {
    /*
     * The blink. `date_updated` moves for anything that touches a task — a
     * status change, a comment, ClickUp recording a minute of tracked time —
     * and the window renders through an `<Index>` keyed by position, so one row
     * jumping to the top rebuilds every row above where it was. Measured at 41
     * removed nodes on a 12-row screen: the whole page, because somebody
     * pressed start on a timer.
     */
    const rows = [
      task({ id: "a", dateUpdated: ago(1) }),
      task({ id: "b", dateUpdated: ago(2) }),
      task({ id: "c", dateUpdated: ago(3) }),
    ];
    expect(inFeedOrder(rows).map((row) => row.id)).toEqual(["a", "b", "c"]);

    const poked = rows.map((row) => (row.id === "c" ? task({ ...row, dateUpdated: ago(0) }) : row));
    expect(inFeedOrder(poked).map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  test("puts a row nobody has placed on top", () => {
    // An SSE arrival while you are reading. The feed grows upwards; it does not
    // reshuffle to make room.
    inFeedOrder([task({ id: "a", dateUpdated: ago(2) })]);

    const withArrival = [
      task({ id: "a", dateUpdated: ago(2) }),
      task({ id: "fresh", dateUpdated: ago(0) }),
    ];
    expect(inFeedOrder(withArrival).map((row) => row.id)).toEqual(["fresh", "a"]);
  });

  test("orders several arrivals among themselves, newest first", () => {
    const rows = [
      task({ id: "older", dateUpdated: ago(2) }),
      task({ id: "newer", dateUpdated: ago(1) }),
    ];

    expect(inFeedOrder(rows).map((row) => row.id)).toEqual(["newer", "older"]);
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
