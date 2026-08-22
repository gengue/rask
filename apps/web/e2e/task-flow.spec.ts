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

test("filters the list by status", async ({ page }) => {
  await page.goto("/__dev-login");
  await page.goto("/list/L1");

  const list = page.getByRole("listbox", { name: "Tasks" });
  await expect(list.getByRole("option").first()).toBeVisible();

  await page.getByLabel("Filter by status").click();
  // Closed and done tasks are excluded from the query, so they are not offered
  // as facet values either. Pick one that is actually in the view.
  await page.getByRole("option", { name: "in progress" }).click();

  await expect(page.getByRole("button", { name: "Clear status filter" })).toBeVisible();
  await expect(list.getByText("in progress", { exact: true })).toHaveCount(1);
  await expect(list.getByText("todo", { exact: true })).toHaveCount(0);
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
  await page.getByPlaceholder("Filter tasks…").fill(title);
  await expect(page.getByText(title)).toBeVisible();
});
