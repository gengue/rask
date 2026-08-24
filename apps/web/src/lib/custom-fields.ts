import { parseInstant } from "@rask/clickup-client/vocabulary";
import type { Assignee, CustomField } from "./api.ts";

/**
 * Custom fields, as values rather than as markup.
 *
 * Everything about a custom field that can be wrong without looking wrong
 * lives here: what ClickUp's raw value reads as, and what a write back has to
 * look like. A panel is a hard place to test either one, and a field sent the
 * shape another type wants does not fail on screen — it fails in the outbox, a
 * couple of seconds later, as a toast.
 */

export const CLEAR = "__clear__";

/**
 * A write to one field, on both sides of the wire.
 *
 * `value` is what ClickUp's field endpoint takes. `mirror` is what the mirror
 * should hold until it answers, for the one type where those differ: a People
 * field goes up as `{add, rem}` and is stored as the list that leaves behind.
 * Left out, the two are the same thing.
 */
export interface FieldWrite {
  value: unknown;
  mirror?: unknown;
}

/**
 * What the menu's chosen id means to this field.
 *
 * One single-select menu serves three types that want three different bodies:
 * a dropdown takes the option id on its own, a Label field the array it keeps,
 * and a People field the delta — `{add, rem}`, with numeric ids, the same shape
 * assignees go up in. Deciding that here keeps it out of the menu, which only
 * knows it was clicked.
 *
 * Labels and people toggle rather than replace, which is what the checkmarks
 * beside them promise: picking a second label adds it, picking one already
 * there takes it off. `directory` is the workspace, and only a People field
 * reads it — it is where the picked user's name comes from, so the mirror can
 * show them before ClickUp has heard of it.
 */
export function customFieldWrite(
  field: CustomField,
  id: string,
  directory: Assignee[] = [],
): FieldWrite {
  if (field.type === "labels") {
    const current = labelsOn(field);
    if (id === CLEAR) return { value: [] };
    return {
      value: current.includes(id) ? current.filter((label) => label !== id) : [...current, id],
    };
  }

  if (field.type === "users") {
    const rows = personRows(field);
    if (id === CLEAR) {
      return { value: { add: [], rem: rows.map((row) => Number(row.id)) }, mirror: [] };
    }

    if (rows.some((row) => row.id === id)) {
      return {
        value: { add: [], rem: [Number(id)] },
        mirror: rows.filter((row) => row.id !== id).map((row) => row.raw),
      };
    }

    const picked = directory.find((user) => user.id === id);
    return {
      value: { add: [Number(id)], rem: [] },
      mirror: [...rows.map((row) => row.raw), picked ?? { id }],
    };
  }

  return { value: id === CLEAR ? null : id };
}

/**
 * What a value typed into a field means.
 *
 * `number` and `currency` go up as numbers, which is what ClickUp's schema says
 * for both; everything else is the string as typed. Empty is null, which is how
 * a cleared field is spelled in both directions.
 */
export function typedFieldWrite(type: string, raw: string): FieldWrite {
  const text = raw.trim();
  if (text === "") return { value: null };
  return { value: isNumeric(type) ? Number(text) : text };
}

/** The two field types ClickUp types as a number rather than as a string. */
export function isNumeric(type: string): boolean {
  return type === "number" || type === "currency";
}

/** The option ids on a Label field, which ClickUp keeps as a bare array. */
export function labelsOn(field: CustomField): string[] {
  if (!Array.isArray(field.value)) return [];
  return field.value.filter((id: unknown): id is string => typeof id === "string");
}

/** The ids on a People field, whose value is an array of user objects. */
export function peopleIn(field: CustomField): string[] {
  return personRows(field).map((row) => row.id);
}

/**
 * A date field's instant.
 *
 * The value is Unix milliseconds, as a string more often than not, and on a
 * field nobody has set it is nothing at all.
 */
export function fieldInstant(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return parseInstant(typeof value === "string" ? value : String(value));
}

function personRows(field: CustomField): Array<{ id: string; raw: unknown }> {
  if (!Array.isArray(field.value)) return [];
  const rows: Array<{ id: string; raw: unknown }> = [];
  for (const raw of field.value as unknown[]) {
    if (typeof raw !== "object" || raw === null || !("id" in raw)) continue;
    const id = String((raw as { id: unknown }).id);
    // `Number("")` is zero, and user zero is a request to remove somebody who
    // does not exist.
    if (id !== "" && Number.isFinite(Number(id))) rows.push({ id, raw });
  }
  return rows;
}

/** Custom field values arrive raw. Only the types worth rendering get special care. */
export function formatFieldValue(type: string, config: unknown, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  // Clearing a Label or People field leaves `[]` behind, which every branch
  // below renders as the empty string: a row with nothing in it and nothing to
  // click. It is the same nothing as a field that was never set.
  if (Array.isArray(value) && value.length === 0) return "—";

  if (type === "drop_down") {
    const options = (
      config as { options?: Array<{ id: string; name: string; orderindex: number }> }
    )?.options;
    const match = options?.find((option) => option.id === value || option.orderindex === value);
    return match?.name ?? String(value);
  }

  if (type === "labels" && Array.isArray(value)) {
    const options = (config as { options?: Array<{ id: string; label: string }> })?.options;
    return value
      .map((id) => options?.find((option) => option.id === id)?.label ?? String(id))
      .join(", ");
  }

  if (type === "checkbox") return value === "true" || value === true ? "Yes" : "No";
  if (type === "date") {
    const ms = fieldInstant(value);
    // Rather than "Invalid Date", which is what `new Date(NaN)` prints at people.
    return ms == null ? "—" : new Date(ms).toLocaleDateString();
  }
  if (type === "users" && Array.isArray(value)) {
    return value.map((user: { username?: string }) => user.username ?? "?").join(", ");
  }
  // location, formula, attachment and whatever ClickUp adds next. Printing raw
  // JSON at a person is worse than admitting we do not render this one.
  if (typeof value === "object") return "—";
  return String(value);
}
