import {
  CUSTOM_FIELD_PREFIX,
  customFieldId,
  FILTER_FIELDS,
  FILTER_OPS,
  isCustomField,
  MIN_SEARCH_LENGTH,
  parseInstant,
} from "@rask/clickup-client/vocabulary";
import { taskAssignees, taskCustomValues, tasks } from "@rask/schema";
import {
  and,
  type Column,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";

/**
 * A filter as SQL over the mirror.
 *
 * The vocabulary is ClickUp's — `{field, op, values}` with `ANY` and `NOT ANY`,
 * the same shape a mirrored view carries in `filters.fields` — and the client
 * builds it in `apps/web/src/lib/filters.ts`, which evaluates the same clauses
 * in TypeScript. Two evaluators, one vocabulary, for two different jobs: this
 * one decides which of 147,000 rows are worth sending, and the browser's
 * decides what stays on screen when somebody changes a status under the cursor.
 *
 * They have to agree. `apps/api/test/filter-parity.test.ts` is what makes that
 * true rather than intended: it runs one clause table through both, over one
 * fixture, and fails when the two answer differently. This comment claimed that
 * test existed for months before it did, and two divergences accumulated behind
 * the claim.
 *
 * Everything here is a bound parameter. No clause interpolates a value into
 * SQL text, including the `to_tsquery` string, which is built from alphanumeric
 * tokens and then bound like any other.
 */

const CUSTOM_FIELD = new RegExp(`^${CUSTOM_FIELD_PREFIX}[\\w-]{1,64}$`);

/**
 * Unknown fields are refused rather than dropped.
 *
 * Dropping one would answer a narrower question than was asked with a wider
 * set of rows and no sign that anything was ignored, which is the exact
 * failure this whole change exists to remove. The client and the API ship
 * together; a field one of them does not know is a bug, not a version skew.
 */
export const filterClause = z.object({
  field: z
    .string()
    .refine(
      (field) => (FILTER_FIELDS as readonly string[]).includes(field) || CUSTOM_FIELD.test(field),
      { message: "unknown filter field" },
    ),
  op: z.enum(FILTER_OPS),
  values: z.array(z.string().max(400)).max(200).default([]),
});

export type Clause = z.infer<typeof filterClause>;

/** At most one clause per field, and a ceiling so a URL cannot become a query plan. */
export const filterSet = z.array(filterClause).max(24);

/** Parses the `filter` query parameter. Absent is an empty filter, not an error. */
export function parseFilter(raw: string | undefined): Clause[] {
  if (!raw) return [];
  return filterSet.parse(JSON.parse(raw));
}

/** Custom Field ids a filter mentions, so their values can ride along on the rows. */
export function fieldIdsIn(clauses: readonly Clause[]): string[] {
  return clauses
    .filter((clause) => clause.field.startsWith("cf:"))
    .map((clause) => customFieldId(clause.field));
}

/**
 * The filter's field ids plus the columns the client wants to draw.
 *
 * A union, never a replacement: the browser re-evaluates the filter over these
 * rows, and `customValues` missing a field the filter names would fail every
 * row against it (see `matchesClause` in apps/web). The cap mirrors the
 * filter's own ceiling — every id becomes a bound parameter in an `in (...)`.
 */
export function withDisplayFields(
  fieldIds: readonly string[],
  param: string | undefined,
): string[] {
  const wanted = new Set(fieldIds);
  for (const id of param?.split(",") ?? []) {
    const trimmed = id.trim();
    if (trimmed) wanted.add(trimmed);
  }
  return [...wanted].slice(0, 50);
}

// --- text search ------------------------------------------------------------

/**
 * A `tsquery` from whatever somebody typed.
 *
 * Split on anything that is not a letter or a digit, AND the tokens together,
 * and let the last one match by prefix — it is the word still being typed.
 * "invoi" finds "invoice"; "purchase ord" finds "purchase order".
 *
 * Tokens are alphanumeric by construction, so none of `to_tsquery`'s operators
 * can survive the split. The result is bound as a parameter regardless.
 */
export function toTsQuery(term: string): string | null {
  const tokens = term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens
    .map((token, index) => (index === tokens.length - 1 ? `${token}:*` : token))
    .join(" & ");
}

/**
 * Name, custom id, ClickUp id and description, each the way it deserves.
 *
 * Trigram `ILIKE` on the two short columns, because people type the middle of
 * a name and the number out of a custom id, and full text on the description,
 * because it is prose and substring matching over prose is both slower and
 * noisier. Measured on the 147,000-task mirror: description search was a 334ms
 * sequential scan with no index, 15-24ms with a trigram index, and 2.5-11ms
 * with this one.
 *
 * The ClickUp id matches with `=` and no index of its own: a pasted id is
 * complete by definition — nobody types the middle of `86cbahrxg` the way
 * they type the middle of a name — and `id` is the primary key, so equality
 * is a btree probe. An `ILIKE '%…%'` branch here would need a fourth GIN
 * index and, worse, would keep Postgres from building a bitmap over the
 * indexed branches of the OR.
 *
 * Comments are deliberately not in here. See `searchTasks`.
 */
export function textCondition(term: string): SQL | undefined {
  const trimmed = term.trim();
  if (trimmed.length < MIN_SEARCH_LENGTH) return undefined;

  const like = `%${trimmed}%`;
  const parts: SQL[] = [
    ilike(tasks.name, like),
    ilike(tasks.customId, like),
    eq(tasks.id, trimmed),
  ];

  const query = toTsQuery(trimmed);
  if (query) parts.push(sql`${tasks.searchVector} @@ to_tsquery('simple', ${query})`);

  return or(...parts);
}

// --- clauses ----------------------------------------------------------------

const DATE_COLUMNS: Record<string, Column> = {
  dueDate: tasks.dueDate,
  dateCreated: tasks.dateCreated,
  dateUpdated: tasks.dateUpdated,
};

/** A parameter list for a raw `in (...)`, one bind per value. */
function binds(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

const ALWAYS = sql`true`;
const NEVER = sql`false`;

/** `ANY` over nothing matches nothing; `NOT ANY` over nothing excludes nothing. */
function emptySet(op: Clause["op"]): SQL {
  return op === "NOT ANY" ? ALWAYS : NEVER;
}

export function clauseCondition(clause: Clause): SQL | undefined {
  const { field, op, values } = clause;

  if (isCustomField(field)) return customFieldCondition(customFieldId(field), op, values);
  if (DATE_COLUMNS[field]) return dateCondition(DATE_COLUMNS[field], op, values);

  switch (field) {
    case "status":
      if (op === "IS SET") return isNotNull(tasks.status);
      if (op === "IS NOT SET") return isNull(tasks.status);
      if (values.length === 0) return emptySet(op);
      return op === "NOT ANY"
        ? sql`(${tasks.status} is null or not ${inArray(tasks.status, values)})`
        : inArray(tasks.status, values);

    case "priority": {
      if (op === "IS SET") return isNotNull(tasks.priority);
      if (op === "IS NOT SET") return isNull(tasks.priority);
      const numbers = values.map(Number).filter(Number.isInteger);
      if (numbers.length === 0) return emptySet(op);
      return op === "NOT ANY"
        ? sql`(${tasks.priority} is null or not ${inArray(tasks.priority, numbers)})`
        : inArray(tasks.priority, numbers);
    }

    case "list":
      if (values.length === 0) return emptySet(op);
      return op === "NOT ANY"
        ? sql`not ${inArray(tasks.listId, values)}`
        : inArray(tasks.listId, values);

    case "assignee": {
      if (op === "IS SET") return sql`exists (${anyAssignee()})`;
      if (op === "IS NOT SET") return sql`not exists (${anyAssignee()})`;
      if (values.length === 0) return emptySet(op);
      const held = sql`exists (${anyAssignee()} and ta.user_id in (${binds(values)}))`;
      return op === "NOT ANY" ? sql`not ${held}` : held;
    }

    case "tag": {
      // `jsonb_typeof` first because `jsonb_array_length` raises on a scalar,
      // which is what a row written before the tags column type was fixed
      // holds. Migration 0009 repaired every such row; this is the seatbelt.
      if (op === "IS SET") {
        return sql`(jsonb_typeof(${tasks.tags}) = 'array' and jsonb_array_length(${tasks.tags}) > 0)`;
      }
      if (op === "IS NOT SET") {
        return sql`(jsonb_typeof(${tasks.tags}) <> 'array' or jsonb_array_length(${tasks.tags}) = 0)`;
      }
      if (values.length === 0) return emptySet(op);
      // One containment per value rather than one expression over an array:
      // each is a separate lookup in the jsonb_path_ops GIN index, and Postgres
      // ORs the bitmaps. Built server-side from a text parameter, never a
      // stringified literal — see the note above the `jsonb` column type.
      const held = or(
        ...values.map(
          (value) =>
            sql`${tasks.tags} @> jsonb_build_array(jsonb_build_object('name', ${value}::text))`,
        ),
      );
      return op === "NOT ANY" ? sql`not (${held})` : held;
    }

    case "subtask":
      return values[0] === "true" ? isNotNull(tasks.parentId) : isNull(tasks.parentId);

    case "search":
      return textCondition(values[0] ?? "");

    default:
      return undefined;
  }
}

function anyAssignee(): SQL {
  return sql`select 1 from ${taskAssignees} ta where ta.task_id = ${tasks.id}`;
}

/**
 * A date clause, as half-open instants.
 *
 * `values` holds pairs — from, to, from, to — and an empty string is an open
 * end. The client resolves "this week" into instants before sending, because
 * which midnight that means is a property of the person looking at the screen
 * and the server has no way to know it.
 */
function dateCondition(
  column: Column,
  op: Clause["op"],
  values: readonly string[],
): SQL | undefined {
  if (op === "IS SET") return isNotNull(column);
  if (op === "IS NOT SET") return isNull(column);

  const ranges: SQL[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    const from = instant(values[index]);
    const to = instant(values[index + 1]);
    const bounds: SQL[] = [];
    if (from) bounds.push(sql`${column} >= ${from}`);
    if (to) bounds.push(sql`${column} < ${to}`);
    // Both ends open is "has a date at all", which is what an unbounded range
    // asks for and is not the same as no clause.
    ranges.push(bounds.length > 0 ? (and(...bounds) as SQL) : isNotNull(column));
  }

  if (ranges.length === 0) return undefined;
  return or(...ranges);
}

function instant(value: string | undefined): Date | null {
  const parsed = parseInstant(value);
  return parsed === null ? null : new Date(parsed);
}

/**
 * A Custom Field value.
 *
 * `task_custom_values.value` is ClickUp's raw value as JSON text, and for a
 * `drop_down` that is the chosen option's `orderindex` — `1`, not the option's
 * uuid and not its name. So the comparison is plain text equality against
 * `"1"`, which is also what makes it index-friendly: the field id narrows
 * through `task_custom_values_field_idx` and the value filters what is left.
 *
 * `'null'` is the text a cleared field holds, since the column stringifies
 * whatever ClickUp sent and ClickUp sends null. Treating it as unset is what
 * makes "is not set" mean what it says.
 */
function customFieldCondition(
  fieldId: string,
  op: Clause["op"],
  values: readonly string[],
): SQL | undefined {
  const scope = sql`select 1 from ${taskCustomValues} v
    where v.task_id = ${tasks.id} and v.field_id = ${fieldId}`;

  if (op === "IS SET") return sql`exists (${scope} and v.value is not null and v.value <> 'null')`;
  if (op === "IS NOT SET") {
    return sql`not exists (${scope} and v.value is not null and v.value <> 'null')`;
  }

  if (values.length === 0) return emptySet(op);
  const held = sql`exists (${scope} and v.value in (${binds(values)}))`;
  return op === "NOT ANY" ? sql`not ${held}` : held;
}

/** Every clause, ANDed. Undefined when the filter constrains nothing. */
export function filterConditions(clauses: readonly Clause[]): SQL[] {
  return clauses.map(clauseCondition).filter((condition): condition is SQL => condition != null);
}
