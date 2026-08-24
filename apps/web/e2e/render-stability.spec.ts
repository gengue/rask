import { expect, type Page, test } from "@playwright/test";

/**
 * One task changing must not rebuild every row on screen.
 *
 * The window used to be built imperatively inside a tracked computation, and
 * Solid's reconciler keys on DOM-node identity, so any change to the loaded
 * set — an SSE frame from a colleague, an own optimistic write, churn in a
 * list this view is not even showing — tore down and recreated every visible
 * row: avatars re-decoded, :hover dropped, text selection died. Measured
 * before the `<Index>` rewrite, editing one task removed one node per visible
 * row; after it, only the edited row touches its own chips.
 *
 * Only a browser can measure this: the number is MutationObserver removals,
 * and the unit suite has no DOM. The threshold is not zero because the edited
 * row legitimately rebuilds its tag chips and avatar stack — a handful of
 * nodes, not a window's worth.
 */

/** Nodes the one edited row may legitimately rebuild (its chips and avatars). */
const REMOVAL_BUDGET = 10;

interface Churn {
  removed: number;
  added: number;
  rows: number;
  renamed: boolean;
}

/**
 * Renames the first visible task through the app's own collection and counts
 * what that does to the DOM under <main>.
 *
 * The Vite dev server serves the source module graph, so importing
 * `/src/lib/store.ts` from the page yields the same module instance the app
 * runs on — `merge` lands in the live collection exactly like an SSE frame.
 */
async function churnFromOneEdit(page: Page): Promise<Churn> {
  return await page.evaluate(async () => {
    const main = document.querySelector("main");
    const row = main?.querySelector<HTMLElement>('[role="option"]');
    const id = row?.id.replace("task-", "");
    if (!main || !id) throw new Error("no task row on screen");

    const storePath = "/src/lib/store.ts";
    const store = (await import(storePath)) as typeof import("../src/lib/store.ts");
    const current = store.tasks.get(id);
    if (!current) throw new Error(`row ${id} not in the collection`);

    let removed = 0;
    let added = 0;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        removed += mutation.removedNodes.length;
        added += mutation.addedNodes.length;
      }
    });
    observer.observe(main, { childList: true, subtree: true });

    const marker = `${current.name} [poked]`;
    store.merge([{ ...current, name: marker }]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    for (const mutation of observer.takeRecords()) {
      removed += mutation.removedNodes.length;
      added += mutation.addedNodes.length;
    }
    observer.disconnect();

    return {
      removed,
      added,
      rows: main.querySelectorAll('[role="option"]').length,
      // Without this a broken pipeline that never re-renders would pass on 0.
      renamed: (main.textContent ?? "").includes(marker),
    };
  });
}

test("editing one task leaves the other list rows' DOM alone", async ({ page }) => {
  await page.goto("/__dev-login");
  await page.goto("/list/L1");
  const list = page.getByRole("listbox", { name: "Tasks" });
  await expect(list.getByRole("option").first()).toBeVisible();

  const churn = await churnFromOneEdit(page);
  console.log(`[render-stability] list: ${JSON.stringify(churn)}`);

  expect(churn.renamed).toBe(true);
  expect(churn.rows).toBeGreaterThan(5);
  expect(churn.removed).toBeLessThanOrEqual(REMOVAL_BUDGET);
});

test("editing one task leaves the other board cards' DOM alone", async ({ page }) => {
  await page.goto("/__dev-login");
  await page.goto("/list/L1");
  await expect(page.getByRole("listbox", { name: "Tasks" })).toBeVisible();

  // The layout toggle is per-tab state, not URL state; flip it at the source.
  await page.evaluate(async () => {
    const uiPath = "/src/lib/ui.ts";
    const ui = (await import(uiPath)) as typeof import("../src/lib/ui.ts");
    ui.setUi("layout", "board");
  });
  await expect(page.locator('main [role="option"]').first()).toBeVisible();

  const churn = await churnFromOneEdit(page);
  console.log(`[render-stability] board: ${JSON.stringify(churn)}`);

  expect(churn.renamed).toBe(true);
  expect(churn.rows).toBeGreaterThan(5);
  expect(churn.removed).toBeLessThanOrEqual(REMOVAL_BUDGET);
});
