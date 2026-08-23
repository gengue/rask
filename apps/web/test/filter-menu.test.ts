import { describe, expect, test } from "bun:test";
import {
  applyChoice,
  choicesFor,
  describeClause,
  fieldsFor,
  isChosen,
  type Lookup,
  type OptionSources,
} from "../src/lib/filter-menu.ts";
import type { Clause } from "../src/lib/filters.ts";

const SOURCES: OptionSources = {
  statuses: [
    { value: "Open", label: "Open", statusType: "open" },
    { value: "Done", label: "Done", statusType: "done" },
  ],
  assignees: [
    { value: "u1", label: "anna" },
    { value: "u2", label: "ben" },
  ],
  tags: [{ value: "urgent", label: "urgent" }],
  lists: [{ value: "L1", label: "Bugs" }],
  customFields: [
    {
      id: "sev",
      name: "Severity",
      options: [
        { value: "0", label: "Minor" },
        { value: "2", label: "Critical" },
      ],
    },
  ],
};

/** Stands in for the component's directory lookups. */
const label: Lookup = (field, value) => {
  if (value === null) return field === "cf:sev" ? "Severity" : field;
  if (field === "assignee") return { u1: "anna", u2: "ben" }[value] ?? value;
  if (field === "cf:sev") return { "0": "Minor", "2": "Critical" }[value] ?? value;
  return value;
};

describe("what is on offer", () => {
  test("the list facet only appears where rows can come from several lists", () => {
    const fields = (crossList: boolean) =>
      fieldsFor({ crossList, customFields: [] }).map((def) => def.field);
    expect(fields(true)).toContain("list");
    expect(fields(false)).not.toContain("list");
  });

  test("a list's custom fields come last, after the built-in ones", () => {
    const fields = fieldsFor({ crossList: false, customFields: [{ id: "sev", name: "Severity" }] });
    expect(fields.at(-1)).toEqual({ field: "cf:sev", label: "Severity" });
  });

  test("unset is offered as one more choice, because that is how people read it", () => {
    expect(choicesFor("assignee", SOURCES)[0]).toEqual({ value: "", label: "Unassigned" });
    expect(choicesFor("dueDate", SOURCES).at(-1)).toEqual({ value: "", label: "No due date" });
  });

  test("a custom field offers its own options", () => {
    expect(choicesFor("cf:sev", SOURCES).map((choice) => choice.label)).toEqual([
      "Minor",
      "Critical",
    ]);
  });

  test("a field nobody knows offers nothing rather than throwing", () => {
    expect(choicesFor("cf:missing", SOURCES)).toEqual([]);
  });
});

describe("picking values", () => {
  test("picking twice adds two values", () => {
    let clause = applyChoice(undefined, "status", "Open");
    clause = applyChoice(clause, "status", "Done");
    expect(clause).toEqual({ field: "status", op: "ANY", values: ["Open", "Done"] });
  });

  test("picking the same value again takes it out", () => {
    const clause = applyChoice(
      { field: "status", op: "ANY", values: ["Open", "Done"] },
      "status",
      "Open",
    );
    expect(clause.values).toEqual(["Done"]);
  });

  test("negation survives picking another value", () => {
    const clause = applyChoice(
      { field: "tag", op: "NOT ANY", values: ["template"] },
      "tag",
      "urgent",
    );
    expect(clause).toEqual({ field: "tag", op: "NOT ANY", values: ["template", "urgent"] });
  });

  test("unset is an operator, so it replaces the values rather than joining them", () => {
    const clause = applyChoice({ field: "assignee", op: "ANY", values: ["u1"] }, "assignee", "");
    expect(clause).toEqual({ field: "assignee", op: "IS NOT SET", values: [] });
  });

  test("unset under a negated clause means the opposite", () => {
    const clause = applyChoice({ field: "tag", op: "NOT ANY", values: ["x"] }, "tag", "");
    expect(clause.op).toBe("IS SET");
  });

  test("coming back from unset restores an operator that can hold values", () => {
    const clause = applyChoice(
      { field: "assignee", op: "IS NOT SET", values: [] },
      "assignee",
      "u1",
    );
    expect(clause).toEqual({ field: "assignee", op: "ANY", values: ["u1"] });
  });

  test("subtask is one value or the other, never both", () => {
    const first = applyChoice(undefined, "subtask", "true");
    expect(first).toEqual({ field: "subtask", op: "EQ", values: ["true"] });
    expect(applyChoice(first, "subtask", "false").values).toEqual(["false"]);
  });

  test("the checkmark follows the clause", () => {
    const clause: Clause = { field: "status", op: "ANY", values: ["Open"] };
    expect(isChosen(clause, "status", "Open")).toBe(true);
    expect(isChosen(clause, "status", "Done")).toBe(false);
    expect(isChosen(undefined, "status", "Open")).toBe(false);
    expect(isChosen({ field: "assignee", op: "IS NOT SET", values: [] }, "assignee", "")).toBe(
      true,
    );
  });
});

describe("what a chip says", () => {
  const say = (clause: Clause) => describeClause(clause, label);

  test("a field and its values", () => {
    expect(say({ field: "status", op: "ANY", values: ["Open", "Done"] })).toBe(
      "Status: Open, Done",
    );
  });

  test("negation reads as a sentence, not as an operator", () => {
    expect(say({ field: "tag", op: "NOT ANY", values: ["template"] })).toBe("Tag is not template");
  });

  test("more than two values are counted rather than listed", () => {
    expect(say({ field: "status", op: "ANY", values: ["a", "b", "c"] })).toBe("Status: 3 values");
  });

  test("ids are resolved to the things they name", () => {
    expect(say({ field: "assignee", op: "ANY", values: ["u1", "u2"] })).toBe("Assignee: anna, ben");
    expect(say({ field: "cf:sev", op: "ANY", values: ["2"] })).toBe("Severity: Critical");
  });

  test("set and unset", () => {
    expect(say({ field: "assignee", op: "IS NOT SET", values: [] })).toBe("Assignee is not set");
    expect(say({ field: "tag", op: "IS SET", values: [] })).toBe("Tag is set");
  });

  test("dates say the bucket, not the instants", () => {
    expect(say({ field: "dueDate", op: "ANY", values: ["overdue", "today"] })).toBe(
      "Due date: Overdue, Due today",
    );
    expect(say({ field: "dateUpdated", op: "ANY", values: ["week"] })).toBe("Updated: Last 7 days");
  });

  test("priority says the word", () => {
    expect(say({ field: "priority", op: "ANY", values: ["1"] })).toBe("Priority: Urgent");
  });

  test("subtask and text have their own phrasing", () => {
    expect(say({ field: "subtask", op: "EQ", values: ["false"] })).toBe("No subtasks");
    expect(say({ field: "search", op: "EQ", values: ["invoice"] })).toBe("“invoice”");
  });
});
