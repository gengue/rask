/**
 * A filter, in ClickUp's own vocabulary.
 *
 * A view mirrored from ClickUp carries `filters.fields` shaped
 * `[{field, op, values}]` with operators like `ANY` and `NOT ANY` — see
 * `clickUpViewFilters` in the client package. Rask builds the same shape, so a
 * saved ClickUp view and a filter somebody assembles here describe themselves
 * the same way and neither has to be translated into the other's dialect.
 *
 * Two things are Rask's rather than ClickUp's, and are named so it is obvious
 * which is which:
 *
 *  - `search` is not a `fields` entry upstream; ClickUp keeps the text in
 *    `filters.search` beside the rule list. It is a clause here because the
 *    text narrows the same set the other clauses do, and one list of clauses is
 *    one thing to evaluate, one thing to serialise, and one row of chips.
 *  - `subtask` has no ClickUp equivalent at all. Its UI is a toggle, not a rule.
 *
 * `field` is a plain string rather than a union so a Custom Field can be
 * addressed as `cf:<field id>`, which is how ClickUp addresses one too.
 *
 * The API mirrors this vocabulary in `apps/api/src/filters.ts`, where it is
 * parsed with Zod and turned into SQL. The two must agree; `filters.test.ts`
 * and `apps/api/test/filters.test.ts` are what keep them agreeing.
 */
import {
  type Clause,
  CUSTOM_FIELD_PREFIX,
  customFieldId,
  type FilterOp,
  isClosedType,
  isCustomField,
  isPlaceholder,
  MIN_SEARCH_LENGTH,
  parseInstant,
} from "@rask/clickup-client/vocabulary";

export type { Clause, FilterOp };

/**
 * What the predicate reads, which is less than a whole `Task`.
 *
 * Spelled out rather than importing `Task` so this module depends on nothing
 * browser-shaped: `apps/api/test/filter-parity.test.ts` runs it server-side
 * against the SQL evaluator, and pulling `api.ts` in dragged `window` into a
 * program with no DOM. `Task` satisfies it structurally, so no call site
 * changed.
 */
export interface FilterableTask {
  id: string;
  name: string;
  customId: string | null;
  status: string | null;
  priority: number | null;
  dueDate: string | null;
  dateCreated: string | null;
  dateUpdated: string | null;
  listId: string;
  parentId: string | null;
  tags: ReadonlyArray<{ name: string }>;
  assignees: ReadonlyArray<{ id: string }>;
  customValues?: Record<string, string> | null;
}
// Re-exported so callers keep importing their filter vocabulary from one place.
export { CUSTOM_FIELD_PREFIX, customFieldId, isClosedType, isCustomField };

/** 1 urgent, 2 high, 3 normal, 4 low, matching ClickUp's own numbering. */
export const PRIORITY_VALUES = ["1", "2", "3", "4"] as const;

/**
 * Relative date buckets, which is what people pick.
 *
 * ClickUp's date filters are absolute epochs plus a handful of named ranges;
 * these are the named ranges, kept as tokens so a saved filter still means
 * "this week" tomorrow rather than the seven days that were this week when it
 * was built. `resolveRanges` turns a token into instants against a given `now`,
 * and that is the only place the calendar is read.
 *
 * Due dates look forward and the activity dates look back, so they get
 * different vocabularies rather than one that reads wrong in one direction.
 */
export const DUE_BUCKETS = ["overdue", "today", "tomorrow", "week", "month"] as const;
export const ACTIVITY_BUCKETS = ["today", "week", "month", "quarter"] as const;

export const DATE_FIELDS = ["dueDate", "dateCreated", "dateUpdated"] as const;

export function isDateField(field: string): boolean {
  return (DATE_FIELDS as readonly string[]).includes(field);
}

const DAY = 86_400_000;

function startOfDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * A bucket token as half-open instants, `[from, to)`.
 *
 * Half-open rather than inclusive at both ends because a due date is a moment,
 * not a day: "today" has to cover 00:00:00.000 through 23:59:59.999 without
 * anybody writing 999 anywhere. Infinities are real answers — "overdue" has no
 * lower bound — and both the predicate and the SQL read them as "no bound".
 */
