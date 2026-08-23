/**
 * The words the browser, the API and the worker have to agree on.
 *
 * Nothing here imports anything. It is a deep entry point so the web bundle can
 * take it without pulling in zod or the HTTP client, the same arrangement
 * `./mentions` uses.
 *
 * Each of these was written out separately in two or more places first, which
 * is how the tag filter came to be blind to half the mirror and how the server
 * came to hide rows the client kept. A vocabulary that lives in one file cannot
 * drift; one that is retyped per package always eventually does.
 */

/**
 * Status types ClickUp treats as finished.
 *
 * Workspaces invent their own status *names* freely, but the type is one of
 * ClickUp's, and only these two mean the work is over.
 */
export const CLOSED_STATUS_TYPES: readonly string[] = ["closed", "done"];

/** Whether a status counts as finished. */
export function isClosedType(statusType: string | null | undefined): boolean {
  return statusType != null && CLOSED_STATUS_TYPES.includes(statusType);
}

/**
 * Marks a row that exists locally and not yet in ClickUp.
 *
 * The API mints these, the worker deletes them when a write is rejected, and
 * the browser reads them to know a row is not real yet. Three processes, one
 * prefix: changing it in two of them leaks placeholders that nothing cleans up.
 */
export const PLACEHOLDER_PREFIX = "tmp_";

export function placeholderId(clientId: string): string {
  return `${PLACEHOLDER_PREFIX}${clientId}`;
}

export function isPlaceholder(id: string | null | undefined): boolean {
  return id?.startsWith(PLACEHOLDER_PREFIX) ?? false;
}

/** `cf:<id>` addresses a ClickUp Custom Field in a filter clause. */
export const CUSTOM_FIELD_PREFIX = "cf:";

export function isCustomField(field: string): boolean {
  return field.startsWith(CUSTOM_FIELD_PREFIX);
}

export function customFieldId(field: string): string {
  return field.slice(CUSTOM_FIELD_PREFIX.length);
}

/** Operators a clause may use. ClickUp's own vocabulary, plus `EQ` for booleans. */
export const FILTER_OPS = ["ANY", "NOT ANY", "IS SET", "IS NOT SET", "RANGE", "EQ"] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

/** Fields a filter may name, besides `cf:<id>`. */
export const FILTER_FIELDS = [
  "status",
  "assignee",
  "tag",
  "priority",
  "list",
  "dueDate",
  "dateCreated",
  "dateUpdated",
  "subtask",
  "search",
] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

export interface Clause {
  field: string;
  op: FilterOp;
  values: string[];
}

/**
 * Shortest search term either evaluator will act on.
 *
 * The server cannot answer one character cheaply: trigram indexes need three,
 * and `ILIKE '%a%'` is a sequential scan over 147,000 rows. So it ignores a
 * one-character term. The browser filtering on it anyway is what made the
 * header say `500+` above a list narrowed to nine, which is the count
 * disagreeing with the rows underneath it.
 */
export const MIN_SEARCH_LENGTH = 2;

/**
 * A date-filter bound, as either side receives it.
 *
 * `toWireClause` sends ISO, but ClickUp's own date filters are epoch
 * milliseconds, so a clause lifted out of a mirrored view arrives as digits —
 * and `Date.parse` answers NaN for those. Both evaluators used to treat an
 * unparseable bound as *no* bound, which turns a range into "has a date of any
 * kind": a wider answer than was asked for, with nothing on screen to say so.
 * Written twice, it went wrong twice, in opposite directions.
 *
 * Null means "no bound given", which is a real answer and not a failure.
 */
export function parseInstant(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = /^-?\d{1,15}$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
