import { afterEach, expect, test } from "bun:test";
import { api, type InboxPage, type TaskPage } from "../src/lib/api.ts";
import { loadInbox, reasons, setReasons } from "../src/lib/inbox.ts";
import { load } from "../src/lib/store.ts";

/**
 * The window's reasons outlive the view moving on without them.
 *
 * `loadInbox` runs at boot beside whichever route was opened, and `loadPage`
 * answers null to whichever of the two is no longer the newest. That is the
 * right answer to "are these the rows on screen" and the wrong one to "is this
 * what was said": dropped, the badge stops counting every task that is in the
 * feed for a comment rather than for an assignment, and undercounts by exactly
 * those rows without ever looking wrong.
 *
 * Found on a CI runner slow enough to land the two loads in the other order —
 * `Expected: "Inbox29"`, `Received: "Inbox20"` — which no machine here has
 * managed. The e2e case that caught it cannot be made to reproduce it on
 * demand, so the ordering is pinned from this side instead.
 */

const realInbox = api.inbox;
const realTasks = api.tasks;

afterEach(() => {
  api.inbox = realInbox;
  api.tasks = realTasks;
  setReasons(new Map());
});

test("keeps what was said when a view load lands after the window read", async () => {
  let deliver!: (page: InboxPage) => void;
  api.inbox = () => new Promise<InboxPage>((resolve) => (deliver = resolve));

  const window = loadInbox(0);

  // The route's own load, started second: it takes the view ticket, so the
  // window read above can only come back null however fast it answers.
  api.tasks = async (): Promise<TaskPage> => ({ tasks: [], truncated: false });
  await load({ list: "L1" });

  deliver({
    tasks: [],
    truncated: false,
    reads: [],
    reasons: [
      {
        taskId: "t1",
        commentId: "c1",
        kind: "mention",
        authorId: "u2",
        authorName: "Ada",
        authorAvatar: null,
        excerpt: "have a look",
        at: "2026-01-01T00:00:00.000Z",
        latestAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });

  expect(await window).toBeNull();
  expect(reasons().get("t1")?.kind).toBe("mention");
});
