import { describe, expect, test } from "bun:test";
import { attachmentMarkdown } from "../src/lib/attach.ts";

/**
 * The markdown a comment gets when a file is dropped on it.
 *
 * Both halves are hostile input. The label is a filename, which people put
 * brackets and backslashes in, and an unescaped one ends the link text early
 * and leaves the URL on screen as prose. The destination is a ClickUp CDN path
 * with that same filename inside it, and a space in a markdown URL ends the
 * destination early — the link still renders, pointing somewhere else.
 */

const CDN = "https://attachments-public.clickup.com/abc/shot.png";

function file(name: string, type = "image/png"): File {
  return new File([new Uint8Array([1])], name, { type });
}

function uploaded(over: Partial<Parameters<typeof attachmentMarkdown>[1]> = {}) {
  return { id: "abc.png", title: "shot.png", url: CDN, urlWithQuery: `${CDN}?view=open`, ...over };
}

describe("attachmentMarkdown", () => {
  test("embeds an image, pointing at the URL an <img> can load", () => {
    expect(attachmentMarkdown(file("shot.png"), uploaded())).toBe(`![shot.png](${CDN})`);
  });

  test("links anything else, pointing at the URL that opens instead of downloading", () => {
    const pdf = file("report.pdf", "application/pdf");
    const markdown = attachmentMarkdown(pdf, uploaded({ title: "report.pdf" }));
    expect(markdown).toBe(`[report.pdf](${CDN}?view=open)`);
  });

  test("escapes a bracket in the name, which would otherwise end the link text", () => {
    expect(attachmentMarkdown(file("v[2].png"), uploaded({ title: "v[2].png" }))).toBe(
      `![v\\[2\\].png](${CDN})`,
    );
  });

  test("escapes a backslash, which would otherwise escape the bracket after it", () => {
    expect(attachmentMarkdown(file("pa\\.png"), uploaded({ title: "pa\\.png" }))).toBe(
      `![pa\\\\.png](${CDN})`,
    );
  });

  test("encodes a space in the URL, which would otherwise end the destination", () => {
    const shot = uploaded({ url: "https://cdn/a b.png" });
    expect(attachmentMarkdown(file("a b.png"), shot)).toBe("![shot.png](https://cdn/a%20b.png)");
  });

  test("encodes parentheses in the URL, which would otherwise close the link", () => {
    const shot = uploaded({ url: "https://cdn/x(1).png" });
    expect(attachmentMarkdown(file("x.png"), shot)).toBe("![shot.png](https://cdn/x%281%29.png)");
  });

  test("falls back to the other URL when the mirror has not caught up", () => {
    const markdown = attachmentMarkdown(file("x.png"), uploaded({ url: null }));
    expect(markdown).toBe(`![shot.png](${CDN}?view=open)`);
  });

  test("falls back to the file's own name when ClickUp titled it nothing", () => {
    expect(attachmentMarkdown(file("local.png"), uploaded({ title: null }))).toContain(
      "[local.png]",
    );
  });
});
