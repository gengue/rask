import { formatMention } from "./mentions.ts";
import type {
  ClickUpCommentAttributes,
  ClickUpCommentFile,
  ClickUpCommentSegment,
  ClickUpCommentTable,
} from "./schemas.ts";

/**
 * ClickUp's rich comment body, rendered to the markdown Rask stores.
 *
 * The flat `comment_text` ClickUp also sends is not a body, it is a search
 * index: a screenshot flattens to "image.png", a mention to "@Name", a screen
 * recording to a bare CDN URL. Everything that made the comment worth reading
 * is only in the `comment` array.
 *
 * This renders to markdown at ingest rather than mirroring the array, because
 * markdown is a format the app already has a sanitizer and a stylesheet for,
 * and because Rask's own outgoing comments are already written in this exact
 * dialect — `@[Name](clickup://user/123)` is what the composer produces and
 * what `toCommentSegments` turns back into a real tag. So an incoming comment
 * and a locally authored one end up in the same shape, and the UI has one code
 * path instead of two renderers. The cost is that this is lossy and one-way;
 * the mirror is rebuildable from ClickUp, so a better renderer is a resync
 * away rather than a migration.
 *
 * `comment_text` is stored unchanged next to this. Nothing here reaches
 * ClickUp: the write path still sends the flat text, so an edit or a resolve
 * cannot post markdown back into someone's comment.
 */

/** Runs that end a line rather than sitting inside one. */
const BLOCK_MARKERS: Record<string, string> = {
  bullet: "- ",
  ordered: "1. ",
  checked: "- [x] ",
  unchecked: "- [ ] ",
  toggled: "- ",
};

/** Deep enough for any real comment; past this ClickUp is not indenting, it is lying. */
const MAX_INDENT = 8;

/** Segment types that occupy a line of their own rather than sitting in one. */
const BLOCK_TYPES = new Set(["image", "attachment", "frame", "table-embed"]);

export function renderCommentBody(
  segments: ClickUpCommentSegment[] | null | undefined,
): string | null {
  if (!segments || segments.length === 0) return null;

  const lines: string[] = [];
  let line = "";

  for (const segment of segments) {
    if (segment.type) {
      const rendered = renderTyped(segment);
      // A file is a block in ClickUp's editor and arrives with no separator at
      // all — two PDFs in one comment flatten to "a.pdfb.pdf" — so it gets its
      // own line here rather than running into whatever sat beside it.
      if (BLOCK_TYPES.has(segment.type)) {
        if (line.length > 0) lines.push(line);
        lines.push(rendered);
        line = "";
      } else {
        line += rendered;
      }
      continue;
    }

    // A plain run may span several lines, and its attributes describe both the
    // words inside it and the block each of those lines belongs to.
    const parts = (segment.text ?? "").split("\n");
    line += inline(parts[0] ?? "", segment.attributes);
    for (const part of parts.slice(1)) {
      lines.push(blockPrefix(segment.attributes) + line);
      line = inline(part, segment.attributes);
    }
  }

  if (line.length > 0) lines.push(line);

  // Blank edges only. Trimming the whole string would eat the indentation of a
  // body that opens on a nested list item. Re-split first, because a table
  // arrives as one segment carrying the blank lines it needs around it.
  const body = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n");
  while (body.length > 0 && body[0]?.trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1]?.trim() === "") body.pop();

  return body.length > 0 ? body.join("\n") : null;
}

function renderTyped(segment: ClickUpCommentSegment): string {
  const text = segment.text ?? "";

  switch (segment.type) {
    case "tag": {
      const id = segment.user?.id;
      // A tag with no user identifies nobody, so there is no chip to build and
      // the flattened "@Name" is all ClickUp gave us.
      if (id == null || !Number.isFinite(id)) return text;
      return formatMention({ id, name: segment.user?.username ?? text.replace(/^@/, "") });
    }

    // A pasted screenshot. Always an image, and ClickUp says so by the key.
    case "image":
      return renderFile(segment.image, text, true);

    /*
     * An uploaded file. This is what older comments use even for images, and
     * the one shape that carries a mimetype, so it is the only place we can
     * tell a screenshot from a PDF rather than guess from the extension.
     */
    case "attachment":
      return renderFile(
        segment.attachment,
        text,
        (segment.attachment?.mimetype ?? "").startsWith("image/"),
      );

    // Screen recordings. A <video> would mean widening the sanitizer for one
    // segment in a thousand; a link opens the file inline in a new tab.
    case "frame":
      return renderFile(segment.frame, text, false);

    case "table-embed":
      return renderTable(segment["table-embed"]);

    case "bookmark": {
      const url = segment.bookmark?.url;
      return url ? `[${label(url)}](${encodeUrl(url)})` : text;
    }

    case "link_mention": {
      const url = segment.link_mention?.url;
      return url ? `[${label(text || url)}](${encodeUrl(url)})` : text;
    }

    case "task_mention": {
      const taskId = segment.task_mention?.task_id;
      if (!taskId) return text;
      const teamId = segment.task_mention?.team_id;
      const path = teamId ? `t/${teamId}/${taskId}` : `t/${taskId}`;
      return `[${label(text || taskId)}](https://app.clickup.com/${path})`;
    }

    // assignees_tag ("@assignees"), emoticon (text is the emoji itself), and
    // whatever ClickUp ships next. `text` is what the flat body would have
    // carried, so nothing is lost by falling through to it.
    default:
      return text;
  }
}

