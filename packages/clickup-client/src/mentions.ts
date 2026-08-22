/**
 * @mentions, on the way out to ClickUp.
 *
 * A mention that actually notifies someone is not text. ClickUp needs the
 * structured `comment` array with a `{ type: "tag", user: { id } }` segment;
 * sending `comment_text` containing "@Roberto" posts the literal characters and
 * tells nobody. See https://developer.clickup.com/docs/comment-formatting.
 *
 * Rask carries mentions through its own layers as a markdown-ish link:
 *
 *   Please look at this @[Roberto Spinelli](clickup://user/2462555) thanks
 *
 * Explicit about the id, so two people with the same display name cannot be
 * confused for each other, and it survives being stored as plain text in the
 * outbox. Comments coming *from* ClickUp keep their flattened "@Name" form;
 * only what we send is structured.
 */

/** `@[Display Name](clickup://user/12345)` */
const MENTION = /@\[([^\]]+)\]\(clickup:\/\/user\/(\d+)\)/g;

export type CommentSegment = { text: string } | { type: "tag"; user: { id: number } };

export interface Mention {
  id: number;
  name: string;
}

/**
 * Splits authored text into ClickUp comment segments.
 *
 * Returns null when there is nothing to tag, so callers can keep sending the
 * simpler `comment_text` and leave ClickUp's own formatting alone.
 */
export function toCommentSegments(text: string): CommentSegment[] | null {
  const segments: CommentSegment[] = [];
  let cursor = 0;
  let tagged = false;

  for (const match of text.matchAll(MENTION)) {
    const start = match.index;
    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    segments.push({ type: "tag", user: { id: Number(match[2]) } });
    tagged = true;
    cursor = start + match[0].length;
  }

  if (!tagged) return null;
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });

  return segments;
}

/** The mentions in a string, in order. Duplicates included. */
export function findMentions(text: string): Mention[] {
  return [...text.matchAll(MENTION)].map((match) => ({
    id: Number(match[2]),
    name: match[1] ?? "",
  }));
}

/** Renders mentions back to the plain "@Name" ClickUp itself sends us. */
export function flattenMentions(text: string): string {
  return text.replace(MENTION, (_, name: string) => `@${name}`);
}

export function formatMention(user: { id: string | number; name: string }): string {
  return `@[${user.name}](clickup://user/${user.id})`;
}
