import { describe, expect, test } from "bun:test";
import { THEMES, themeLabel } from "../src/lib/theme.ts";

/**
 * The list is the interface: the theme menu and the command palette both render
 * it in order, so the order and the labels are what there is to test.
 *
 * Only the pure half is here. Everything else in the module reads
 * `localStorage`, `matchMedia` and `document`, none of which exist under
 * `bun test`. The round trip that matters — pick a theme, and have it still be
 * on after a reload, painted by the inline script in index.html rather than by
 * this module — is `e2e/theme-switch.spec.ts`.
 */
describe("the list", () => {
  test("system comes first, since it is the default and the menu reads top-down", () => {
    expect(THEMES[0]?.[0]).toBe("system");
  });

  test("the easter eggs are on offer — they are only reachable through this list", () => {
    const values = THEMES.map(([value]) => value);
    expect(values).toContain("ember");
    expect(values).toContain("brutal");
    expect(values).toContain("xp");
    expect(values).toContain("aqua");
  });
});

describe("labels", () => {
  test("every choice has one, since the menu row is the only place it is named", () => {
    for (const [value, label] of THEMES) expect(themeLabel(value)).toBe(label);
  });
});