/** An image, or a link to a file. Falls back to the name when there is no URL. */
function renderFile(
  file: ClickUpCommentFile | null | undefined,
  text: string,
  isImage: boolean,
): string {
  const url = attachmentUrl(file?.url_w_query ?? file?.url ?? file?.src);
  if (!url) return text;
  const name = label(fileName(file?.title ?? file?.name ?? file?.id ?? text, url));
  return isImage ? `![${name}](${url})` : `[${name}](${url})`;
}

/**
 * A Quill table as a GFM table.
 *
 * Blank lines around it because a table that starts on the line after a
 * paragraph is not a table, it is more paragraph. Cell contents are flattened
 * to one line: markdown has no way to say otherwise, and the alternative is
 * dropping the table, which is what happens today — ClickUp's own flattening
 * renders one as the word "undefined".
 */
function renderTable(table: ClickUpCommentTable | null | undefined): string {
  const rows = table?.rows?.length ?? 0;
  const columns = table?.columns?.length ?? 0;
  if (rows === 0 || columns === 0) return "";

  const lines: string[] = [];
  for (let row = 1; row <= rows; row++) {
    const cells: string[] = [];
    for (let column = 1; column <= columns; column++) {
      cells.push(cellText(table?.cells?.[`${row}:${column}`]));
    }
    lines.push(`| ${cells.join(" | ")} |`);
    // GFM needs the delimiter row, and ClickUp's first row is the header.
    if (row === 1) lines.push(`| ${Array(columns).fill("---").join(" | ")} |`);
  }

  return `\n\n${lines.join("\n")}\n\n`;
}

function cellText(cell: { content?: unknown } | undefined): string {
  const content = Array.isArray(cell?.content) ? cell.content : [];
  return content
    .map((run) => {
      const value = (run as { insert?: unknown }).insert;
      if (typeof value !== "string") return "";
      return inline(value, (run as { attributes?: ClickUpCommentAttributes }).attributes);
    })
    .join("")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function inline(text: string, attributes: ClickUpCommentAttributes | null | undefined): string {
  if (text.length === 0 || !attributes) return text;

  // Markdown marks do not survive touching whitespace — `** bold **` renders
  // literally — and ClickUp routinely puts the trailing space inside the run.
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const lead = match?.[1] ?? "";
  const trail = match?.[3] ?? "";
  let core = match?.[2] ?? "";
  if (core.length === 0) return text;

  // A backtick inside the run would end the span early. Rare enough to be worth
  // dropping the mark rather than counting fences.
  if (attributes.code && !core.includes("`")) core = `\`${core}\``;
  if (attributes.bold) core = `**${core}**`;
  if (attributes.italic) core = `*${core}*`;
  if (attributes.strike) core = `~~${core}~~`;
  if (attributes.link) core = `[${label(core)}](${encodeUrl(attributes.link)})`;

  return lead + core + trail;
}

function blockPrefix(attributes: ClickUpCommentAttributes | null | undefined): string {
  const kind = listKind(attributes?.list);
  const marker = kind ? BLOCK_MARKERS[kind] : undefined;
  if (!marker) return "";
  const indent = Math.min(Math.max(attributes?.indent ?? 0, 0), MAX_INDENT);
  return "  ".repeat(indent) + marker;
}

function listKind(list: ClickUpCommentAttributes["list"]): string | null {
  if (typeof list === "string") return list;
  if (list && typeof list === "object" && typeof list.list === "string") return list.list;
  return null;
}

/**
 * The `?view=open` variant of an attachment URL.
 *
 * The bare URL is served with `Content-Disposition: attachment`, which makes a
 * new tab download the file instead of showing it. Same bytes, same cache, one
 * query parameter. Harmless on URLs that already carry ClickUp's own `open=true`.
 */
function attachmentUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("view")) url.searchParams.set("view", "open");
    return encodeUrl(url.toString());
  } catch {
    return null;
  }
}

/**
 * What to call a file.
 *
 * The URL's own `filename` wins: ClickUp only adds it when the path is a
 * generated id, which is exactly the case for a screen recording, where the
 * alternative is offering the reader a link labelled
 * "ba48aa64-b385-4ef9-a4ab-6676dfdcb943.webm".
 */
function fileName(name: string | null | undefined, url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("filename") || name || parsed.pathname.split("/").pop() || url;
  } catch {
    return name || url;
  }
}

/** Link text, with the brackets that would end it early escaped. */
function label(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`).replace(/\s*\n\s*/g, " ");
}

/**
 * Percent-encodes the characters that end a markdown URL early.
 *
 * Spelled out rather than handed to encodeURIComponent, which deliberately
 * leaves parentheses alone — they are legal in a URI and it has no idea we are
 * about to wrap this in one.
 */
const URL_ESCAPES: Record<string, string> = {
  "(": "%28",
  ")": "%29",
  "<": "%3C",
  ">": "%3E",
};

function encodeUrl(url: string): string {
  return url.replace(/[()<>\s]/g, (c) => URL_ESCAPES[c] ?? encodeURIComponent(c));
}