export function resolveRanges(
  field: string,
  values: readonly string[],
  now: Date,
): Array<[number, number]> {
  const day = startOfDay(now);
  const ranges: Array<[number, number]> = [];

  for (const value of values) {
    if (field === "dueDate") {
      if (value === "overdue") ranges.push([Number.NEGATIVE_INFINITY, day]);
      else if (value === "today") ranges.push([day, day + DAY]);
      else if (value === "tomorrow") ranges.push([day + DAY, day + 2 * DAY]);
      else if (value === "week") ranges.push([day, day + 7 * DAY]);
      else if (value === "month") ranges.push([day, day + 30 * DAY]);
      continue;
    }
    // Activity dates: "within the last N days, up to now and beyond". The open
    // upper bound is deliberate — a clock skewed a minute into the future is
    // not a reason to hide a task somebody just touched.
    if (value === "today") ranges.push([day, Number.POSITIVE_INFINITY]);
    else if (value === "week") ranges.push([day - 6 * DAY, Number.POSITIVE_INFINITY]);
    else if (value === "month") ranges.push([day - 29 * DAY, Number.POSITIVE_INFINITY]);
    else if (value === "quarter") ranges.push([day - 89 * DAY, Number.POSITIVE_INFINITY]);
  }

  return ranges;
}

/**
 * The instants a date clause covers, whatever form it was written in.
 *
 * `RANGE` carries pairs of ISO instants — an empty string is an open end — and
 * is what goes over the wire, because the server has no business guessing which
 * midnight the person looking at the screen meant. `ANY` carries bucket tokens
 * and is what the UI holds, so the chip still says "This week" a week later.
 */
export function clauseRanges(clause: Clause, now: Date): Array<[number, number]> {
  if (clause.op === "RANGE") {
    const ranges: Array<[number, number]> = [];
    for (let index = 0; index + 1 < clause.values.length; index += 2) {
      ranges.push([bound(clause.values[index], -1), bound(clause.values[index + 1], 1)]);
    }
    return ranges;
  }
  return resolveRanges(clause.field, clause.values, now);
}

function bound(value: string | undefined, sign: -1 | 1): number {
  const parsed = parseInstant(value);
  if (parsed !== null) return parsed;
  return sign < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
}

/** A date clause rewritten as absolute instants, ready to send. */
export function toWireClause(clause: Clause, now: Date): Clause {
  if (!isDateField(clause.field) || clause.op !== "ANY") return clause;
  const values: string[] = [];
  for (const [from, to] of clauseRanges(clause, now)) {
    values.push(Number.isFinite(from) ? new Date(from).toISOString() : "");
    values.push(Number.isFinite(to) ? new Date(to).toISOString() : "");
  }
  return { field: clause.field, op: "RANGE", values };
}

/** The whole filter as the API expects it: clause order kept, dates resolved. */
export function toWire(clauses: readonly Clause[], now: Date): Clause[] {
  return clauses.map((clause) => toWireClause(clause, now));
}

// --- evaluation -------------------------------------------------------------

/** Statuses a filter names outright. Asking for one is asking to see it. */
export function namedStatuses(clauses: readonly Clause[]): ReadonlySet<string> {
  const clause = clauses.find((entry) => entry.field === "status" && entry.op === "ANY");
  return new Set(clause?.values ?? []);
}

/**
 * Whether tasks with this status are on screen at all.
 *
 * One rule, three readings, which is what keeps them from disagreeing. In the
 * list it decides whether a closed *row* appears. On the board it decides
 * whether a closed *column* is drawn — and because the columns and the rows are
 * both decided here, a task whose column is on screen is never removed for
 * being closed. That is what stops a card dragged into "Done" from vanishing:
 * either the column is there and the card stays in it, or the column was never
 * drawn and there was nothing to drop into.
 *
 * And a status the filter names is always shown, because that is what naming it
 * meant. Picking "done" out of the status menu and being told there is nothing
 * there is the same lie one layer down: the clause matched, and a separate rule
 * then removed everything it matched.
 */
export function statusVisible(
  status: string | null,
  statusType: string | null | undefined,
  showClosed: boolean,
  named: ReadonlySet<string>,
): boolean {
  if (showClosed || !isClosedType(statusType)) return true;
  return status != null && named.has(status);
}

/** Whether the query has to ask for closed rows, whatever the toggle says. */
export function needsClosed(clauses: readonly Clause[], showClosed: boolean): boolean {
  return showClosed || namedStatuses(clauses).size > 0;
}

