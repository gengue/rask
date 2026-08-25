import { expect, test } from "@playwright/test";

/**
 * The right-click menu, and the two writes that live nowhere else.
 *
 * Worth an end-to-end pass rather than a unit test because the interesting part
 * is the wiring: one `contextmenu` listener on the window resolves the row under
 * the pointer by its `id`, which is a contract between the shell and three
 * different row components that no type checks. And because archiving and
 * deleting are the only writes in the app whose success is a row *not* being
 * there — a bug in either looks exactly like the feature working.
 *
 * Each test reads the id of whichever row it acts on, so they do not care what
 * the ones before them removed from the list. The list is L4 rather than the L1
 * every other spec reads: these are the only tests in the suite that take rows
 * away, and a spec that quietly shortens the list everybody else opens is a
 * trap for whoever writes the next one.
 */

async function openMenuOnFirstRow(page: import("@playwright/test").Page) {
  await page.goto("/__dev-login");
  await page.goto("/list/L4");

  const list = page.getByRole("listbox", { name: "Tasks" });
  const row = list.getByRole("option").first();
  await expect(row).toBeVisible();
  const rowId = await row.getAttribute("id");
  expect(rowId).toBeTruthy();

  await row.click({ button: "right" });
  await page.getByPlaceholder("Task actions…").waitFor();

  return { list, menu: page.locator("[data-menu]"), rowId: rowId as string };
}

test("archives a task, and the reload agrees", async ({ page }) => {
  const { list, menu, rowId } = await openMenuOnFirstRow(page);

  await menu.getByRole("option", { name: "Archive", exact: true }).click();
  await expect(page.locator(`#${rowId}`)).toHaveCount(0);

  // The row leaving the screen is the optimistic half. This is the other one:
  // the patch reached Postgres, and every read but the change feed filters
  // `archived = false`, so it does not come back.
  await page.reload();
  await expect(list.getByRole("option").first()).toBeVisible();
  await expect(page.locator(`#${rowId}`)).toHaveCount(0);
});

test("deletes a task once the confirmation is accepted", async ({ page }) => {
  const { list, menu, rowId } = await openMenuOnFirstRow(page);

  const confirmed = new Promise<string>((resolve) => {
    page.once("dialog", (dialog) => {
      resolve(dialog.message());
      void dialog.accept();
    });
  });

  await menu.getByRole("option", { name: "Delete", exact: true }).click();
  // The subtasks going too is the part nobody expects, so it has to be said
  // before the click, not discovered after it.
  expect(await confirmed).toContain("Subtasks");

  await expect(page.locator(`#${rowId}`)).toHaveCount(0);
  await page.reload();
  await expect(list.getByRole("option").first()).toBeVisible();
  await expect(page.locator(`#${rowId}`)).toHaveCount(0);
});

test("dismissing the confirmation leaves the task alone", async ({ page }) => {
  const { menu, rowId } = await openMenuOnFirstRow(page);

  page.once("dialog", (dialog) => void dialog.dismiss());
  await menu.getByRole("option", { name: "Delete", exact: true }).click();

  // Nothing optimistic may happen before the answer: the row is removed first
  // and restored on failure, and a dismissal is not a failure to restore from.
  await expect(page.locator(`#${rowId}`)).toHaveCount(1);
  await page.reload();
  await expect(page.locator(`#${rowId}`)).toHaveCount(1);
});

test("`m` opens the menu on the row under the cursor", async ({ page }) => {
  await page.goto("/__dev-login");
  await page.goto("/list/L4");

  const list = page.getByRole("listbox", { name: "Tasks" });
  const row = list.getByRole("option").first();
  await expect(row).toBeVisible();
  const rowId = await row.getAttribute("id");

  // The cursor starts on the first row, so this needs no click — which is the
  // point: a context menu opened from the keyboard names the focused element as
  // its target, and that is the listbox rather than any row in it.
  await page.keyboard.press("m");
  await page.getByPlaceholder("Task actions…").waitFor();
  await page.locator("[data-menu]").getByRole("option", { name: "Archive", exact: true }).click();

  await expect(page.locator(`#${rowId}`)).toHaveCount(0);
});

test("the open panel reaches the same menu through its own button", async ({ page }) => {
  await page.goto("/__dev-login");
  await page.goto("/list/L4");

  const list = page.getByRole("listbox", { name: "Tasks" });
  const row = list.getByRole("option").first();
  await expect(row).toBeVisible();
  const rowId = await row.getAttribute("id");
  await row.click();

  // Below the `split` breakpoint the panel covers the list, so right-clicking
  // the row behind it is not a way out. The button is why the panel is not a
  // dead end for the two actions that live in this menu.
  const detail = page.getByRole("complementary", { name: "Task detail" });
  await expect(detail).toBeVisible();
  await detail.getByLabel("Task actions").click();
  await page.getByPlaceholder("Task actions…").waitFor();
  await page.locator("[data-menu]").getByRole("option", { name: "Archive", exact: true }).click();

  // The panel goes with the row: there is nothing left in it to look at.
  await expect(detail).toHaveCount(0);
  await expect(page.locator(`#${rowId}`)).toHaveCount(0);
});

test("copies the task's two addresses", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { menu, rowId } = await openMenuOnFirstRow(page);
  const taskId = rowId.replace("task-", "");

  await menu.getByRole("option", { name: "Copy ClickUp URL" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `https://app.clickup.com/t/${taskId}`,
  );

  await page.locator(`#${rowId}`).click({ button: "right" });
  await page.getByPlaceholder("Task actions…").waitFor();
  await menu.getByRole("option", { name: "Copy link" }).click();

  // Rask's own link, which the catch-all route resolves back to this task.
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`/t/${taskId}`);
  await page.goto(copied);
  await expect(page.getByRole("complementary", { name: "Task detail" })).toBeVisible();
});
