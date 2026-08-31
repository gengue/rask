import { expect, test } from "@playwright/test";
import { THEMES, themePolarity } from "../src/lib/theme.ts";

/**
 * Picking a theme, and having it still be on after a reload.
 *
 * `test/theme.test.ts` can only reach the pure half of the module: everything
 * else in it reads `localStorage`, `matchMedia` and `document`, none of which
 * exist under `bun test`. So the two halves that actually decide what colour
 * the app is have no other cover — `apply()`, which owns the classes, and the
 * inline script in index.html, which is what paints the first frame after a
 * reload and keeps its own copy of the theme names.
 *
 * `appearance`, not `theme-switch`, for the reason task-flow.spec.ts spells
 * out at length: signing out there ends the one seeded session that every
 * `/__dev-login` replays, and with `workers: 1` Playwright runs spec files in
 * alphabetical order. A file needing a session has to sort before task-flow.
 */
test("switches theme from the menu and keeps it across a reload", async ({ page }) => {
  await page.goto("/__dev-login");
  const html = page.locator("html");

  /*
   * Off THEMES rather than a list written out here. That list was a fourth
   * copy of the theme names and a third of which ones paint dark, and the way
   * it fails is by being complete: a theme nobody adds here is simply never
   * driven, so the spec stays green while the thing it exists to cover has a
   * hole in it. Reversed so the run ends on a light theme rather than leaving
   * the seeded profile dark for whatever sorts after it.
   */
  for (const [value, label] of [...THEMES].reverse()) {
    if (value === "system") continue;
    const cls = value;
    await page.getByRole("button", { name: /Choose a theme/ }).click();
    await page.locator("[data-menu]").getByRole("option", { name: label, exact: true }).click();
    await expect(html).toHaveClass(new RegExp(`\\b${cls}\\b`));
    // Every other theme class is off, and colour-scheme took the right side.
    const state = await page.evaluate(() => ({
      classes: [...document.documentElement.classList],
      scheme: document.documentElement.style.colorScheme,
    }));
    expect(state.classes).toEqual([cls]);
    expect(state.scheme).toBe(themePolarity(value));

    // The reload is the inline script's half: read back, painted before Solid.
    await page.reload();
    await expect(html).toHaveClass(new RegExp(`\\b${cls}\\b`));
  }
});
