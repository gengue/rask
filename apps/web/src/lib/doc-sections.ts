/**
 * Cutting a rendered Doc page into foldable sections, by heading.
 *
 * `renderMarkdown` hands back one flat string: a heading and the paragraphs
 * under it are siblings, not parent and child, so the sections have to be found
 * after the fact. This reads that sanitized output rather than the markdown,
 * which is the point — DOMPurify stays the only path anything takes to the DOM,
 * and everything here only slices a string that has already been through it.
 *
 * Nothing in this file touches the DOM, so it is testable under `bun test`,
 * which has none. That is also why the split is a scanner over the string and
 * not a `DOMParser` walk.
 */

/** A heading and everything under it, up to the next heading of the same level or higher. */
export type DocSection = {
  /**
   * Stable while the heading keeps its words, which is what the fold state is
   * keyed on: a page edited above a section should not forget that it was
   * folded, and a renamed heading coming back open is the safe way to be wrong.
   */
  id: string;
  /** 1 to 6. */
  level: number;
  /** The heading's own inner markup, still sanitized. */
  heading: string;
  /** The same, flattened, for the toggle's label. */
  text: string;
  /** Everything between this heading and the next one, still sanitized. */
  body: string;
};

export type DocOutline = {
  /** Whatever came before the first heading. The whole page, when it has none. */
  intro: string;
  sections: DocSection[];
};

/**
 * Tags that never close, so they must not count towards depth — an `<img>`
 * read as an open element would push every heading after it below the top
 * level and the page would stop folding entirely.
 */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/*
 * `[^>]*` ends a tag at the first `>`, which an attribute value is allowed to
 * contain (the serializer escapes `&`, `"` and nbsp, not `>`). The cost is a
 * split tag whose tail holds no `<`, so no phantom element follows it and the
 * depth count survives; headings themselves carry no attributes at all.
 */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;

export function splitSections(html: string): DocOutline {
  const sections: DocSection[] = [];
  const used = new Map<string, number>();

  let depth = 0;
  let intro = html;
  let cut = false;
  // The heading currently open, then the section waiting for its body to end.
  let headingFrom: number | null = null;
  let headingLevel = 0;
  let pending: { level: number; heading: string; bodyFrom: number } | null = null;

  const finish = (end: number): void => {
    if (!pending) return;
    sections.push(build(pending.level, pending.heading, html.slice(pending.bodyFrom, end), used));
    pending = null;
  };

  TAG.lastIndex = 0;
  for (let match = TAG.exec(html); match !== null; match = TAG.exec(html)) {
    const name = (match[2] ?? "").toLowerCase();
    if (VOID.has(name)) continue;

    const closing = match[1] === "/";
    const level = name.length === 2 && name[0] === "h" ? Number(name[1]) : 0;
    const heading = level >= 1 && level <= 6;

    if (!closing) {
      // Only at the top level: `> ## quoted` renders the heading inside a
      // blockquote, and cutting there would leave both halves unbalanced.
      if (depth === 0 && heading) {
        finish(match.index);
        if (!cut) {
          cut = true;
          intro = html.slice(0, match.index);
        }
        headingFrom = TAG.lastIndex;
        headingLevel = level;
      }
      depth += 1;
      continue;
    }

    if (depth > 0) depth -= 1;
    if (depth === 0 && heading && headingFrom !== null) {
      pending = {
        level: headingLevel,
        heading: html.slice(headingFrom, match.index),
        bodyFrom: TAG.lastIndex,
      };
      headingFrom = null;
    }
  }
  finish(html.length);

  return { intro: intro.trim(), sections };
}

/**
 * The sections a reader cannot see because something above them is folded.
 *
 * Folding an H2 takes its H3s with it, which is the whole reason the levels
 * matter: a flat list that only hid its own paragraphs would leave the
 * subheadings behind, dangling under a heading that reads as empty.
 */
export function hiddenSections(
  sections: readonly DocSection[],
  folded: (id: string) => boolean,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  // Levels of the folded headings still in scope, outermost first.
  const open: number[] = [];

  for (const section of sections) {
    while (open.length > 0 && (open[open.length - 1] ?? 0) >= section.level) open.pop();
    if (open.length > 0) hidden.add(section.id);
    // Already hidden means an ancestor covers the descendants too, and leaving
    // this one off the stack is what lets its own state survive that ancestor
    // being opened again.
    else if (folded(section.id)) open.push(section.level);
  }
  return hidden;
}

function build(
  level: number,
  heading: string,
  body: string,
  used: Map<string, number>,
): DocSection {
  const text = plainText(heading);
  const base = `h${level}-${slug(text)}`;
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return { id: seen === 0 ? base : `${base}-${seen}`, level, heading, text, body: body.trim() };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
};

/** Enough to read a heading aloud. Anything unrecognised stays as it is. */
const plainText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#?[a-zA-Z0-9]+);/g, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, " ")
    .trim();

/**
 * Letters and numbers of any script, so a heading in Spanish or Chinese still
 * produces an id somebody could read in devtools rather than a row of dashes.
 */
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "section";
