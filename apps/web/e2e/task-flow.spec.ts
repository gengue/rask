import { expect, test } from "@playwright/test";

/**
 * The flow Rask exists for: open a list, move a task's status without opening
 * it, and have that survive a reload.
 *
 * It covers the whole spine in one pass — session, list read, optimistic write,
 * outbox, and re-read from Postgres — which is worth more than a dozen tests
 * that each stub out the next layer down.
 */
test("changes a task's status from the list and persists it", async ({ page }) => {
  await page.goto("/__dev-login");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();

  // Into a list with a known set of statuses.
  await page.goto("/list/L1");
  const list = page.getByRole("listbox", { name: "Tasks" });
  await expect(list).toBeVisible();

  const row = list.getByRole("option").first();
  await expect(row).toBeVisible();
  const taskId = await row.getAttribute("id");
  expect(taskId).toBeTruthy();

  // The status glyph is the inline control; clicking it must not open the task.
  await row.getByRole("button").first().click();
  await page.getByPlaceholder("Change status…").waitFor();
  await page.getByRole("option", { name: "in review" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(`#${taskId}`)).toHaveCount(1);

  // Reload: the change came from Postgres, not from a client-side illusion.
  const detailId = taskId?.replace("task-", "");
  await page.goto(`/list/L1?task=${detailId}`);
  const detail = page.getByRole("complementary", { name: "Task detail" });
  await expect(detail.getByLabel("Status: in review")).toBeVisible();
});

/**
 * A filter is a clause now, and it is applied by Postgres rather than by the
 * browser over whatever happened to load. Two values in one clause is the part
 * worth covering: it is what the three single-value facet buttons this replaces
 * could not say at all.
 */
test("filters the list by two statuses at once", async ({ page }) => {
  await page.goto("/__dev-login");
  await page.goto("/list/L1");

  const list = page.getByRole("listbox", { name: "Tasks" });
  await expect(list.getByRole("option").first()).toBeVisible();

  const menu = page.locator("[data-menu]");
  await page.getByLabel("Add a filter").click();
  await menu.getByRole("option", { name: "Status" }).click();
  // The options come from the list's own status set, not from the rows on
  // screen, so a status nobody in the first page is in is still offered.
  await menu.getByRole("option", { name: "in progress", exact: true }).click();
  await menu.getByRole("option", { name: "in review", exact: true }).click();
  await page.keyboard.press("Escape");

  await expect(page.getByRole("button", { name: /^Remove Status/ })).toBeVisible();
  await expect(list.getByText("todo", { exact: true })).toHaveCount(0);
  const kept = await list.getByRole("option").count();
  expect(kept).toBeGreaterThan(0);

  // Escape with nothing else open is the way out, and it takes the clause with it.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Remove Status/ })).toHaveCount(0);
});

test("creates a task from the quick add dialog", async ({ page }) => {
  await page.goto("/__dev-login");
  await page.goto("/list/L1");
  await expect(page.getByRole("listbox", { name: "Tasks" })).toBeVisible();

  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();

  const title = `Playwright task ${Date.now()}`;
  await dialog.getByPlaceholder("New task…").fill(title);
  await page.keyboard.press("Enter");

  await expect(dialog).toBeHidden();

  // The new task lands in the list's first status group, which may be below the
  // fold in a 140-row list. Search for it rather than assuming it is on screen.
  await page.keyboard.press("/");
  await page.getByPlaceholder(/^Search name/).fill(title);
  await expect(page.getByText(title)).toBeVisible();
});

/**
 * Exactly one list is marked as the open one.
 *
 * `matchRoute({ to: "/list/$listId", params, fuzzy: true })` reads like it asks
 * "is this list the open one" and does not: under a fuzzy match the params are
 * ignored, only the pattern is compared, so every list in the tree came back
 * true and the sidebar drew all of them selected at once. It went unnoticed for
 * days because the dark theme's selected row is a barely-lighter grey; in light
 * mode it reads as multi-select and is impossible to miss.
 *
 * Only a rendered sidebar against a real route can catch this, which is why it
 * lives here rather than in a unit test.
 */
test("marks only the open list in the sidebar", async ({ page }) => {
  await page.goto("/__dev-login");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();

  // L1 and L2 share a folder, so landing on L1 reveals a sibling to be wrong about.
  await page.goto("/list/L1");
  await expect(page.getByRole("heading", { name: "GO Backend" })).toBeVisible();

  const sidebar = page.locator("aside");
  await expect(sidebar.getByRole("link", { name: "GO Frontend" })).toBeVisible();

  const selected = sidebar.locator('a[href^="/list/"].row-selected');
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute("href", "/list/L1");

  // The mark follows the list into its views, which is what the fuzzy match was
  // reaching for before it turned out to ignore the parameter it was given.
  await sidebar.getByRole("link", { name: "GO Frontend" }).click();
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute("href", "/list/L2");
});

/**
 * Signing out, and what a signed-out visit sees.
 *
 * Neither existed: `POST /auth/logout` was on the API and nothing called it,
 * and a 401 sent the browser straight to ClickUp's consent screen with no page
 * in between — which left a *refused* sign-in nowhere to land.
 *
 * Worth an end-to-end test rather than a unit one because the first attempt at
 * the gate was `if (signedOut()) return <Login/>` at the top of the component,
 * and a Solid component body runs once: signing out left the whole workspace on
 * screen behind a dead session, and nothing but a browser would have said so.
 */
test("signs out, and a signed-out visit gets a way back in", async ({ page }) => {
  await page.goto("/__dev-login");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();

  const signIn = page.getByRole("link", { name: "Continue with ClickUp" });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute("href", "/auth/clickup");
  // The workspace is gone with it, not merely covered.
  await expect(page.getByRole("heading", { name: "My Tasks" })).toHaveCount(0);

  // And the session really ended: a reload does not walk back into it.
  await page.reload();
  await expect(page.getByRole("link", { name: "Continue with ClickUp" })).toBeVisible();
});

test("a refused sign-in says why, instead of a page of plain text", async ({ page }) => {
  // What the OAuth callback redirects to when the workspace gate turns an
  // account away. It used to answer 403 with a bare string and no way back.
  await page.goto("/?signin=not_a_member");

  await expect(page.getByRole("alert")).toContainText("not a member of this workspace");
  await expect(page.getByRole("link", { name: "Continue with ClickUp" })).toBeVisible();
});
