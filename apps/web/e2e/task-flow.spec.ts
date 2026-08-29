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

/**
 * The quick filter, which is one clause with two ways to say it.
 *
 * Worth an end-to-end test rather than another unit one because the bug it
 * guards is not in the clause: on My Tasks the toggle is hidden, and the chip
 * hid itself too, which left `assignee ANY [me]` applied with nothing on screen
 * naming it and nothing but Escape to clear it. Only a rendered header shows
 * that.
 */
test("the quick filter narrows a list to me, and stays visible where its button is not", async ({
  page,
}) => {
  await page.goto("/__dev-login");
  await page.goto("/list/L1");

  const list = page.getByRole("listbox", { name: "Tasks" });
  await expect(list.getByRole("option").first()).toBeVisible();

  const count = page.getByTitle("Tasks matching this filter");
  const before = Number(await count.textContent());
  expect(before).toBeGreaterThan(0);

  const toggle = page.getByLabel("Only my tasks");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // Fewer rows, and the ones left are mine. The count is the whole filtered
  // set, not the window drawn, so it is the honest number to compare.
  await expect.poll(async () => Number(await count.textContent())).toBeLessThan(before);
  await expect(list.getByRole("option").first().getByTitle("genesis")).toBeVisible();

  // While the button is on screen it owns the clause, so no chip repeats it.
  await expect(page.getByRole("button", { name: /^Remove Assignee/ })).toHaveCount(0);

  // My Tasks asks the server for assignee=me, so it draws no button — and the
  // clause the filter is still carrying has to be named by something clearable.
  await page.getByRole("link", { name: "My Tasks" }).click();
  await expect(page.getByLabel("Only my tasks")).toHaveCount(0);
  const chip = page.getByRole("button", { name: /^Remove Assignee/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(chip).toHaveCount(0);
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
 * Closing an expanded task gives the list back.
 *
 * The list is `display:none` while the task fills the panel, and the expanded
 * flag used to outlive the task: the X removed `?task=` and left the flag set,
 * so the window went blank apart from the sidebar with no key that could
 * recover it — Escape's collapse branch only runs while a task is open.
 */
test("closing an expanded task returns to the list", async ({ page }) => {
  await page.goto("/__dev-login");
  await page.goto("/list/L1");

  const list = page.getByRole("listbox", { name: "Tasks" });
  await expect(list.getByRole("option").first()).toBeVisible();

  await list.getByRole("option").first().click();
  const detail = page.getByRole("complementary", { name: "Task detail" });
  await expect(detail).toBeVisible();

  await detail.getByRole("button", { name: "Expand task" }).click();
  await expect(detail.getByRole("button", { name: "Collapse task" })).toBeVisible();
  await expect(list).toBeHidden();

  await detail.getByTitle(/^Close/).click();
  await expect(detail).toHaveCount(0);
  await expect(list).toBeVisible();
});

/**
 * The expanded task is in the address, not in a tab-local flag.
 *
 * Which matters for one reason: a link is how people hand a task to each other,
 * and "read this, full width" was not something a link could say. So the state
 * has to survive being pasted, and the toggle has to keep writing it — a URL
 * that stops describing the screen the moment somebody presses `f` is worse
 * than not having the parameter at all.
 */
test("opens a task expanded from the URL and keeps the toggle there", async ({ page }) => {
  await page.goto("/__dev-login");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
  await page.goto("/list/L1");

  const list = page.getByRole("listbox", { name: "Tasks" });
  const row = list.getByRole("option").first();
  await expect(row).toBeVisible();
  const taskId = (await row.getAttribute("id"))?.replace("task-", "");

  // The link as somebody else receives it.
  await page.goto(`/list/L1?task=${taskId}&expanded=1`);
  const detail = page.getByRole("complementary", { name: "Task detail" });
  await expect(detail.getByLabel("Collapse task")).toBeVisible();
  // The list is behind it, not beside it.
  await expect(list).toBeHidden();

  // `f` collapses, and the address follows: what is on screen is what a copied
  // URL says, in both directions.
  await page.keyboard.press("f");
  await expect(detail.getByLabel("Expand task")).toBeVisible();
  await expect(list).toBeVisible();
  await expect(page).not.toHaveURL(/expanded/);

  await page.keyboard.press("f");
  await expect(page).toHaveURL(/expanded=true/);

  // The flag without a task says nothing, and the shell hides the list for it:
  // a link that lost its `task=` on the way is still a list, not a blank window.
  await page.goto("/list/L1?expanded=1");
  await expect(list.getByRole("option").first()).toBeVisible();
});
/**
 * A status changed from the list is a status changed in the open panel.
 *
 * Every write that only touches the task collection — the row's own status
 * glyph, the panel's menu, the palette, a card dropped on the board — used to
 * be invisible to a task already open. The panel read the collection with
 * `tasks.get()`, which is a Map lookup with no signal behind it, so nothing
 * asked it to read again: the list moved and the panel kept claiming the old
 * status until a poll happened to bring back different bytes.
 *
 * Only a browser can catch that. The unit test next to `useLiveTask` proves the
 * mirror notifies; this proves the panel is wired to it. Wide enough for the
 * split layout on purpose, so the row and the panel it contradicts are on
 * screen together, which is how it was noticed in the first place.
 */
test.describe(() => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a status changed from the list shows in the open panel", async ({ page }) => {
    await page.goto("/__dev-login");
    await page.goto("/list/L1");

    const list = page.getByRole("listbox", { name: "Tasks" });
    const row = list.getByRole("option").first();
    await expect(row).toBeVisible();

    await row.click();
    const detail = page.getByRole("complementary", { name: "Task detail" });
    const status = detail.locator('[aria-label^="Status: "]');
    await expect(status).toBeVisible();

    // Whatever it is now, move it somewhere else: the seed picks a status per
    // task, so the one to change to is only knowable at this point.
    const before = (await status.getAttribute("aria-label"))?.replace("Status: ", "");
    const target = before === "done" ? "todo" : "done";

    // The list is beside the panel here, not behind a scrim, so this is the row
    // and not the panel's own control.
    await expect(list).toBeVisible();
    await row.getByRole("button").first().click();
    await page.getByPlaceholder("Change status…").waitFor();
    await page.getByRole("option", { name: target, exact: true }).click();

    // Far inside the 30s poll that used to be the only thing that fixed this.
    await expect(status).toHaveAttribute("aria-label", `Status: ${target}`, { timeout: 3000 });
  });
});

/**
 * The due date, which is a calendar the browser already owns.
 *
 * The picker is drawn by the browser and not by the page, so Playwright can
 * neither see it nor click it. Stubbing `showPicker` and asserting it was asked
 * for is the whole of what a test can say about the calendar; the reload after
 * it is the part that proves the date reached Postgres.
 */
test("opens a calendar on the due date, and keeps the date it is given", async ({ page }) => {
  await page.addInitScript(() => {
    HTMLInputElement.prototype.showPicker = function stub() {
      document.documentElement.dataset.pickerOpened = "1";
    };
  });

  await page.goto("/__dev-login");
  await page.goto("/list/L1");

  const row = page.getByRole("listbox", { name: "Tasks" }).getByRole("option").first();
  await expect(row).toBeVisible();
  const taskId = (await row.getAttribute("id"))?.replace("task-", "");
  await row.click();

  const detail = page.getByRole("complementary", { name: "Task detail" });
  const due = detail.getByLabel("Due date");
  await expect(due).toBeVisible();

  await due.click();
  await expect(page.locator("html")).toHaveAttribute("data-picker-opened", "1");

  // Waited for, not raced: `fill` fires the change that starts the PATCH, and
  // navigating before it lands aborts the write this test is about.
  const written = page.waitForResponse(
    (response) => response.url().includes(`/api/tasks/${taskId}`) && response.status() < 400,
  );
  await due.fill("2027-03-15");
  await written;

  // Reload, because a day is lost to a timezone on the way through the mirror
  // or it is not lost at all.
  await page.goto(`/list/L1?task=${taskId}`);
  await expect(detail.getByLabel("Due date")).toHaveValue("2027-03-15");
});

/**
 * Choosing what a subtask row shows, and getting back out of the choosing.
 *
 * The columns themselves are a preference and a couple of spans. The part only
 * a browser can catch is the Escape: the popover stays open across a selection
 * so two columns are one trip, which means a click leaves focus on an item that
 * the re-render then removes. Focus lands on the body, the next key reaches the
 * shell instead of the popover, and the shell reads a stray Escape as "close
 * the task" — so ticking a column and backing out took the whole panel with it.
 */
test("picks the columns a subtask row shows, and keeps the task open on the way out", async ({
  page,
}) => {
  await page.goto("/__dev-login");
  // A seeded parent: the fixture gives the first tasks in L1 subtasks of their
  // own, which is the only place this panel exists without a real workspace.
  await page.goto("/list/L1?task=t2601");

  const section = page.locator("section", {
    has: page.getByRole("heading", { name: /Subtasks/i }),
  });
  await expect(section).toBeVisible();

  await section.getByRole("button", { name: "Choose what these rows show" }).click();
  await page.getByRole("option", { name: "Tracked time" }).click();

  await page.keyboard.press("Escape");

  await expect(page.getByRole("option", { name: "Tracked time" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Add index on tasks.date_updated" }),
  ).toBeVisible();

  // And the choice is a preference, not a session: it survives the reload.
  await page.reload();
  await expect(section.getByTitle("Tracked").first()).toBeVisible();
});

/**
 * Hiding done subtasks, and the index rail the expanded view can grow.
 *
 * The seeded subtask statuses come out of a PRNG, so the test makes its own
 * facts first: one subtask is patched to done through the API and the counts
 * are read back from the same response the panel will render. What only a
 * browser can catch is the wiring — the toggle filtering the rows the reader
 * sees, and the rail existing only where the layout has room for it.
 */
test("hides done subtasks on request, and the expanded view grows an index rail", async ({
  page,
}) => {
  const taskId = "t2601";
  await page.goto("/__dev-login");

  const before = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  const firstSub = before.subtasks[0];
  await page.request.patch(`/api/tasks/${firstSub.id}`, { data: { status: "done" } });
  const detailJson = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  const openCount = detailJson.subtasks.filter(
    (sub: { statusType: string }) => sub.statusType !== "done" && sub.statusType !== "closed",
  ).length;

  await page.goto(`/list/L1?task=${taskId}`);
  const section = page.locator("section", {
    has: page.getByRole("heading", { name: /Subtasks/i }),
  });
  await expect(section.locator("li")).toHaveCount(detailJson.subtasks.length);

  await section.getByRole("button", { name: "Hide done" }).click();
  await expect(section.locator("li")).toHaveCount(openCount);

  // Collapsed there is no room for a rail, so its toggle only exists expanded.
  await expect(page.getByRole("button", { name: "Show subtask index" })).toHaveCount(0);
  await page.getByRole("button", { name: "Expand task" }).click();
  await page.getByRole("button", { name: "Show subtask index" }).click();

  const rail = page.getByRole("navigation", { name: "Subtasks" });
  await expect(rail).toBeVisible();
  // The rail obeys the same "Hide done" the section does.
  await expect(rail.locator("li")).toHaveCount(openCount);

  // Clicking an entry opens that subtask; the rail then has nothing to index.
  const target = detailJson.subtasks.find(
    (sub: { statusType: string }) => sub.statusType !== "done" && sub.statusType !== "closed",
  );
  await rail.locator("li button").first().click();
  await expect(page).toHaveURL(new RegExp(`task=${target.id}`));

  // Both choices are preferences: they survive a reload.
  await page.goto(`/list/L1?task=${taskId}&expanded=1`);
  await expect(page.getByRole("navigation", { name: "Subtasks" }).locator("li")).toHaveCount(
    openCount,
  );
  await expect(section.getByRole("button", { name: "Show done" })).toBeVisible();
});

/**
 * A screenshot pasted into the description becomes an attachment and a link.
 *
 * Stubbed at the network edge on purpose. The upload is the one write that
 * waits on ClickUp instead of going through the outbox, and the e2e stack has
 * no token, so the call itself can only ever fail here. Everything on this side
 * of it is what breaks in practice: whether the paste is intercepted at all
 * (CodeMirror otherwise swallows the file and inserts nothing), what markdown
 * comes back, and whether it survives a commit as an image rather than as text.
 *
 * The stub answers with the task's own detail because the real route does: the
 * panel writes that response straight into what it is rendering, and a stub
 * that skimps on the shape blanks the task under test instead of failing.
 */
test("pastes an image into the description and keeps the link", async ({ page }) => {
  // The same seeded task the subtasks test opens by id, for the same reason:
  // the fixture is deterministic, and reading an id off the first row costs a
  // navigation and a list render this has no other use for.
  const taskId = "t2601";
  const url = "https://attachments.example.test/shot.png";

  await page.goto("/__dev-login");

  // Read up front rather than from inside the handler below: a route handler
  // that awaits a second request of its own leaves the interception open while
  // that one goes through the same dev server, and the whole suite would start
  // losing every test after this one to a server that had stopped answering.
  const mirrored = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  await page.route(`**/api/tasks/${taskId}/attachments`, (route) =>
    route.fulfill({
      status: 201,
      json: {
        attachment: { id: "a1", title: "shot.png", url, urlWithQuery: url },
        detail: mirrored,
      },
    }),
  );

  await page.goto(`/list/L1?task=${taskId}`);
  const detail = page.getByRole("complementary", { name: "Task detail" });
  await detail.getByRole("button", { name: "Edit description" }).click();

  const editor = detail.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");

  // The only way to paste a file: Playwright can drive the keyboard but not
  // fill the OS clipboard with bytes, so the event is built in the page.
  const pasteScreenshot = () =>
    editor.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });

  await pasteScreenshot();
  await expect(editor).toContainText(`![shot.png](${url})`);

  // The second one gets its own line rather than sitting beside the first: an
  // image spliced into a paragraph renders inline, halfway through it.
  await pasteScreenshot();
  await expect(detail.locator('.cm-line:has-text("![shot.png](")')).toHaveCount(2);

  // Committed, the markdown is an image and not the text of one.
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(detail.locator(`img[src="${url}"]`)).toHaveCount(2);
});

/**
 * The layout toggle.
 *
 * `b` flipped `ui.layout` long before anything on screen did, so what this has
 * to check is that the two agree in both directions: a click has to redraw the
 * panel, and the shortcut has to move the buttons. A unit test can read the
 * store and see neither.
 */
test("the layout buttons switch list and board, and stay in step with `b`", async ({ page }) => {
  await page.goto("/__dev-login");
  await page.goto("/list/L1");

  const rows = page.getByRole("listbox", { name: "Tasks" });
  const asList = page.getByRole("button", { name: "List view" });
  const asBoard = page.getByRole("button", { name: "Board view" });
  await expect(rows).toBeVisible();
  await expect(asList).toHaveAttribute("aria-pressed", "true");
  await expect(asBoard).toHaveAttribute("aria-pressed", "false");

  await asBoard.click();
  await expect(rows).toHaveCount(0);
  await expect(asBoard).toHaveAttribute("aria-pressed", "true");
  await expect(asList).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("b");
  await expect(rows).toBeVisible();
  await expect(asList).toHaveAttribute("aria-pressed", "true");
});

/**
 * The closed-task toggle, which is the board's Done column.
 *
 * End-to-end rather than another unit test for the same reason the quick filter
 * is: the unit tests can say `ui.showClosed` is true and that `statusShown`
 * agrees, and neither of them can see a column. The bug was that a reader who
 * turned Done on lost it by walking to the next list — the preference lived in
 * a per-tab store and every saved view wrote ClickUp's `show_closed` over it —
 * so what has to be checked is a rendered board on the far side of a navigation
 * and a reload.
 */
test("the Done column is a setting, and it survives leaving the list", async ({ page }) => {
  await page.goto("/__dev-login");
  /*
   * L3 and L5, which no other spec opens.
   *
   * "The column is absent" is only true of a list whose statuses are the ones
   * the seed gave it. Written against L1 this passed alone and failed in the
   * suite: a spec above moves a task to "done" through the app, the fixture's
   * ClickUp is a closed port, so the read-back that would have stamped the row
   * `closed` never lands and one card sits there typed `custom` — enough to
   * draw the column with the toggle off. That is the fixture, not the mirror;
   * in production `ingestTasks` writes ClickUp's own answer back the moment the
   * outbox drains.
   */
  await page.goto("/list/L3");
  await expect(page.getByRole("listbox", { name: "Tasks" })).toBeVisible();

  await page.keyboard.press("b");
  const done = page.getByRole("listbox", { name: "done" });
  const toggle = page.getByRole("button", { name: "Show closed tasks" });
  const count = page.getByTitle("Tasks matching this filter");

  // Off by default: the column is not empty, it is absent. Drawing it while the
  // same rule removes everything that lands in it is the trap `asStatusColumns`
  // is written to avoid.
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(done).toHaveCount(0);
  const hidden = Number(await count.textContent());
  expect(hidden).toBeGreaterThan(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(done).toBeVisible();
  // The rows are more than they were, which is the part a unit test cannot see:
  // the route refetched with closed=1 rather than re-filtering the page it had.
  await expect.poll(async () => Number(await count.textContent())).toBeGreaterThan(hidden);
  await expect(done.getByRole("option").first()).toBeVisible();

  // The next list, and then a reload: neither is allowed to take it back.
  await page.goto("/list/L5");
  await expect(page.getByRole("button", { name: "Show closed tasks" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.reload();
  await expect(page.getByRole("button", { name: "Show closed tasks" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // And back off, which has to put the column away again — the toggle is one
  // control, not a door that only opens.
  await page.getByRole("button", { name: "Show closed tasks" }).click();
  await page.goto("/list/L3");
  await expect(page.getByRole("listbox", { name: "done" })).toHaveCount(0);
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
 *
 * Last on purpose, with the refused-sign-in test that needs no session: signing
 * out ends the one seeded session every `/__dev-login` above hands out, so a
 * test placed after this one lands on the sign-in page instead of a list.
 *
 * That constraint crosses files, which is the part worth spelling out. Logout
 * deletes the session row, and `/__dev-login` only replays the fixed token in
 * `.dev-session` — it does not mint a new one. With `workers: 1` Playwright
 * runs spec files in alphabetical order, so any new file needing a session has
 * to sort before `task-flow`. `keyboard-timer.spec.ts` is named for that.
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
