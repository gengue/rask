import { describe, expect, test } from "bun:test";
import { renderCommentBody } from "../src/comment-body.ts";
import { type ClickUpCommentSegment, clickUpComment } from "../src/schemas.ts";
import imageComment from "./fixtures/comment-with-image.json" with { type: "json" };

/**
 * The segment shapes here are copied out of the Ventura workspace, not out of
 * the formatting guide: the guide documents what a client may send, and what
 * comes back has types it never mentions.
 */
const render = (segments: unknown[]) => renderCommentBody(segments as ClickUpCommentSegment[]);

describe("a real comment carrying a screenshot", () => {
  const parsed = clickUpComment.parse(imageComment);

  test("ClickUp's own flattening loses the image", () => {
    // This is the bug: the whole visible body of this comment was "image.png".
    expect(parsed.comment_text).toBe("@Soledad Cruz I created a new version\nimage.png\n");
  });

  test("the segments render to markdown that still has it", () => {
    expect(renderCommentBody(parsed.comment)).toBe(
      "@[Soledad Cruz](clickup://user/2465931) I created a new version\n" +
        "![image.png](https://t529.p.clickup-attachments.com/t529/" +
        "0ed173fb-2acb-4479-a3b9-24610aa6b60a/image.png?view=open)",
    );
  });
});

describe("nothing to render", () => {
  test("no segments", () => {
    expect(renderCommentBody(null)).toBeNull();
    expect(renderCommentBody([])).toBeNull();
  });

  test("segments that are only line breaks", () => {
    expect(render([{ text: "\n", attributes: { "block-id": "block-1" } }])).toBeNull();
  });
});

describe("mentions", () => {
  test("become the dialect the composer already writes", () => {
    expect(
      render([
        { type: "tag", user: { id: 2465931, username: "Soledad Cruz" }, text: "@Soledad Cruz" },
        { text: " ping", attributes: {} },
      ]),
    ).toBe("@[Soledad Cruz](clickup://user/2465931) ping");
  });

  test("fall back to the flat @Name when ClickUp omits the user", () => {
    // One tag in ten arrives without one, and a chip for nobody is a lie.
    expect(render([{ type: "tag", text: "@Soledad Cruz" }])).toBe("@Soledad Cruz");
  });

  test("prefer the username over the text, which carries the @", () => {
    expect(render([{ type: "tag", user: { id: 7 }, text: "@Ada" }])).toBe(
      "@[Ada](clickup://user/7)",
    );
  });

  test("@assignees stays text, because it identifies nobody in particular", () => {
    expect(render([{ text: "@assignees", type: "assignees_tag" }, { text: " look" }])).toBe(
      "@assignees look",
    );
  });
});

