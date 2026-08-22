/**
 * Finding the `@token` the caret is sitting in.
 *
 * Pure, so the fiddly part — where does the token start, when has the user
 * moved past it — is testable without a DOM.
 */
export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** What has been typed after it, possibly empty. */
  term: string;
}

/** Longest plausible name fragment. Past this the user is writing prose. */
const MAX_TERM = 32;

export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;

  // Must start a word: an email address or a "foo@bar" is not a mention.
  const preceding = at === 0 ? "" : before[at - 1];
  if (preceding && !/[\s(]/.test(preceding)) return null;

  const term = before.slice(at + 1);
  if (term.length > MAX_TERM) return null;
  // A newline ends it, and so does the closing bracket of a completed mention.
  if (/[\n\]]/.test(term)) return null;

  return { start: at, term };
}

/** Replaces the `@token` under the caret, returning the new text and caret. */
export function applyMention(
  text: string,
  query: MentionQuery,
  caret: number,
  mention: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, query.start)}${mention} ${text.slice(caret)}`;
  return { text: next, caret: query.start + mention.length + 1 };
}
