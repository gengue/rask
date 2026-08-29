import { describe, expect, test } from "bun:test";

/**
 * Ember's set dressing hangs off selectors it does not own: aria-labels and
 * utility classes that live in component markup. A rename over there — the
 * detail panel's label, `bg-panel` becoming `bg-panel/95`, the section border
 * class — sheds the skin with no error anywhere, which is exactly the kind of
 * failure this repo pins with a test. Each row says: the stylesheet still
 * targets this hook, and the component still provides it.
 */
const stylesheet = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

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
];

describe("every selector hook the ember skin relies on", () => {
  for (const { selector, provider, markup } of HOOKS) {
    test(`${selector} is targeted by the stylesheet and provided by ${provider}`, async () => {
      expect(stylesheet).toContain(selector);
      const source = await Bun.file(new URL(provider, import.meta.url)).text();
      expect(source).toContain(markup);
    });
  }
});
