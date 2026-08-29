import { createSignal } from "solid-js";

export type ThemeChoice =
  | "system"
  | "light"
  | "dark"
  | "ember"
  | "brutal"
  | "xp"
  | "aqua"
  | "cyber";

/**
 * Ordered so "System", the default, comes first. Everything below "Dark" is an
 * easter egg — extra themes rather than extra modes, which is what turned the
 * cycling button into a menu: eight states behind one blind press is a slot
 * machine.
 *
 * The third column is which way round the theme paints, and it is here rather
 * than in a predicate because it was becoming a list of its own: `apply` below,
 * the inline script in index.html, and `e2e/appearance.spec.ts` each carried
 * their own `theme === "dark" || theme === "ember"`, and every light theme
 * added made all three longer. Getting it wrong is quiet — native scrollbars
 * and date pickers painted the wrong way round, nothing else.
 *
 * "system" is nominally light here and never used: it resolves to one of the
 * other two before anything reads this.
 */
export const THEMES: ReadonlyArray<readonly [ThemeChoice, string, "light" | "dark"]> = [
  ["system", "System", "light"],
  ["light", "Light", "light"],
  ["dark", "Dark", "dark"],
  ["ember", "Ember", "dark"],
  ["brutal", "Brutalist", "light"],
  ["xp", "Windows XP", "light"],
  ["aqua", "Aqua", "light"],
  ["cyber", "Cyberpunk", "dark"],
];

/** Which way round a theme paints, for the two copies that cannot import it. */
export function themePolarity(choice: Exclude<ThemeChoice, "system">): "light" | "dark" {
  return THEMES.find(([value]) => value === choice)?.[2] ?? "light";
}

export function themeLabel(choice: ThemeChoice): string {
  return THEMES.find(([value]) => value === choice)?.[1] ?? "System";
}

/** Shared with the inline script in index.html, which reads it before we run. */
const KEY = "rask.theme";

/**
 * Light and dark, and following the machine.
 *
 * Three states rather than a toggle, because "system" is not the same as
 * whichever of the two the system currently is: a toggle set to dark at noon
 * stays dark when the laptop turns itself light at sunset, and the user has to
 * come back and flip it again. "system" is the default and is stored as the
 * absence of a key, so a fresh profile follows the OS with nothing written.
 *
 * The class is already on <html> by the time this module is imported — the
 * inline script put it there from this same key, which is what keeps the first
 * paint from being the wrong colour. Everything here is about the second paint
 * onwards.
 */
/*
 * Null outside a browser.
 *
 * `bun test` has no window, and the theme's cycling order is worth a test — so
 * this module has to be importable without one. Every browser access below is
 * behind this, and in a browser it is never null, so nothing is conditional at
 * runtime where it matters.
 */
const media =
  typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");

function read(): ThemeChoice {
  try {
    // Off the list rather than a chain of equality checks: this was the third
    // place a theme's name had to be spelled, and the one where getting it
    // wrong is silent — an unrecognised name is not an error, it is System.
    const stored = localStorage.getItem(KEY);
    return THEMES.find(([value]) => value === stored)?.[0] ?? "system";
  } catch {
    return "system";
  }
}

const [choice, setChoice] = createSignal<ThemeChoice>(read());
const [systemDark, setSystemDark] = createSignal(media?.matches ?? false);

export const themeChoice = choice;

export function resolvedTheme(): Exclude<ThemeChoice, "system"> {
  const value = choice();
  if (value !== "system") return value;
  return systemDark() ? "dark" : "light";
}

/**
 * Not an effect: the theme outlives every component, and a createEffect out
 * here would need a createRoot to own it. Two call sites, called directly.
 */
function apply(): void {
  if (!media) return;
  const theme = resolvedTheme();
  const root = document.documentElement;
  // Also off the list. "system" is on it and is never what resolves, so its
  // class is toggled off on every pass and never on.
  for (const [value] of THEMES) root.classList.toggle(value, value === theme);
  root.style.colorScheme = themePolarity(theme);
}

media?.addEventListener("change", (event) => {
  setSystemDark(event.matches);
  apply();
});

export function setTheme(next: ThemeChoice): void {
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Nothing to persist to. The choice still applies for this session.
  }
  setChoice(next);
  apply();
}
