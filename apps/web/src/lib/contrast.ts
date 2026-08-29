/**
 * WCAG contrast for the theme tokens, read out of `theme.css`.
 *
 * The runner is `apps/web/scripts/contrast.ts`; this half is pure so it can be
 * imported from a test and from browser code without dragging Bun in.
 *
 * Both themes are checked in one pass, because the failure mode is a colour
 * that reads on one and disappears on the other: on a near-black panel #f2994a
 * is 8.6:1, and on a near-white one it is 2.2:1. Eyeballing catches that only
 * after somebody complains they cannot read a due date.
 *
 * The tokens are parsed from the stylesheet rather than duplicated here. A
 * table kept in step by hand is a table that eventually says a colour clears AA
 * after somebody has changed it.
 */

/** 4.5:1 for body text, 3:1 for large text and glyphs. WCAG 2.1 AA. */
export const AA_TEXT = 4.5;
export const AA_LARGE = 3;

export function relativeLuminance(hex: string): number {
  const channels = parseHex(hex).map((value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** `#abc`, `#aabbcc` and `#aabbccdd`. The alpha byte is ignored, not blended. */
function parseHex(hex: string): [number, number, number] {
  const raw = hex.trim().replace(/^#/, "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6,8}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

export type Tokens = Record<string, string>;

/**
 * The token blocks: `@theme { … }` is dark, and each `html.<name>` block
 * re-points the same names.
 *
 * Found by scanning rather than named in a list. A list is a second place to
 * add a theme, and forgetting it is silent in the worst way: `audit` skips
 * tokens it cannot find, so an unlisted theme does not fail, it simply never
 * gets checked. Scanning means a theme is audited for having a block at all.
 *
 * The first block of each name wins. Every theme is written twice in the
 * stylesheet — once for its colours and once for `color-scheme` and the
 * floating shadow — and only the first carries tokens.
 *
 * Only opaque hex values are collected. `--color-hover` and `--color-scrim` are
 * deliberately translucent overlays and have no fixed ratio to measure.
 */
export function parseThemes(css: string): Record<string, Tokens> {
  const themes: Record<string, Tokens> = { dark: parseBlock(css, "@theme") };
  for (const [, name] of css.matchAll(/^html\.(\w+) \{/gm)) {
    if (name && !(name in themes)) themes[name] = parseBlock(css, `html.${name}`);
  }
  return themes;
}

function parseBlock(css: string, selector: string): Tokens {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block in the stylesheet`);

  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }

  const tokens: Tokens = {};
  for (const [, name, value] of css
    .slice(start, end)
    .matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    if (name && value && value.length <= 7) tokens[name] = value;
  }
  return tokens;
}

/** Foreground tokens, and the surfaces each has to be legible on. */
const CHECKS: ReadonlyArray<{ ink: string; on: readonly string[]; min: number }> = [
  { ink: "ink", on: ["app", "panel", "elevated", "overlay"], min: AA_TEXT },
  { ink: "ink-prose", on: ["panel", "elevated", "overlay"], min: AA_TEXT },
  { ink: "ink-2", on: ["app", "panel", "elevated", "overlay"], min: AA_TEXT },
  { ink: "ink-3", on: ["app", "panel", "elevated", "overlay"], min: AA_TEXT },
  { ink: "ink-4", on: ["app", "panel", "elevated", "overlay"], min: AA_TEXT },
  { ink: "accent", on: ["app", "panel", "elevated", "overlay"], min: AA_TEXT },
  // Status tones carry 11px glyphs and chips, not body text.
  { ink: "urgent", on: ["app", "panel", "elevated"], min: AA_LARGE },
  { ink: "high", on: ["app", "panel", "elevated"], min: AA_LARGE },
  { ink: "ok", on: ["app", "panel", "elevated"], min: AA_LARGE },
  { ink: "on-accent", on: ["accent"], min: AA_TEXT },
];

export interface Finding {
  theme: string;
  ink: string;
  surface: string;
  ratio: number;
  min: number;
}

export function audit(themes: Record<string, Tokens>): Finding[] {
  const findings: Finding[] = [];
  for (const [theme, tokens] of Object.entries(themes)) {
    for (const { ink, on, min } of CHECKS) {
      const foreground = tokens[ink];
      if (!foreground) continue;
      for (const surface of on) {
        const background = tokens[surface];
        if (!background) continue;
        findings.push({
          theme,
          ink,
          surface,
          ratio: contrastRatio(foreground, background),
          min,
        });
      }
    }
  }
  return findings;
}
