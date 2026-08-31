import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The markdown editor is only ever reached through `lazy()`.
 *
 * CodeMirror and its lezer grammars are about 1.1MB of the source that goes
 * into the bundle — the largest thing in it by a distance — and none of it is
 * needed to read a task or a Doc. `TaskDetail` and `DocReader` both split it
 * out for that reason.
 *
 * One static `import { MarkdownEditor }` anywhere in the eagerly-loaded graph
 * undoes the split for the whole app, and nothing about that looks wrong: the
 * types are fine, the editor works, and the only symptom is that first paint
 * got a megabyte heavier on every page. It happened once already, and what
 * caught it was `render-stability.spec.ts` timing out on `page.goto` three
 * minutes into CI — the module it holds to prove the page survives a chunk
 * download had become part of the initial load. That is an expensive and
 * badly-signposted way to learn this, so it is asserted over the source too.
 */

const src = join(import.meta.dir, "..", "src");

/** The module itself, which of course imports its own dependencies. */
const SELF = join("components", "MarkdownEditor.tsx");

describe("MarkdownEditor", () => {
  test("is imported lazily everywhere, never statically", async () => {
    const offenders: string[] = [];

    for (const name of await readdir(src, { recursive: true })) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      if (name === SELF) continue;

      const source = await readFile(join(src, name), "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        // A static import declaration naming the module. `import(...)` inside
        // a `lazy()` is an expression and never matches this.
        if (/^\s*import\b[^(]*\bfrom\s+["'].*MarkdownEditor\.tsx["']/.test(line)) {
          offenders.push(`${name}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /*
   * The other half. A lazy component suspends to the nearest boundary, and the
   * router wraps each route match in one with no fallback — so a `lazy()`
   * without a `Suspense` of its own blanks the whole route for the length of
   * the download instead of the corner that asked for the editor.
   */
  test("has a Suspense boundary in every file that lazies it", async () => {
    const missing: string[] = [];

    for (const name of await readdir(src, { recursive: true })) {
      if (!name.endsWith(".tsx")) continue;

      const source = await readFile(join(src, name), "utf8");
      if (!source.includes('import("./MarkdownEditor.tsx")')) continue;
      if (!source.includes("<Suspense")) missing.push(name);
    }

    // Both call sites, so a third one that forgets the boundary is not the
    // first thing this test ever sees.
    expect(missing).toEqual([]);
  });
});
