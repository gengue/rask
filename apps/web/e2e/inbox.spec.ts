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

  // Arriving marks it read, but the dots hold: the instant they measure from is
  // captured before the write, so the page does not blank itself as you look.
  await expect(list.getByText("Unread.").first()).toBeVisible();
  await expect(inbox).toHaveText("Inbox");

  // Away and back. The read mark went to Postgres, so this is a fresh read of
  // it rather than a signal that happens to still be in the tab.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
  await expect(inbox).toHaveText("Inbox");

  await page.reload();
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
  await expect(inbox).toHaveText("Inbox");

  // The page itself still has something on it. The window reaches back a week
  // whatever the read mark says, which is what stops a cleared inbox from
  // reading as a broken one.
  await inbox.click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
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