function has(values: readonly string[], candidate: string | null | undefined): boolean {
  return candidate != null && values.includes(candidate);
}

/**
 * Whether one task satisfies one clause.
 *
 * The same question `apps/api/src/filters.ts` answers in SQL. It is asked twice
 * on purpose: the server decides which rows are worth fetching out of 147,000,
 * and this decides what stays on screen when a status is changed under the
 * cursor — without a round trip, and before the write has even reached the API.
 *
 * A Custom Field clause is the one that cannot be answered from a task alone,
 * so the row carries the values the active filter asked about (`customValues`)
 * and a row that carries none fails the clause. That is not a guess: a row with
 * no values is one the current query did not return, and letting it through a
 * `NOT ANY` would show a task the server has already said does not qualify.
 */
export function matchesClause(task: FilterableTask, clause: Clause, now: Date): boolean {
  const { field, op, values } = clause;

  if (isCustomField(field)) {
    // Null and undefined both mean "this row was never tested against a Custom
    // Field", which is not the same as "it has no value for this one".
    if (task.customValues == null) return false;
    const stored = task.customValues[customFieldId(field)];
    if (op === "IS SET") return stored != null;
    if (op === "IS NOT SET") return stored == null;
    const hit = stored != null && values.includes(stored);
    return op === "NOT ANY" ? !hit : hit;
  }

  if (isDateField(field)) {
    const raw =
      field === "dueDate"
        ? task.dueDate
        : field === "dateCreated"
          ? task.dateCreated
          : task.dateUpdated;
    if (op === "IS SET") return raw != null;
    if (op === "IS NOT SET") return raw == null;
    if (raw == null) return false;
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return false;
    return clauseRanges(clause, now).some(([from, to]) => at >= from && at < to);
  }

  switch (field) {
    case "status": {
      const hit = has(values, task.status);
      return op === "NOT ANY" ? !hit : hit;
    }
    case "priority": {
      const value = task.priority == null ? null : String(task.priority);
      if (op === "IS SET") return value != null;
      if (op === "IS NOT SET") return value == null;
      const hit = has(values, value);
      return op === "NOT ANY" ? !hit : hit;
    }
    case "list": {
      const hit = values.includes(task.listId);
      return op === "NOT ANY" ? !hit : hit;
    }
    case "assignee": {
      if (op === "IS SET") return task.assignees.length > 0;
      if (op === "IS NOT SET") return task.assignees.length === 0;
      const hit = task.assignees.some((user) => values.includes(user.id));
      return op === "NOT ANY" ? !hit : hit;
    }
    case "tag": {
      if (op === "IS SET") return task.tags.length > 0;
      if (op === "IS NOT SET") return task.tags.length === 0;
      const hit = task.tags.some((tag) => values.includes(tag.name));
      return op === "NOT ANY" ? !hit : hit;
    }
    case "subtask":
      return values[0] === "true" ? task.parentId != null : task.parentId == null;
    case "search":
      return matchesText(task, values[0] ?? "");
    default:
      // A field this build does not know about was already applied by the
      // server, which is the only thing that could have sent it. Passing it
      // beats hiding every row because a newer client wrote the filter.
      return true;
  }
}

/**
 * The text half of `/`, as the browser can answer it: name, custom id and
 * ClickUp id.
 *
 * Never the whole answer — the server also reads descriptions, which a row does
 * not carry — so this is only ever used where the server was not asked. See
 * `searchScope` in `lib/view.ts`, which is what decides that. The id matches
 * by equality — a pasted id is whole, and the server's `textCondition`
 * matches it the same way — see the parity note atop this file.
 */
function matchesText(task: FilterableTask, text: string): boolean {
  const query = text.trim().toLowerCase();
  // Below the shared floor the server constrains nothing, so neither does this.
  if (query.length < MIN_SEARCH_LENGTH) return true;
  return (
    task.name.toLowerCase().includes(query) ||
    (task.customId?.toLowerCase().includes(query) ?? false) ||
    task.id.toLowerCase() === query
  );
}

export function matchesTask(task: FilterableTask, clauses: readonly Clause[], now: Date): boolean {
  for (const clause of clauses) {
    if (!matchesClause(task, clause, now)) return false;
  }
  return true;
}

// --- building ---------------------------------------------------------------

