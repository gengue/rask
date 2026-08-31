import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every resource accessor has to be read through `lib/resource.ts`.
 *
 * The router wraps each route match in a Suspense boundary with no fallback,
 * so a plain `resource()` read while a fetch is in flight unmounts the whole
 * page for the length of the round trip — and both `resource()` and
 * `resource.latest` re-throw the fetcher's rejection, which with no
 * ErrorBoundary anywhere takes the page down for good. `heldValue` and
 * `readyValue` exist so no render path ever does either. Nothing in the types
 * enforces that: the next `createResource` call site that reads its accessor
 * raw compiles clean, works on the happy path, and reintroduces the blank
 * flash only when a fetch is slow enough to see. Nobody reads that failure
 * correctly the first time, so the invariant is asserted over the source.
 *
 * Flagged: `accessor()` and `accessor.latest`, in the file that created the
 * resource. Fine: `heldValue(accessor)` / `readyValue(accessor)` and the
 * non-throwing flags `.state` / `.error` / `.loading`.
 */

const src = join(import.meta.dir, "..", "src");

/**
 * Plain reads vetted by hand, as `"<file> <accessor>"`. The one shape that
 * belongs here: a resource built with an `initialValue` whose fetcher catches
 * its own rejections — it resolves at birth and never errors, so the raw
 * accessor cannot suspend or throw. Entries that stop matching a binding fail
 * the sweep, so the list cannot outlive the code it excuses.
 */
const ALLOWED = new Set<string>([]);

/** Blank out comments without moving anything: mentions like "never
 * `entries()`" in a doc comment must not read as violations, and reported
 * line numbers have to survive the stripping. A `//` inside a string literal
 * would over-strip its tail — that can only hide a violation on a line odd
 * enough to get looked at anyway. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

describe("every resource accessor in apps/web", () => {
  // The helpers land with `lib/resource.ts`; until that file exists there is
  // no discipline to enforce and the sweep reports itself skipped, not green.
  test.skipIf(!existsSync(join(src, "lib", "resource.ts")))(
    "is read through heldValue/readyValue or the non-throwing flags",
    async () => {
      const offenders: string[] = [];
      const seen = new Set<string>();

      for (const name of await readdir(src, { recursive: true })) {
        if (!/\.tsx?$/.test(name)) continue;
        const source = stripComments(await readFile(join(src, name), "utf8"));

        // Each accessor this file binds, from `const [name, ...] = createResource`.
        const bindings = [
          ...source.matchAll(/(export\s+)?const \[(\w+)[^\]]*\]\s*=\s*createResource\b/g),
        ];
        // A call the binding regex did not recognise would silently exempt its
        // accessor from the sweep, so an unmatched shape is itself a failure.
        const calls = [...source.matchAll(/(?<![.\w])createResource\s*[<(]/g)];
        if (calls.length !== bindings.length) {
          offenders.push(
            `${name}: ${calls.length} createResource call(s) but ${bindings.length} ` +
              `recognised binding(s) — bind as \`const [x, ...] = createResource\``,
          );
        }

        for (const binding of bindings) {
          const accessor = binding[2];
          // The sweep only reads the binding file, so an exported accessor
          // could be read raw anywhere else and never show up here. Refuse the
          // export rather than pretend to have looked.
          if (binding[1]) {
            offenders.push(`${name}: exported resource accessor \`${accessor}\` escapes the sweep`);
          }
          seen.add(`${name} ${accessor}`);
          if (ALLOWED.has(`${name} ${accessor}`)) continue;
          // `?.()`, `?.latest` and `!.latest` are raw reads too, spelled shyly.
          const raw = new RegExp(
            String.raw`(?<![.\w])${accessor}\s*(?:\?\.)?\(|(?<![.\w])${accessor}\s*[?!]?\.\s*latest\b`,
            "g",
          );
          for (const match of source.matchAll(raw)) {
            offenders.push(`${name}:${lineOf(source, match.index)}: ${match[0].trim()}`);
          }
        }
      }

      for (const entry of ALLOWED) {
        if (!seen.has(entry)) offenders.push(`stale allow-list entry: "${entry}"`);
      }

      expect(offenders).toEqual([]);
    },
  );
});