describe("files", () => {
  const image = {
    type: "image",
    text: "image.png",
    image: { name: "shot.png", title: "shot.png", url: "https://t529.p.clickup-attachments.com/a" },
  };

  test("an image becomes an image, opened inline rather than downloaded", () => {
    expect(render([image])).toBe("![shot.png](https://t529.p.clickup-attachments.com/a?view=open)");
  });

  test("view=open is not added twice", () => {
    expect(render([{ ...image, image: { ...image.image, url: "https://x/a?view=open" } }])).toBe(
      "![shot.png](https://x/a?view=open)",
    );
  });

  test("an image with no URL degrades to its file name", () => {
    expect(render([{ ...image, image: { name: "shot.png" } }])).toBe("image.png");
  });

  test("a screen recording becomes a link, named from ClickUp's own filename", () => {
    expect(
      render([
        {
          type: "frame",
          frame: {
            id: "ba48.webm",
            service: "clickup_video",
            url: "https://t529.p.clickup-attachments.com/t529/ba48/ba48.webm?filename=rec.webm&open=true",
          },
          text: "https://t529.p.clickup-attachments.com/t529/ba48/ba48.webm",
        },
      ]),
    ).toBe(
      "[rec.webm](https://t529.p.clickup-attachments.com/t529/ba48/ba48.webm" +
        "?filename=rec.webm&open=true&view=open)",
    );
  });

  test("an uploaded image uses ClickUp's own inline URL", () => {
    // Older comments carry images as `attachment`, and it is the one shape
    // that says outright which URL serves the file inline.
    expect(
      render([
        {
          type: "attachment",
          text: "Screenshot.png",
          attachment: {
            title: "Screenshot.png",
            mimetype: "image/png",
            url: "https://t529.p.clickup-attachments.com/t529/97dd/Screenshot.png",
            url_w_query:
              "https://t529.p.clickup-attachments.com/t529/97dd/Screenshot.png?view=open",
          },
        },
      ]),
    ).toBe(
      "![Screenshot.png](https://t529.p.clickup-attachments.com/t529/97dd/Screenshot.png?view=open)",
    );
  });

  test("a non-image upload is a link, not a broken image", () => {
    expect(
      render([
        {
          type: "attachment",
          text: "invoice.pdf",
          attachment: {
            title: "invoice.pdf",
            mimetype: "application/pdf",
            url: "https://t529.p.clickup-attachments.com/t529/97dd/invoice.pdf",
          },
        },
      ]),
    ).toBe("[invoice.pdf](https://t529.p.clickup-attachments.com/t529/97dd/invoice.pdf?view=open)");
  });

  test("two files in a row get a line each", () => {
    // ClickUp sends them with nothing in between: comment_text for this exact
    // comment reads "Reiseunterlagen_Pax Peisch.pdfRechnung Peisch.pdf".
    const pdf = (title: string, url: string) => ({
      type: "attachment",
      text: title,
      attachment: { title, mimetype: "application/pdf", url },
    });

    expect(render([pdf("a.pdf", "https://x/a.pdf"), pdf("b.pdf", "https://x/b.pdf")])).toBe(
      "[a.pdf](https://x/a.pdf?view=open)\n[b.pdf](https://x/b.pdf?view=open)",
    );
  });

  test("parentheses in a URL do not end the link early", () => {
    expect(
      render([
        { type: "image", text: "x.png", image: { name: "x.png", url: "https://x/a(1).png" } },
      ]),
    ).toBe("![x.png](https://x/a%281%29.png?view=open)");
  });
});

describe("links and references", () => {
  test("a bookmark is a link to itself", () => {
    expect(render([{ type: "bookmark", bookmark: { url: "https://go.example.org/x" } }])).toBe(
      "[https://go.example.org/x](https://go.example.org/x)",
    );
  });

  test("a link mention keeps its label", () => {
    expect(
      render([
        {
          text: "Task Comment mention 901",
          type: "link_mention",
          link_mention: { url: "https://app.clickup.com/t/529/86c98b7p1?comment=901" },
        },
      ]),
    ).toBe("[Task Comment mention 901](https://app.clickup.com/t/529/86c98b7p1?comment=901)");
  });

  test("a task mention becomes a URL, since the bare id links nowhere", () => {
    expect(
      render([
        {
          type: "task_mention",
          task_mention: { task_id: "86c7p0tvt", team_id: 529 },
          text: "86c7p0tvt",
        },
      ]),
    ).toBe("[86c7p0tvt](https://app.clickup.com/t/529/86c7p0tvt)");
  });

  test("an inline link wraps only the words it covers", () => {
    expect(
      render([
        { text: "see ", attributes: {} },
        { text: "this page", attributes: { link: "https://example.com/a" } },
        { text: " today", attributes: {} },
      ]),
    ).toBe("see [this page](https://example.com/a) today");
  });

  test("brackets in link text are escaped rather than ending it", () => {
    expect(render([{ text: "a [b] c", attributes: { link: "https://x/" } }])).toBe(
      "[a \\[b\\] c](https://x/)",
    );
  });
});

describe("inline formatting", () => {
  test("bold, italic, strike and code", () => {
    expect(render([{ text: "loud", attributes: { bold: true } }])).toBe("**loud**");
    expect(render([{ text: "soft", attributes: { italic: true } }])).toBe("*soft*");
    expect(render([{ text: "gone", attributes: { strike: true } }])).toBe("~~gone~~");
    expect(render([{ text: "check-hotel.ts:24", attributes: { code: true } }])).toBe(
      "`check-hotel.ts:24`",
    );
  });

  test("trailing space stays outside the marks, or markdown ignores them", () => {
    expect(
      render([
        { text: "Implementation traps: ", attributes: { bold: true } },
        { text: "here", attributes: {} },
      ]),
    ).toBe("**Implementation traps:** here");
  });

  test("a backtick inside a code run drops the mark instead of breaking the line", () => {
    expect(render([{ text: "a ` b", attributes: { code: true } }])).toBe("a ` b");
  });

  test("a run that is only whitespace is left alone", () => {
    expect(render([{ text: "a" }, { text: "  ", attributes: { bold: true } }, { text: "b" }])).toBe(
      "a  b",
    );
  });
});