/** The clause for `field`, or undefined. One clause per field; see `setClause`. */
export function findClause(clauses: readonly Clause[], field: string): Clause | undefined {
  return clauses.find((clause) => clause.field === field);
}

/**
 * Replaces the clause for a field, or appends it, or drops it when it is empty.
 *
 * One clause per field, which is less than ClickUp allows — it can hold
 * `tag ANY [a]` and `tag NOT ANY [b]` at once and combine them with
 * `filter_groups`. Two rules over one field with a group operator between them
 * is a second thing to render, a second thing to explain and a second thing to
 * get wrong; the day somebody asks for it, `fields` is already a list and this
 * is the only function that assumes otherwise.
 */
export function setClause(clauses: readonly Clause[], next: Clause): Clause[] {
  const empty = next.values.length === 0 && next.op !== "IS SET" && next.op !== "IS NOT SET";
  const without = clauses.filter((clause) => clause.field !== next.field);
  return empty ? without : [...without, next];
}

export function removeClause(clauses: readonly Clause[], field: string): Clause[] {
  return clauses.filter((clause) => clause.field !== field);
}

/**
 * Whether the filter is exactly "assigned to me", which is what the quick
 * filter claims when it is lit.
 *
 * Exactly, and not "me among others": a toggle that reads on over
 * `assignee ANY [me, Ana]` is a button lying about the four hundred rows of
 * Ana's work on screen.
 */
export function assignedToMe(clauses: readonly Clause[], userId: string): boolean {
  const clause = findClause(clauses, "assignee");
  return clause?.op === "ANY" && clause.values.length === 1 && clause.values[0] === userId;
}

/**
 * The quick filter, as a clause: on, off, and nothing in between.
 *
 * Turning it on replaces whatever the assignee clause held rather than adding
 * to it, because "Me" that leaves somebody else's tasks in view is not the
 * button anybody pressed. Losing that clause is the point, and it is one press
 * of the same key to get back to the builder.
 */
export function toggleAssignedToMe(clauses: readonly Clause[], userId: string): Clause[] {
  return assignedToMe(clauses, userId)
    ? removeClause(clauses, "assignee")
    : setClause(clauses, { field: "assignee", op: "ANY", values: [userId] });
}

/** Flips a multi-value clause between "any of these" and "none of these". */
export function negate(op: FilterOp): FilterOp {
  if (op === "ANY") return "NOT ANY";
  if (op === "NOT ANY") return "ANY";
  if (op === "IS SET") return "IS NOT SET";
  if (op === "IS NOT SET") return "IS SET";
  return op;
}

/** Adds or removes one value from a clause's set. */
export function toggleValue(clause: Clause, value: string): Clause {
  const values = clause.values.includes(value)
    ? clause.values.filter((existing) => existing !== value)
    : [...clause.values, value];
  return { ...clause, values };
}

/**
 * Which rows a view shows, as one pure function.
 *
 * This is the most consequential predicate in the app and it used to live
 * inline in a Solid memo, where nothing could test it: `bun test` resolves
 * `solid-js` to its server build, so a memo never re-runs and a test of one
 * passes without asserting anything. Every argument that used to be read from
 * global state is now passed in.
 *
 * The three rules, in the order they matter:
 *
 * - A closed status hides the row unless closed rows are shown or the filter
 *   named that status outright.
 * - `member` is the set the server answered with, for views where membership is
 *   not derivable from the row. A row this browser created a moment ago is not
 *   in it — it did not exist when the question was asked — so a placeholder is
 *   kept, or creating a task under a filter looks like the create failed.
 * - The remaining clauses are answered from the row, which is what lets a
 *   status change under the cursor take effect with no round trip.
 */
export function selectRows<T extends FilterableTask & { id: string; statusType: string | null }>(
  rows: readonly T[],
  options: {
    clauses: readonly Clause[];
    member: ReadonlySet<string> | null;
    showClosed: boolean;
    named: ReadonlySet<string>;
    now: Date;
  },
): T[] {
  const { clauses, member, showClosed, named, now } = options;
  return rows.filter((row) => {
    if (!statusVisible(row.status, row.statusType, showClosed, named)) return false;
    if (member && !member.has(row.id) && !isPlaceholder(row.id)) return false;
    return matchesTask(row, clauses, now);
  });
}
