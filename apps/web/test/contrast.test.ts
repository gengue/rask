import { describe, expect, test } from "bun:test";
import { AA_LARGE, AA_TEXT, audit, contrastRatio, parseThemes } from "../src/lib/contrast.ts";

const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
const themes = parseThemes(css);

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
  test("both theme blocks are found, with the tokens the app uses", () => {
    // If the parse silently returned nothing, every assertion below would pass.
    for (const tokens of [themes.dark, themes.light]) {
      expect(Object.keys(tokens).length).toBeGreaterThan(10);
      expect(tokens.ink).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tokens.app).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("dark and light are actually different", () => {
    expect(themes.dark.app).not.toBe(themes.light.app);
  });

  test("every token pair clears WCAG AA, in both themes", () => {
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
