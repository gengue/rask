import { describe, expect, test } from "bun:test";
import { type DocSection, hiddenSections, splitSections } from "../src/lib/doc-sections.ts";

/**
 * Cutting a rendered Doc page into foldable sections.
 *
 * Every failure here is silent: a section that swallows the one after it, or a
 * heading cut out of the blockquote it belongs to, both still render. The page
 * just quietly says something else than it did, and on a Doc nobody has a
 * second copy of — a Doc body is never mirrored — there is nothing to compare
 * it against.
 */

const ids = (sections: readonly DocSection[]): string[] => sections.map((s) => s.id);

describe("splitSections", () => {
  test("keeps a page with no headings whole, as one intro", () => {
    const html = "<p>One</p>\n<p>Two</p>";
    expect(splitSections(html)).toEqual({ intro: html, sections: [] });
  });

  test("gives each heading everything up to the next one", () => {
    const { intro, sections } = splitSections(
      "<p>Before</p>\n<h2>Alpha</h2>\n<p>A body</p>\n<h2>Beta</h2>\n<p>B body</p>",
    );
    expect(intro).toBe("<p>Before</p>");
    expect(sections.map((s) => [s.level, s.text, s.body])).toEqual([
      [2, "Alpha", "<p>A body</p>"],
      [2, "Beta", "<p>B body</p>"],
    ]);
  });

  test("keeps the heading's own markup, so a code span in a title survives", () => {
    const [section] = splitSections("<h3>Use <code>--bun</code></h3>\n<p>x</p>").sections;
    expect(section?.heading).toBe("Use <code>--bun</code>");
    expect(section?.text).toBe("Use --bun");
  });

  test("does not cut at a heading inside a blockquote, which would unbalance both halves", () => {
    // `> ## Quoted` renders this way; slicing here leaves a blockquote with no
    // end and a fragment that starts with a stray close tag.
    const html = "<h2>Real</h2>\n<blockquote>\n<h2>Quoted</h2>\n<p>q</p>\n</blockquote>";
    const { sections } = splitSections(html);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.body).toBe("<blockquote>\n<h2>Quoted</h2>\n<p>q</p>\n</blockquote>");
  });

  test("counts void tags as void, or an image stops every heading below it folding", () => {
    const { sections } = splitSections('<h2>One</h2>\n<p><img src="x.png"><br></p>\n<h2>Two</h2>');
    expect(ids(sections)).toEqual(["h2-one", "h2-two"]);
  });

  test("gives repeated headings distinct ids, so folding one does not fold both", () => {
    const { sections } = splitSections("<h2>Notes</h2>\n<p>a</p>\n<h2>Notes</h2>\n<p>b</p>");
    expect(ids(sections)).toEqual(["h2-notes", "h2-notes-1"]);
  });

  test("slugs a heading in any script rather than collapsing it to dashes", () => {
    const { sections } = splitSections("<h2>Envíos 中文</h2>");
    expect(ids(sections)).toEqual(["h2-envíos-中文"]);
  });

  test("decodes the entities the sanitizer wrote, so the label reads as the heading", () => {
    const [section] = splitSections("<h2>Tom &amp; Jerry &quot;live&quot;</h2>").sections;
    expect(section?.text).toBe('Tom & Jerry "live"');
  });

  test("leaves a heading with nothing under it an empty body, not the next section", () => {
    const { sections } = splitSections("<h1>Title</h1>\n<h2>Sub</h2>\n<p>x</p>");
    expect(sections.map((s) => s.body)).toEqual(["", "<p>x</p>"]);
  });
});

describe("hiddenSections", () => {
  const outline = splitSections(
    [
      "<h1>One</h1>",
      "<p>a</p>",
      "<h2>One A</h2>",
      "<p>b</p>",
      "<h3>One A i</h3>",
      "<p>c</p>",
      "<h2>One B</h2>",
      "<p>d</p>",
      "<h1>Two</h1>",
      "<p>e</p>",
    ].join("\n"),
  ).sections;

  const hiddenWith = (...folded: string[]): string[] => [
    ...hiddenSections(outline, (id) => folded.includes(id)),
  ];

  test("hides nothing while nothing is folded", () => {
    expect(hiddenWith()).toEqual([]);
  });

  test("folding a heading takes its subheadings with it, not just its paragraphs", () => {
    expect(hiddenWith("h2-one-a")).toEqual(["h3-one-a-i"]);
  });

  test("stops at the next heading of the same level or higher", () => {
    expect(hiddenWith("h1-one")).toEqual(["h2-one-a", "h3-one-a-i", "h2-one-b"]);
  });

  test("a section folded under a folded ancestor keeps its own state for later", () => {
    // `h2-one-a` is hidden either way; what matters is that unfolding `h1-one`
    // leaves it folded rather than open, which is what not stacking it gives.
    expect(hiddenWith("h1-one", "h2-one-a")).toEqual(["h2-one-a", "h3-one-a-i", "h2-one-b"]);
    expect(hiddenWith("h2-one-a")).toEqual(["h3-one-a-i"]);
  });
});
