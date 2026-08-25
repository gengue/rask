import { expect, test } from "@playwright/test";

/**
 * The keyboard path to a running timer.
 *
 * ClickUp is stubbed at the API boundary rather than reached, and deliberately:
 * the e2e stack seeds a fixture workspace and stores no OAuth token, so every
 * timer route would answer 409 against the real thing. What is left is exactly
 * what no unit test covers — that `t` is bound, that it reaches the endpoint
 * with the task under the cursor, that the answer lights up the sidebar band
 * from a view the task is not open in, and that stopping clears it.
 *
 * The orchestration behind those endpoints is covered for real in
 * `apps/api/test/time.test.ts`, against a stubbed ClickUp of its own.
 *
 * Named to sort before `task-flow.spec.ts`, which is not cosmetic: that file
 * ends by signing out, which deletes the one session row the whole suite
 * shares, and `/__dev-login` replays a fixed token rather than minting a new
 * one. Anything running after it opens on the sign-in page.
 */

const START = 1_756_080_000_000;

test("starts and stops a timer from the list with `t`", async ({ page }) => {
  let running: { id: string; taskId: string; taskName: string } | null = null;
  const started: string[] = [];

  await page.route("**/api/timer", async (route) => {
    const request = route.request();

    if (request.method() === "GET") {
      return route.fulfill({ json: { entry: running && entry(running) } });
    }

    if (request.method() === "POST") {
      const { taskId } = request.postDataJSON() as { taskId: string };
      started.push(taskId);
      running = { id: "live", taskId, taskName: "Tracked task" };
      return route.fulfill({ json: { started: entry(running), stopped: null } });
    }

    const stopped = running;
    running = null;
    return route.fulfill({
      json: { stopped: stopped && { ...entry(stopped), running: false, durationMs: 3_600_000 } },
    });
  });

  await page.route("**/api/tasks/*/time-entries", (route) =>
    route.fulfill({ json: { entries: [] } }),
  );

  await page.goto("/__dev-login");
  await page.goto("/list/L1");

  const list = page.getByRole("listbox", { name: "Tasks" });
  const row = list.getByRole("option").first();
  await expect(row).toBeVisible();
  const taskId = (await row.getAttribute("id"))?.replace("task-", "");

  // The cursor starts on the first row, so `t` acts on it without a click.
  await page.keyboard.press("t");

  const band = page.getByRole("button", { name: "Stop the timer" });
  await expect(band).toBeVisible();
  expect(started).toEqual([taskId]);

  // The counter is derived from `start`, so it is already past zero and moving.
  const counter = page.locator("text=/^\\d+:\\d{2}$|^\\d+:\\d{2}:\\d{2}$/").first();
  await expect(counter).toBeVisible();

  // Leaving the list does not lose it: the band lives in the shell, which is
  // the entire point of a timer you can forget about.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Stop the timer" })).toBeVisible();

  await page.getByRole("button", { name: "Stop the timer" }).click();
  await expect(page.getByRole("button", { name: "Stop the timer" })).toHaveCount(0);
});

test("recovers a timer started elsewhere on the next load", async ({ page }) => {
  // The reload case, and the second-device case: nothing is mirrored, so the
  // only way the band can be right is by asking ClickUp at start-up.
  await page.route("**/api/timer", (route) =>
    route.fulfill({
      json: { entry: entry({ id: "live", taskId: "T1", taskName: "Started on my phone" }) },
    }),
  );

  await page.goto("/__dev-login");
  await page.goto("/list/L1");

  await expect(page.getByTitle("Started on my phone")).toBeVisible();
});

function entry(source: { id: string; taskId: string; taskName: string }) {
  return {
    id: source.id,
    taskId: source.taskId,
    taskName: source.taskName,
    user: null,
    start: START,
    end: null,
    durationMs: null,
    running: true,
    description: "",
    billable: false,
  };
}
