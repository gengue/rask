import { describe, expect, test } from "bun:test";

/**
 * The easter-egg skins (Ember, Brutal, XP, Aqua) hang off selectors they do not
 * own:
 * aria-labels and utility classes that live in component markup. A rename over
 * there — the detail panel's label, `bg-panel` becoming `bg-panel/95`, the
 * section border class — sheds the skin with no error anywhere, which is
 * exactly the kind of failure this repo pins with a test. Each row says: the
 * stylesheet still targets this hook, and the component still provides it.
 */
const stylesheet = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
const palette = await Bun.file(new URL("../src/theme.css", import.meta.url)).text();

const HOOKS: ReadonlyArray<{ selector: string; provider: string; markup: string }> = [
  {
    selector: 'aside[aria-label="Task detail"]',
    provider: "../src/components/TaskDetail.tsx",
    markup: 'aria-label="Task detail"',
  },
  {
    selector: 'aside[aria-label="Workspace"]',
    provider: "../src/components/Sidebar.tsx",
    markup: 'aria-label="Workspace"',
  },
  { selector: ".bg-panel", provider: "../src/App.tsx", markup: "bg-panel" },
  { selector: ".floating", provider: "../src/components/Menu.tsx", markup: "floating" },
  { selector: ".row-selected", provider: "../src/components/Menu.tsx", markup: "row-selected" },
  { selector: ".uppercase", provider: "../src/components/Sidebar.tsx", markup: "uppercase" },
  {
    selector: "section.border-t",
    provider: "../src/components/TaskDetail.tsx",
    markup: "border-t",
  },
  {
    selector: "button.bg-accent",
    provider: "../src/components/TaskDetail.tsx",
    markup: "bg-accent",
  },
  // Shared by more than one skin, so filed under none of them: XP's blue
  // caption bar and Aqua's title bar are the same header, and both of them
  // dress the workspace search field.
  {
    selector: 'aside[aria-label="Workspace"] > header',
    provider: "../src/components/Sidebar.tsx",
    markup: "<header",
  },
  // `bg-hover` as a base class is unique to the search field in the sidebar —
  // every other control there spells it `hover:bg-hover`, a different class
  // token — so the class run is the hook rather than the bare name.
  {
    selector: "button.bg-hover",
    provider: "../src/components/Sidebar.tsx",
    markup: "bg-hover px-2",
  },
  // XP only, from here down. The treeview's dotted rules.
  { selector: ".border-l", provider: "../src/components/Sidebar.tsx", markup: "border-l" },
  // The tree's +/- boxes are drawn out of this glyph, path and all.
  { selector: ".chevron", provider: "../src/components/Sidebar.tsx", markup: "chevron" },
  // The stop error's own class, which only exists to be styled.
  { selector: ".xp-bsod", provider: "../src/components/RouteError.tsx", markup: "xp-bsod" },
  // Brutal only, from here down.
  // The group-header band. Board's washes are divs and spans, not buttons.
  {
    selector: "button.bg-wash",
    provider: "../src/components/TaskList.tsx",
    markup: "bg-wash",
  },
  // The one control the reference paints hot pink.
  {
    selector: '[aria-label="Add a filter"]',
    provider: "../src/components/FilterBar.tsx",
    markup: 'aria-label="Add a filter"',
  },
  // Task rows: the dashed rule and the outlined tags hang off the listbox role.
  {
    selector: '[role="option"]',
    provider: "../src/components/TaskRow.tsx",
    markup: 'role="option"',
  },
  // Aqua only, from here down. The headers it turns into toolbars have to stay
  // direct children of the landmarks they hang off, which is what the `>` in
  // each selector is asserting.
  {
    selector: 'aside[aria-label="Task detail"] > header',
    provider: "../src/components/TaskDetail.tsx",
    markup: "<header",
  },
  // Shared by every skin that repaints the list header band. A marker class
  // rather than `main > div > header`, which was how all of them reached it:
  // that middle div exists only to carry `hidden` when a task is expanded, so
  // unwrapping it is a change nobody would think twice about and every skin
  // would shed the band with nothing red.
  { selector: ".view-header", provider: "../src/App.tsx", markup: "view-header" },
  // The view's name and its count, which three skins turn into a plate.
  { selector: "main header h1", provider: "../src/App.tsx", markup: "<h1" },
  { selector: ".bg-chip", provider: "../src/App.tsx", markup: "bg-chip" },
  // The four labels the app title-cases from data. Read as a marker the same
  // way `.uppercase` is.
  { selector: ".capitalize", provider: "../src/components/TaskList.tsx", markup: "capitalize" },
  // Tag chips on a row: outlined by Brutal, shouted by Cyberpunk.
  {
    selector: '[role="option"] .border',
    provider: "../src/components/TaskRow.tsx",
    markup: "border",
  },
  // Menu rows, which Cyberpunk shouts wherever the menu opens.
  {
    selector: '[role="listbox"]',
    provider: "../src/components/Menu.tsx",
    markup: 'role="listbox"',
  },
  // Cyberpunk only, from here down.
  // The HUD strips hang off #root, which is in the page, not in a component.
  { selector: "#root", provider: "../index.html", markup: 'id="root"' },
  // The detail panel's title bar, where "TASK DETAILS" is injected. The loose
  // form, unlike Aqua's above: nothing here depends on the header staying a
  // direct child, and TaskDetail has exactly one.
  {
    selector: 'aside[aria-label="Task detail"] header',
    provider: "../src/components/TaskDetail.tsx",
    markup: "<header",
  },
  // The property rail's label, which exists only to be repainted.
  {
    selector: ".field-label",
    provider: "../src/components/TaskDetail.tsx",
    markup: "field-label",
  },
  // The task title, which is a textarea while it is being edited.
  { selector: "textarea.text-lg", provider: "../src/components/TaskDetail.tsx", markup: "text-lg" },
  // The cursor's left hairline, which becomes the lit tab.
  {
    selector: '[role="option"] > span.bg-accent',
    provider: "../src/components/TaskRow.tsx",
    markup: "bg-accent",
  },
];

