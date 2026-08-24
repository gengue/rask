import { describe, expect, test } from "bun:test";
import { nextTheme, THEMES, themeLabel } from "../src/lib/theme.ts";

/**
 * One button has to express three states, so the order it cycles in is the
 * whole interface. Get it wrong and there is no way back to "System" — which
 * is the default, and the one a two-way toggle cannot offer at all.
 *
 * Only the pure half is here. Everything else in the module reads
 * `localStorage`, `matchMedia` and `document`, none of which exist under
 * `bun test`; the round trip that matters is covered by the theme surviving a
 * reload in the browser, and by the inline script in index.html which is what
 * actually paints the first frame.
 */
describe("cycling", () => {
  test("system, light, dark, and back to system", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  test("three presses return where they started, whatever the order becomes", () => {
    let choice = THEMES[0]?.[0] ?? "system";
    for (let i = 0; i < THEMES.length; i++) choice = nextTheme(choice);
    expect(choice).toBe(THEMES[0]?.[0]);
  });

  test("system comes first, so the default is where cycling starts", () => {
    expect(THEMES[0]?.[0]).toBe("system");
  });
});

describe("labels", () => {
  test("every choice has one, since the button's tooltip is the only place it is named", () => {
    for (const [value, label] of THEMES) expect(themeLabel(value)).toBe(label);
  });
});
