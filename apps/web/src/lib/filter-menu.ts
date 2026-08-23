import {
  ACTIVITY_BUCKETS,
  type Clause,
  CUSTOM_FIELD_PREFIX,
  DUE_BUCKETS,
  type FilterOp,
  isCustomField,
  isDateField,
  PRIORITY_VALUES,
  toggleValue,
} from "./filters.ts";
import { PRIORITY_LABELS } from "./format.ts";

/**
 * What the filter menu offers, and what a chip says.
 *
 * Kept apart from the component so `bun test` can reach it: a `.tsx` file
 * resolves its JSX against React under the test runner and cannot be imported.
 * Everything here is a pure function of the clause and the options in hand.
 */

export interface Choice {
  value: string;
  label: string;
  color?: string | null;
  statusType?: string | null;
}

export interface FieldDef {
  field: string;
  label: string;
  /** A field with no list of values: it is either set or it is not. */
  toggleOnly?: boolean;
}

export const FIELD_LABELS: Record<string, string> = {
  status: "Status",
  assignee: "Assignee",
  tag: "Tag",
  priority: "Priority",
  list: "List",
  dueDate: "Due date",
  dateCreated: "Created",
  dateUpdated: "Updated",
  subtask: "Subtask",
  search: "Text",
};

/*
 * Not `grouping.ts`'s DUE_LABELS, which is a different set of buckets for a
 * different question: grouping splits due dates four ways, filtering five, and
 * "This week" there is a heading while "Due this week" here is a choice.
 */
const DUE_FILTER_LABELS: Record<string, string> = {
  overdue: "Overdue",
  today: "Due today",
  tomorrow: "Due tomorrow",
  week: "Due this week",
  month: "Due this month",
};

const ACTIVITY_LABELS: Record<string, string> = {
  today: "Today",
  week: "Last 7 days",
  month: "Last 30 days",
  quarter: "Last 90 days",
};

/**
 * The fields a filter can be built from, in the order they are offered.
 *
 * Status, assignee and tag lead because they are what the three buttons this
 * replaces already did. `list` is only offered where it means something: on a
 * single list every row has the same one, so the choice is noise.
 */
export function fieldsFor(options: {
  crossList: boolean;
  customFields: Array<{ id: string; name: string }>;
}): FieldDef[] {
  return [
    { field: "status", label: FIELD_LABELS.status ?? "Status" },
    { field: "assignee", label: FIELD_LABELS.assignee ?? "Assignee" },
    { field: "tag", label: FIELD_LABELS.tag ?? "Tag" },
    { field: "priority", label: FIELD_LABELS.priority ?? "Priority" },
    { field: "dueDate", label: FIELD_LABELS.dueDate ?? "Due date" },
    { field: "dateUpdated", label: FIELD_LABELS.dateUpdated ?? "Updated" },
    { field: "dateCreated", label: FIELD_LABELS.dateCreated ?? "Created" },
    ...(options.crossList ? [{ field: "list", label: FIELD_LABELS.list ?? "List" }] : []),
    { field: "subtask", label: FIELD_LABELS.subtask ?? "Subtask", toggleOnly: true },
    ...options.customFields.map((field) => ({
      field: `${CUSTOM_FIELD_PREFIX}${field.id}`,
      label: field.name.trim(),
    })),
  ];
}

export interface OptionSources {
  statuses: Choice[];
  assignees: Choice[];
  tags: Choice[];
  lists: Choice[];
  customFields: Array<{ id: string; name: string; options: Choice[] }>;
}

