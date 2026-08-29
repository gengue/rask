import { describe, expect, test } from "bun:test";
import { THEMES, themeLabel } from "../src/lib/theme.ts";

/**
 * The list is the interface: the theme menu and the command palette both render
 * it in order, so the order and the labels are what there is to test.
 *
 * Only the pure half is here. Everything else in the module reads
 * `localStorage`, `matchMedia` and `document`, none of which exist under
 * `bun test`; the round trip that matters is covered by the theme surviving a
 * reload in the browser, and by the inline script in index.html which is what
 * actually paints the first frame.
 */
describe("the list", () => {
  test("system comes first, since it is the default and the menu reads top-down", () => {
    expect(THEMES[0]?.[0]).toBe("system");
  });

  test("the easter eggs are on offer — they are only reachable through this list", () => {
    const values = THEMES.map(([value]) => value);
    expect(values).toContain("ember");
    expect(values).toContain("brutal");
    expect(values).toContain("cyber");
  });
});

/**
 * The one duplicate the module cannot avoid.
 *
 * index.html carries its own copy of the theme names, because it has to paint
 * the first frame before any bundle loads. A theme added here and not there
 * loads as light or dark, repaints once the module runs, and does that on
 * every single visit — but only for the people who picked it, which is nobody
 * on the machine where it was added.
 */
const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
const inline = html.slice(html.indexOf("const KNOWN"), html.indexOf("classList.add"));

describe("the inline script in index.html", () => {
  test("the block was actually found", () => {
    expect(inline).toContain("localStorage");
  });

  for (const [value] of THEMES.filter(([value]) => value !== "system")) {
    test(`knows about "${value}", so its first paint is not a flash of dark`, () => {
      expect(inline).toContain(`"${value}"`);
    });
  }
});

describe("labels", () => {
  test("every choice has one, since the menu row is the only place it is named", () => {
    for (const [value, label] of THEMES) expect(themeLabel(value)).toBe(label);
  });
});