describe("blocks", () => {
  test("a line break attribute closes the line it is attached to", () => {
    expect(
      render([
        { text: "first" },
        { text: "\n", attributes: { "block-id": "b1" } },
        { text: "second" },
        { text: "\n", attributes: { "block-id": "b2" } },
      ]),
    ).toBe("first\nsecond");
  });

  test("bullet and ordered lists", () => {
    expect(
      render([
        { text: "one" },
        { text: "\n", attributes: { list: "ordered" } },
        { text: "two" },
        { text: "\n", attributes: { list: "ordered" } },
      ]),
    ).toBe("1. one\n1. two");

    expect(render([{ text: "a" }, { text: "\n", attributes: { list: "bullet" } }])).toBe("- a");
  });

  test("the object form of `list`, which turns up on adjacent lines", () => {
    expect(
      render([{ text: "a" }, { text: "\n", attributes: { list: { list: "bullet" }, indent: 1 } }]),
    ).toBe("  - a");
  });

  test("checklists keep their state", () => {
    expect(render([{ text: "done" }, { text: "\n", attributes: { list: "checked" } }])).toBe(
      "- [x] done",
    );
    expect(render([{ text: "todo" }, { text: "\n", attributes: { list: "unchecked" } }])).toBe(
      "- [ ] todo",
    );
  });

  test("a run may carry several lines and format all of them", () => {
    expect(render([{ text: "a\nb\n", attributes: { list: "bullet" } }])).toBe("- a\n- b");
  });
});

describe("tables", () => {
  const table = {
    type: "table-embed",
    "table-embed": {
      rows: [{ insert: { id: "r1" } }, { insert: { id: "r2" } }],
      columns: [{ insert: { id: "c1" } }, { insert: { id: "c2" } }],
      cells: {
        "1:1": { content: [{ insert: "Principle", attributes: {} }] },
        "1:2": { content: [{ insert: "Summary", attributes: {} }] },
        "2:1": { content: [{ insert: "Data > Tier", attributes: { bold: true } }] },
        "2:2": { content: [{ insert: "Ranking outweighs type", attributes: {} }] },
      },
    },
  };

  test("become a GFM table instead of the word 'undefined'", () => {
    // Which is literally what ClickUp's own flattening puts there.
    expect(render([table])).toBe(
      "| Principle | Summary |\n" +
        "| --- | --- |\n" +
        "| **Data > Tier** | Ranking outweighs type |",
    );
  });

  test("stand alone, so the line before them does not swallow them", () => {
    expect(render([{ text: "as agreed:" }, table])).toBe(
      "as agreed:\n\n| Principle | Summary |\n| --- | --- |\n| **Data > Tier** | Ranking outweighs type |",
    );
  });

  test("a pipe inside a cell does not open a new column", () => {
    expect(
      render([
        {
          type: "table-embed",
          "table-embed": {
            rows: [{ insert: {} }],
            columns: [{ insert: {} }],
            cells: { "1:1": { content: [{ insert: "a | b" }] } },
          },
        },
      ]),
    ).toBe("| a \\| b |\n| --- |");
  });

  test("an empty table renders nothing rather than an empty grid", () => {
    expect(render([{ type: "table-embed", "table-embed": { rows: [], columns: [] } }])).toBeNull();
  });
});

describe("segment types we do not know yet", () => {
  test("degrade to the words they were carrying", () => {
    // Whatever ClickUp ships next, `text` is what comment_text would have had,
    // so an unhandled type costs the formatting and never the content.
    expect(render([{ type: "whiteboard_embed", text: "Q3 plan" }])).toBe("Q3 plan");
  });

  test("an emoji is already its own character", () => {
    expect(render([{ type: "emoticon", emoticon: { code: "1f642" }, text: "🙂" }])).toBe("🙂");
  });
});