/** The values on offer for one field. Empty means the field is a toggle. */
export function choicesFor(field: string, sources: OptionSources): Choice[] {
  if (isCustomField(field)) {
    const id = field.slice(CUSTOM_FIELD_PREFIX.length);
    return sources.customFields.find((entry) => entry.id === id)?.options ?? [];
  }

  switch (field) {
    case "status":
      return sources.statuses;
    case "assignee":
      return [{ value: "", label: "Unassigned" }, ...sources.assignees];
    case "tag":
      return [{ value: "", label: "No tags" }, ...sources.tags];
    case "list":
      return sources.lists;
    case "priority":
      return [
        ...PRIORITY_VALUES.map((value) => ({
          value,
          label: PRIORITY_LABELS[Number(value)] ?? value,
        })),
        { value: "", label: "No priority" },
      ];
    case "dueDate":
      return [
        ...DUE_BUCKETS.map((value) => ({ value, label: DUE_FILTER_LABELS[value] ?? value })),
        { value: "", label: "No due date" },
      ];
    case "dateCreated":
    case "dateUpdated":
      return ACTIVITY_BUCKETS.map((value) => ({ value, label: ACTIVITY_LABELS[value] ?? value }));
    case "subtask":
      return [
        { value: "true", label: "Is a subtask" },
        { value: "false", label: "Is not a subtask" },
      ];
    default:
      return [];
  }
}

/**
 * The empty-string choice is "unset", and it is an operator rather than a value.
 *
 * "Unassigned" and "No due date" read as one more thing in the same list, which
 * is how a person thinks about them, but `IS NOT SET` is not a member of `ANY`
 * and pretending otherwise would produce a clause the server cannot answer. So
 * picking it replaces the clause instead of joining it.
 */
export function applyChoice(clause: Clause | undefined, field: string, value: string): Clause {
  const current: Clause = clause ?? { field, op: defaultOp(field), values: [] };

  if (field === "subtask") return { field, op: "EQ", values: [value] };

  if (value === "") {
    return { field, op: current.op === "NOT ANY" ? "IS SET" : "IS NOT SET", values: [] };
  }

  // Coming back from "unset" to a real value: the operator has to become one
  // that can hold values again, keeping whichever way round it was pointing.
  const op: FilterOp =
    current.op === "IS NOT SET" ? "ANY" : current.op === "IS SET" ? "NOT ANY" : current.op;
  return toggleValue({ ...current, field, op }, value);
}

function defaultOp(field: string): FilterOp {
  return field === "subtask" ? "EQ" : "ANY";
}

/** Whether a choice is currently part of the clause, for the checkmark. */
export function isChosen(clause: Clause | undefined, field: string, value: string): boolean {
  if (!clause) return false;
  if (field === "subtask") return clause.values[0] === value;
  if (value === "") return clause.op === "IS SET" || clause.op === "IS NOT SET";
  return clause.values.includes(value);
}

/**
 * A clause as one chip: "Status: Open, In review" or "Tag is not template".
 *
 * `lookup` turns an id into something readable — an assignee clause holds user
 * ids and a list clause holds list ids, neither of which is a word.
 */
export type Lookup = (field: string, value: string | null) => string;

export function describeClause(clause: Clause, lookup: Lookup): string {
  const name = fieldLabel(clause.field, lookup);

  if (clause.field === "subtask") {
    return clause.values[0] === "true" ? "Subtasks only" : "No subtasks";
  }
  if (clause.field === "search") return `“${clause.values[0] ?? ""}”`;
  if (clause.op === "IS SET") return `${name} is set`;
  if (clause.op === "IS NOT SET") return `${name} is not set`;

  const values = clause.values.map((value) => valueLabel(clause.field, value, lookup));
  const listed = values.length > 2 ? `${values.length} values` : values.join(", ");
  return clause.op === "NOT ANY" ? `${name} is not ${listed}` : `${name}: ${listed}`;
}

/** `null` asks for the field's own name; a string asks for one of its values. */
function fieldLabel(field: string, lookup: Lookup): string {
  return isCustomField(field) ? lookup(field, null) : (FIELD_LABELS[field] ?? field);
}

function valueLabel(field: string, value: string, lookup: Lookup): string {
  if (field === "priority") return PRIORITY_LABELS[Number(value)] ?? value;
  if (field === "dueDate") return DUE_FILTER_LABELS[value] ?? value;
  if (isDateField(field)) return ACTIVITY_LABELS[value] ?? value;
  if (field === "assignee" || field === "list" || isCustomField(field)) {
    return lookup(field, value);
  }
  return value;
}
