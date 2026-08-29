import { describe, expect, test } from "bun:test";
import { THEMES, themeLabel, themePolarity } from "../src/lib/theme.ts";

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
    expect(values).toContain("cyber");
  });
});

describe("labels", () => {
  test("every choice has one, since the menu row is the only place it is named", () => {
    for (const [value, label] of THEMES) expect(themeLabel(value)).toBe(label);
  });
});

/**
 * The one duplicate the module cannot remove.
 *
 * index.html carries its own copy of the theme names and of which ones paint
 * dark, because it has to paint the first frame before any bundle loads. A
 * theme missing from the first list loads as light or dark and repaints once
 * the module runs; a theme missing from the second gets native scrollbars and
 * date pickers the wrong way round. Both happen on every visit, and only for
 * the people who picked that theme — which is nobody on the machine where it
 * was added.
 *
 * `e2e/appearance.spec.ts` drives the same script for real, one theme at a
 * time. This is the half that notices a theme nobody thought to add there.
 */
const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

/** A `const NAME = [...]` array out of the inline script, parsed. */
function arrayNamed(name: string): unknown {
  const source = html.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))?.[1];
  // A failed match yields null, which fails the comparison — no guard needed.
  return JSON.parse(source ?? "null");
}

const offered = THEMES.map(([value]) => value).filter((value) => value !== "system");

describe("the inline script in index.html", () => {
  test("KNOWN names exactly the themes the menu offers, in order", () => {
    expect(arrayNamed("KNOWN")).toEqual(offered);
  });

  test("DARK names exactly the themes that paint dark", () => {
    expect(arrayNamed("DARK")).toEqual(offered.filter((value) => themePolarity(value) === "dark"));
  });
});
