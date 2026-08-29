/**
 * Prints the WCAG contrast of every theme token pair, and exits non-zero if any
 * is below AA.
 *
 *     bun run --cwd apps/web contrast
 *
 * Separate from `src/lib/contrast.ts` because that half has to typecheck as
 * browser code, and this half reads a file and exits a process.
 */
import { audit, parseThemes } from "../src/lib/contrast.ts";

const css = await Bun.file(new URL("../src/theme.css", import.meta.url)).text();
const themes = parseThemes(css);
const findings = audit(themes);
const failures = findings.filter((f) => f.ratio < f.min);

for (const theme of Object.keys(themes)) {
  console.log(`\n${theme}`);
  for (const finding of findings.filter((entry) => entry.theme === theme)) {
    const mark = finding.ratio < finding.min ? "FAIL" : "ok  ";
    console.log(
      `  ${mark} ${finding.ink} on ${finding.surface}: ${finding.ratio.toFixed(2)}:1 (min ${finding.min})`,
    );
  }
}

console.log(
  failures.length === 0
    ? `\n${findings.length} pairs, all clear WCAG AA.`
    : `\n${failures.length} of ${findings.length} pairs below AA.`,
);
process.exit(failures.length === 0 ? 0 : 1);
