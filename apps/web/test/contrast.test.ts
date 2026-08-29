import { describe, expect, test } from "bun:test";
import { AA_LARGE, AA_TEXT, audit, contrastRatio, parseThemes } from "../src/lib/contrast.ts";
import { THEMES } from "../src/lib/theme.ts";

const css = await Bun.file(new URL("../src/theme.css", import.meta.url)).text();
const themes = parseThemes(css);

/** Indexing a Record is `Tokens | undefined`, and a missing block is a bug. */
function tokensFor(name: string) {
  const found = themes[name];
  if (!found) throw new Error(`no ${name} block in the stylesheet`);
  return found;
}

/**
 * The colours, checked against the standard rather than against an opinion.
 *
 * This is here and not only in the script because a colour token is the kind of
 * thing someone nudges to taste in a hurry — and the failure is invisible to
 * the person nudging it, who can read their own screen fine. Light mode is
 * where it bites: on a near-black panel #f2994a is 8.6:1, and on a near-white
 * one it is 2.2:1.
 */
describe("the ratio itself", () => {
  test("black on white is 21:1, the maximum", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  test("a colour against itself is 1:1", () => {
    expect(contrastRatio("#7a85dd", "#7a85dd")).toBeCloseTo(1, 5);
  });

  test("order does not matter", () => {
    expect(contrastRatio("#14161a", "#e7e9ed")).toBeCloseTo(
      contrastRatio("#e7e9ed", "#14161a"),
      10,
    );
  });

  test("shorthand hex and an alpha byte parse to the same colour", () => {
    expect(contrastRatio("#fff", "#000000")).toBeCloseTo(contrastRatio("#ffffff", "#000000"), 10);
    expect(contrastRatio("#ffffffcc", "#000000")).toBeCloseTo(
      contrastRatio("#ffffff", "#000000"),
      10,
    );
  });
});

describe("the stylesheet", () => {
  test("every theme block is found, with the tokens the app uses", () => {
    // If the parse silently returned nothing, every assertion below would pass.
    for (const tokens of Object.values(themes)) {
      expect(Object.keys(tokens).length).toBeGreaterThan(10);
      expect(tokens.ink).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tokens.app).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("the themes are actually different", () => {
    const walls = Object.values(themes).map((tokens) => tokens.app);
    expect(new Set(walls).size).toBe(walls.length);
  });

  /*
   * The failure the split into theme.css introduced.
   *
   * A token added to `@theme` and not to `html.light` paints correctly in dark
   * and falls back to nothing in light — no error, no missing variable, just an
   * element that inherits whatever its parent had. The audit above cannot see
   * it, because it only rates the pairs both themes define. Now that a second
   * app paints from this file, one theme quietly missing a colour is a bug in
   * two places at once.
   */
  /*
   * The seam between the menu and the palette.
   *
   * `parseThemes` finds the blocks by scanning, so a theme cannot ship
   * unaudited by being left off a list — but it can still ship with no block
   * at all, which is a theme the menu offers and the stylesheet has never
   * heard of: every colour falls through to dark and nothing errors. This
   * fails in both directions, which also retires the audited-block check that
   * scanning made tautological.
   */
  test("the audited themes are exactly the ones the menu offers", () => {
    const menu = THEMES.map(([value]) => value).filter((value) => value !== "system");
    expect(Object.keys(themes).sort()).toEqual(menu.sort());
  });

  test("every theme defines the same set of tokens", () => {
    const dark = Object.keys(tokensFor("dark")).sort();
    for (const [name, tokens] of Object.entries(themes)) {
      expect([name, Object.keys(tokens).sort()]).toEqual([name, dark]);
    }
  });

  test("every token pair clears WCAG AA, in every theme", () => {
    const failures = audit(themes)
      .filter((f) => f.ratio < f.min)
      .map((f) => `${f.theme}: ${f.ink} on ${f.surface} = ${f.ratio.toFixed(2)}:1 (min ${f.min})`);

    expect(failures).toEqual([]);
  });

  test("the audit checks something, and against the right thresholds", () => {
    const findings = audit(themes);
    expect(findings.length).toBeGreaterThan(40);
    expect(new Set(findings.map((f) => f.min))).toEqual(new Set([AA_TEXT, AA_LARGE]));
  });
});
