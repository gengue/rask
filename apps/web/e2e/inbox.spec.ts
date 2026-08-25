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
  const unread = await page.request
    .get(
      `/api/tasks?assignee=me&closed=1&limit=1000&updatedSince=${Date.parse(session.inboxSeenAt)}`,
    )
    .then((response) => response.json());
  expect(unread.length).toBeGreaterThan(0);

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
