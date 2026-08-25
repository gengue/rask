import { expect, test } from "@playwright/test";

/**
 * The inbox, end to end: a count, a page, and a read mark that survives.
 *
 * The unit tests cover what the window contains. What they cannot cover is the
 * part that spans three layers — the badge counts rows from the same collection
 * the page filters, and clearing it is a write to Postgres rather than a signal
 * in the tab. Everything here would still pass a suite that stubbed the API,
 * and none of it would work.
 *
 * Clearing is pressed, not implied. Arriving used to mark everything read,
 * which cleared things nobody had read and left nothing on screen that looked
 * like clearing had happened.
 *
 * The fixture makes every task look freshly changed: `seed-dev` inserts the
 * user before the tasks, so `inbox_seen_at` defaults to an instant just before
 * every `date_updated` it then writes. That is the state the feature is for.
 */
test("counts what changed, then clears it for good", async ({ page }) => {
  // Wide enough for the sidebar to be in flow rather than a drawer (--breakpoint-dock).
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto("/__dev-login");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();

  /*
   * What the count has to be, asked of the server directly.
   *
   * A number is the wrong thing to assert loosely. The badge is a live count
   * over the shared collection, so "some digits appeared" passes just as well
   * for a count of whatever the open view happened to fetch — which is exactly
   * what it would be if the shell stopped loading the inbox window at boot. A
   * badge that undercounts is worse than no badge.
   */
  const session = await page.request.get("/api/me").then((response) => response.json());
  const window = await page.request
    .get(`/api/inbox?since=${Date.parse(session.inboxSeenAt)}&limit=1000`)
    .then((response) => response.json());
  const unread = window.tasks;
  expect(unread.length).toBeGreaterThan(0);
  // The fixture has to contain the thing the second test is about, or that test
  // passes by finding nothing and asserting nothing.
  expect(window.reasons.some((r: { kind: string }) => r.kind === "mention")).toBe(true);

  // Booted straight into a list, which fills that collection with the list
  // rather than with your tasks. Asserting this from My Tasks would pass either
  // way, because My Tasks fetches the same rows on its way in.
  await page.goto("/list/L1");
  await expect(
    page.getByRole("listbox", { name: "Tasks" }).getByRole("option").first(),
  ).toBeVisible();

  const inbox = page.getByRole("link", { name: /^Inbox/ });
  await expect(inbox).toBeVisible();
  await expect(inbox).toHaveText(`Inbox${unread.length}`);

  await inbox.click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

  const list = page.getByRole("listbox", { name: "Tasks" });
  await expect(list.getByRole("option").first()).toBeVisible();

  /*
   * Exactly one fixed destination is marked, and it is this one.
   *
   * `matchRoute` used to answer true for both on every route, so My Tasks and
   * Inbox were drawn selected at the same time — and while looking at a list,
   * neither of them was where you were. One link always marked reads as "you
   * are here"; two read as a bug.
   */
  const marked = page.locator("aside nav a.row-selected");
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveAttribute("href", "/inbox");

  // Arriving changes nothing. The count is still the count and the rows are
  // still unread, which is what makes the button below mean something.
  await expect(inbox).toHaveText(`Inbox${unread.length}`);
  await expect(list.getByText("Unread.").first()).toBeVisible();

  /*
   * One row first, on its own.
   *
   * The per-row mark and the bulk one are different writes against different
   * tables, and the bulk one deletes what the per-row one wrote. Asserting only
   * the bulk button would leave a dismissal that never survived a reload
   * looking exactly like one that did.
   */
  const first = list.getByRole("option").first();
  const firstId = await first.getAttribute("id");
  await first.getByRole("button", { name: /^Mark ".*" as read$/ }).click({ force: true });

  await expect(page.locator(`#${firstId}`)).toHaveCount(0);
  await expect(inbox).toHaveText(`Inbox${unread.length - 1}`);

  // It went to Postgres, not to a signal in the tab.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.locator(`#${firstId}`)).toHaveCount(0);
  await expect(inbox).toHaveText(`Inbox${unread.length - 1}`);

  await page.getByRole("button", { name: "Mark all read" }).click();

  // Emptied, not merely dimmed. The unread scope is the default precisely so
  // that clearing has somewhere visible to land.
  await expect(list.getByRole("option")).toHaveCount(0);
  await expect(page.getByText("You are caught up")).toBeVisible();
  await expect(inbox).toHaveText("Inbox");
  // And nothing left to press.
  await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(0);

  // Away and back, and a reload. The read mark went to Postgres, so this is a
  // fresh read of it rather than a signal that happens to still be in the tab.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
  await expect(inbox).toHaveText("Inbox");

  await page.reload();
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
  await expect(inbox).toHaveText("Inbox");

  /*
   * Cleared is not destroyed.
   *
   * The window scope is what stops Mark all read from being a one-way door: the
   * rows are still there, just no longer new. Without it the only way back to
   * something you cleared is remembering which task it was on.
   */
  await inbox.click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("You are caught up")).toBeVisible();

  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await expect(list.getByRole("option").first()).toBeVisible();
  await expect(list.getByText("Unread.")).toHaveCount(0);
});

/**
 * The half a task row cannot say.
 *
 * Tier A can report that a task changed. This is the row that reports what
 * somebody actually wrote, which is the only kind of inbox entry you can act on
 * without opening anything — and the only one that can carry a name.
 */
test("shows who said what, and opens the task they said it on", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto("/__dev-login");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();

  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

  /*
   * The window scope, because the test above cleared the inbox and the database
   * is shared across this file. Switching is the honest fix rather than
   * reordering: what this test is about is the shape of a comment row, not
   * whether the row is new, and a suite that depends on the order it runs in is
   * a suite that breaks the day somebody adds a test above it.
   */
  await page.getByRole("button", { name: "Unread", exact: true }).click();

  const list = page.getByRole("listbox", { name: "Tasks" });
  await expect(list.getByRole("option").first()).toBeVisible();

  // The glyph is the ranking made visible: three signals that need three
  // different amounts of attention.
  const mention = list.getByRole("option").filter({ has: page.getByLabel("Mentioned you") });
  await expect(mention.first()).toBeVisible();

  // A comment row is a sentence, so it has to carry an author and words.
  const row = mention.first();
  const taskId = await row.getAttribute("id");
  expect(taskId).toBeTruthy();
  await expect(row).toContainText(":");

  /*
   * And it still opens the task, which is the reason the feed is a feed of
   * tasks wearing two row shapes rather than a second kind of thing with its
   * own navigation.
   */
  await row.click();
  const detail = page.getByRole("complementary", { name: "Task detail" });
  await expect(detail).toBeVisible();
  expect(page.url()).toContain(`task=${taskId?.replace("task-", "")}`);
});