describe("every selector hook the easter-egg skins rely on", () => {
  for (const { selector, provider, markup } of HOOKS) {
    test(`${selector} is targeted by the stylesheet and provided by ${provider}`, async () => {
      expect(stylesheet).toContain(selector);
      const source = await Bun.file(new URL(provider, import.meta.url)).text();
      expect(source).toContain(markup);
    });
  }
});

/** Every `--color-*` declaration in the first block with this selector. */
function tokensOf(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);

  let depth = 0;
  let end = css.length;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }

  const tokens: Record<string, string> = {};
  for (const [, name, value] of css.slice(start, end).matchAll(/--color-([\w-]+):\s*([^;]+);/g)) {
    if (name && value) tokens[name] = value.trim();
  }
  return tokens;
}

/**
 * Brutal's sidebar is the one scope that flips polarity, and a floating menu
 * anchored inside it inherits that flip: the menu is `position: fixed` but
 * still a DOM child of the sidebar, and custom properties do not care where a
 * box is painted. A menu opened from the theme button rendered pale grey on
 * cream paper until `.floating` restored the light values.
 *
 * CSS has no "inherit from :root" for a custom property, so that restore is a
 * second copy of the `html.brutal` block in theme.css — and a copy drifts. Two
 * ways it goes wrong, both invisible except inside a menu opened from the
 * sidebar, which is the last place anyone looks: a colour changes in theme.css
 * and the copy keeps the old one, or the sidebar starts re-pointing a token
 * the copy never learned to restore.
 */
describe("brutal's floating restore", () => {
  const theme = tokensOf(palette, "html.brutal");
  const restored = tokensOf(stylesheet, "html.brutal .floating");
  const sidebar = tokensOf(stylesheet, 'html.brutal aside[aria-label="Workspace"]');

  test("the blocks were actually found", () => {
    // Without this every assertion below passes on three empty objects.
    expect(theme.app).toBeDefined();
    expect(Object.keys(restored).length).toBeGreaterThan(10);
    expect(Object.keys(sidebar).length).toBeGreaterThan(10);
  });

  test("every restored token still matches theme.css", () => {
    const drifted = Object.entries(restored)
      .filter(([name, value]) => theme[name] !== value)
      .map(([name, value]) => `${name}: ${value} (theme.css says ${theme[name]})`);

    expect(drifted).toEqual([]);
  });

  test("every token the sidebar re-points is restored", () => {
    const missing = Object.keys(sidebar).filter((name) => !(name in restored));

    expect(missing).toEqual([]);
  });
});

/**
 * The other thing the skins hang off and do not own: the dock breakpoint.
 *
 * Everything ornamental gets out of the way below it, because down there the
 * sidebar is a drawer and every pixel is contested. Each of those blocks used
 * to hand-copy --breakpoint-dock, one per skin, under a comment explaining
 * that a media query cannot read a custom property — and moving the token left
 * every copy behind, quietly and one-sidedly: the layout switches at the new
 * width while the ornaments keep hiding at the old one, so for the band
 * between them the drawer is drawn with a rail through it. Nothing throws.
 *
 * `theme()` reads the token at build time, which is what retired the copies.
 * This is the same invariant from the other end — a literal creeping back in
 * is a copy nobody will remember to move.
 */
describe("the dock breakpoint the skins hang off", () => {
  // Lazy up to `) {`, not `[^)]+`: the value is itself a call with a paren in
  // it, and a greedy-free character class stops halfway through `theme(…)`.
  const dockQueries = [...stylesheet.matchAll(/@media \(width < (.+?)\) \{/g)].map((m) => m[1]);

  test("the queries were actually found", () => {
    // Without this the assertion below passes on an empty set.
    expect(dockQueries.length).toBeGreaterThan(2);
    expect(palette).toMatch(/--breakpoint-dock:\s*\d+px/);
  });

  test("every width query reads the token rather than repeating its value", () => {
    expect([...new Set(dockQueries)]).toEqual(["theme(--breakpoint-dock)"]);
  });
});
