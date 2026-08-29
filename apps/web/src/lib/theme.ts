import { createSignal } from "solid-js";

export type ThemeChoice = "system" | "light" | "dark" | "ember" | "brutal" | "aqua";

/**
 * Ordered so "System", the default, comes first. "Ember", "Brutalist" and
 * "Aqua" are the easter eggs — extra themes rather than extra modes, which is
 * what turned the cycling button into a menu: six states behind one blind
 * press is a slot machine.
 */
export const THEMES: ReadonlyArray<readonly [ThemeChoice, string]> = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
  ["ember", "Ember"],
  ["brutal", "Brutalist"],
  ["aqua", "Aqua"],
];

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
    const stored = localStorage.getItem(KEY);
    /*
     * Matched against THEMES rather than against a second copy of the names.
     * The copy was five `||`s that had to grow by one every time a theme was
     * added, in a function whose failure mode is silent: an unrecognised value
     * falls through to "system", so a theme left out here is one that simply
     * does not survive a reload. "system" is stored as the absence of the key
     * and so never matches, which is the same answer as the fallback.
     */
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
  // One class per theme, off the same list, so the only two things a new theme
  // needs from this module are its row in THEMES and a side below.
  for (const [value] of THEMES) root.classList.toggle(value, value === theme);
  // Which side each theme takes for native controls and scrollbars. Ember is
  // dark despite not being named "dark"; Brutal paints on cream and Aqua on
  // white metal, so both side with light.
  root.style.colorScheme = theme === "dark" || theme === "ember" ? "dark" : "light";
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
