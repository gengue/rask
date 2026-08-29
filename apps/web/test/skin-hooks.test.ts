import { describe, expect, test } from "bun:test";

/**
 * The easter-egg skins (Ember, Brutal, Cyberpunk) hang off selectors they do
 * not own:
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
  // The view's name, which both skins repaint as a plate.
  { selector: "main header h1", provider: "../src/App.tsx", markup: "<h1" },
  // Cyberpunk only, from here down.
  // The HUD strips hang off #root, which is in the page, not in a component.
  { selector: "#root", provider: "../index.html", markup: 'id="root"' },
  // The detail panel's own title bar, where "TASK DETAILS" is injected.
  {
    selector: 'aside[aria-label="Task detail"] header',
    provider: "../src/components/TaskDetail.tsx",
    markup: "<header",
  },
  // The task title, which is a textarea while it is being edited.
  {
    selector: "textarea.text-lg",
    provider: "../src/components/TaskDetail.tsx",
    markup: "text-lg",
  },
  // The property rail's label, which exists only to be repainted.
  {
    selector: ".field-label",
    provider: "../src/components/TaskDetail.tsx",
    markup: "field-label",
  },
  // The list header band, which both skins repaint. A marker class rather than
  // `main > div > header`: that middle div only carries `hidden`, so unwrapping
  // it is a change nobody would think twice about.
  { selector: ".view-header", provider: "../src/App.tsx", markup: "view-header" },
  // The four labels the app title-cases from data. Both skins read the
  // presentational utility as the marker, the way they read `.uppercase`.
  { selector: ".capitalize", provider: "../src/components/TaskList.tsx", markup: "capitalize" },
  // The count beside the view's name, which both skins turn into a plate.
  { selector: ".bg-chip", provider: "../src/App.tsx", markup: "bg-chip" },
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
