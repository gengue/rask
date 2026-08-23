import { describe, expect, test } from "bun:test";
import type { Task } from "../src/lib/api.ts";
import {
  type Clause,
  clauseRanges,
  isClosedType,
  matchesTask,
  negate,
  removeClause,
  resolveRanges,
  setClause,
  toWire,
} from "../src/lib/filters.ts";

/**
 * The filter, as the browser evaluates it.
 *
 * The other half of the same question lives in `apps/api/src/filters.ts` and is
 * tested against Postgres in `apps/api/test/filters.test.ts` over the same
 * cases, because two evaluators that disagree are worse than one that is slow.
 */

const NOW = new Date("2026-08-23T11:00:00Z");

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    customId: null,
    name: "Fix the invoice export",
    status: "Open",
    statusColor: "#888888",
    statusType: "open",
    priority: null,
    dueDate: null,
    startDate: null,
    dateUpdated: null,
    dateCreated: null,
    listId: "L1",
    spaceId: "S1",
    parentId: null,
    tags: [],
    url: null,
    listName: "Bugs",
    deletedAt: null,
    archived: false,
    assignees: [],
    ...over,
  };
}

const clause = (field: string, op: Clause["op"], values: string[] = []): Clause => ({
  field,
  op,
  values,
});

describe("multi-value and negation", () => {
  test("ANY matches any of the values", () => {
    const filter = [clause("status", "ANY", ["Open", "In review"])];
    expect(matchesTask(task({ status: "Open" }), filter, NOW)).toBe(true);
    expect(matchesTask(task({ status: "In review" }), filter, NOW)).toBe(true);
    expect(matchesTask(task({ status: "Blocked" }), filter, NOW)).toBe(false);
  });

  test("NOT ANY excludes them, and keeps a row with no value at all", () => {
    const filter = [clause("status", "NOT ANY", ["Open"])];
    expect(matchesTask(task({ status: "Open" }), filter, NOW)).toBe(false);
    expect(matchesTask(task({ status: "Blocked" }), filter, NOW)).toBe(true);
    // "not Open" is true of a task with no status; it is not Open.
    expect(matchesTask(task({ status: null }), filter, NOW)).toBe(true);
  });

  test("two assignees, either of them", () => {
    const filter = [clause("assignee", "ANY", ["u1", "u2"])];
    const named = (id: string) =>
      task({ assignees: [{ id, username: id, initials: null, color: null, avatar: null }] });
    expect(matchesTask(named("u1"), filter, NOW)).toBe(true);
    expect(matchesTask(named("u2"), filter, NOW)).toBe(true);
    expect(matchesTask(named("u3"), filter, NOW)).toBe(false);
  });

  test("not this tag", () => {
    const filter = [clause("tag", "NOT ANY", ["template"])];
    expect(matchesTask(task({ tags: [{ name: "template" }] }), filter, NOW)).toBe(false);
    expect(matchesTask(task({ tags: [{ name: "urgent" }] }), filter, NOW)).toBe(true);
    expect(matchesTask(task({ tags: [] }), filter, NOW)).toBe(true);
  });

  test("clauses are ANDed", () => {
    const filter = [
      clause("status", "ANY", ["Open"]),
      clause("tag", "NOT ANY", ["template"]),
      clause("subtask", "EQ", ["false"]),
    ];
    expect(matchesTask(task({ status: "Open", tags: [{ name: "urgent" }] }), filter, NOW)).toBe(
      true,
    );
    expect(matchesTask(task({ status: "Open", tags: [{ name: "template" }] }), filter, NOW)).toBe(
      false,
    );
    expect(matchesTask(task({ status: "Open", parentId: "p1" }), filter, NOW)).toBe(false);
  });
});

describe("set and unset", () => {
  test("assignee", () => {
    const one = { id: "u1", username: "u1", initials: null, color: null, avatar: null };
    expect(matchesTask(task({ assignees: [] }), [clause("assignee", "IS NOT SET")], NOW)).toBe(
      true,
    );
    expect(matchesTask(task({ assignees: [one] }), [clause("assignee", "IS NOT SET")], NOW)).toBe(
      false,
    );
    expect(matchesTask(task({ assignees: [one] }), [clause("assignee", "IS SET")], NOW)).toBe(true);
  });

  test("priority", () => {
    expect(matchesTask(task({ priority: null }), [clause("priority", "IS NOT SET")], NOW)).toBe(
      true,
    );
    expect(matchesTask(task({ priority: 1 }), [clause("priority", "ANY", ["1", "2"])], NOW)).toBe(
      true,
    );
    expect(matchesTask(task({ priority: 4 }), [clause("priority", "ANY", ["1", "2"])], NOW)).toBe(
      false,
    );
  });
});

describe("dates", () => {
  test("overdue is everything before local midnight today", () => {
    const [range] = resolveRanges("dueDate", ["overdue"], NOW);
    expect(range?.[0]).toBe(Number.NEGATIVE_INFINITY);
    expect(new Date(range?.[1] ?? 0).getDate()).toBe(NOW.getDate());
    expect(new Date(range?.[1] ?? 0).getHours()).toBe(0);
  });

  test("overdue, today and no due date are three different answers", () => {
    const yesterday = new Date(NOW.getTime() - 86_400_000).toISOString();
    const later = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();

    const overdue = [clause("dueDate", "ANY", ["overdue"])];
    expect(matchesTask(task({ dueDate: yesterday }), overdue, NOW)).toBe(true);
    expect(matchesTask(task({ dueDate: later }), overdue, NOW)).toBe(false);
    // A task with no due date is not overdue. It has nothing to be late for.
    expect(matchesTask(task({ dueDate: null }), overdue, NOW)).toBe(false);

    const none = [clause("dueDate", "IS NOT SET")];
    expect(matchesTask(task({ dueDate: null }), none, NOW)).toBe(true);
    expect(matchesTask(task({ dueDate: yesterday }), none, NOW)).toBe(false);
  });

  test("two buckets are a union, not an intersection", () => {
    const yesterday = new Date(NOW.getTime() - 86_400_000).toISOString();
    const tomorrow = new Date(NOW.getTime() + 26 * 3_600_000).toISOString();
    const filter = [clause("dueDate", "ANY", ["overdue", "tomorrow"])];
    expect(matchesTask(task({ dueDate: yesterday }), filter, NOW)).toBe(true);
    expect(matchesTask(task({ dueDate: tomorrow }), filter, NOW)).toBe(true);
    // Today falls between the two and is in neither.
    expect(matchesTask(task({ dueDate: NOW.toISOString() }), filter, NOW)).toBe(false);
  });

  test("activity buckets look back", () => {
    const eightDaysAgo = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
    const filter = [clause("dateUpdated", "ANY", ["week"])];
    expect(matchesTask(task({ dateUpdated: twoDaysAgo }), filter, NOW)).toBe(true);
    expect(matchesTask(task({ dateUpdated: eightDaysAgo }), filter, NOW)).toBe(false);
  });

  test("a RANGE of instants means the same thing as the bucket it came from", () => {
    const bucket = clause("dueDate", "ANY", ["week"]);
    const [wire] = toWire([bucket], NOW);
    expect(wire?.op).toBe("RANGE");
    expect(wire?.values).toHaveLength(2);
    expect(clauseRanges(wire as Clause, NOW)).toEqual(clauseRanges(bucket, NOW));
  });

  test("an open end survives the round trip", () => {
    const [wire] = toWire([clause("dueDate", "ANY", ["overdue"])], NOW);
    expect(wire?.values[0]).toBe("");
    expect(clauseRanges(wire as Clause, NOW)[0]?.[0]).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("custom fields", () => {
  const withValues = (values: Record<string, string> | null) => task({ customValues: values });

  test("matches the raw stored value", () => {
    const filter = [clause("cf:field-a", "ANY", ["1", "2"])];
    expect(matchesTask(withValues({ "field-a": "1" }), filter, NOW)).toBe(true);
    expect(matchesTask(withValues({ "field-a": "3" }), filter, NOW)).toBe(false);
    expect(matchesTask(withValues({}), filter, NOW)).toBe(false);
  });

  test("a row carrying no values fails, including under NOT ANY", () => {
    // A row with no values is one the server did not return for this filter.
    // Letting it through NOT ANY would put a task on screen the server has
    // already said does not qualify.
    expect(matchesTask(withValues(null), [clause("cf:field-a", "ANY", ["1"])], NOW)).toBe(false);
    expect(matchesTask(withValues(null), [clause("cf:field-a", "NOT ANY", ["1"])], NOW)).toBe(
      false,
    );
    expect(matchesTask(task(), [clause("cf:field-a", "NOT ANY", ["1"])], NOW)).toBe(false);
  });

  test("NOT ANY over a row that does carry values", () => {
    const filter = [clause("cf:field-a", "NOT ANY", ["1"])];
    expect(matchesTask(withValues({ "field-a": "1" }), filter, NOW)).toBe(false);
    expect(matchesTask(withValues({ "field-a": "2" }), filter, NOW)).toBe(true);
    expect(matchesTask(withValues({}), filter, NOW)).toBe(true);
  });
});

describe("text", () => {
  test("name and custom id, case-insensitively", () => {
    const filter = [clause("search", "EQ", ["INVOICE"])];
    expect(matchesTask(task(), filter, NOW)).toBe(true);
    expect(matchesTask(task({ name: "Something else", customId: "INVOICE-3" }), filter, NOW)).toBe(
      true,
    );
    expect(matchesTask(task({ name: "Something else" }), filter, NOW)).toBe(false);
  });
});

describe("building", () => {
  test("one clause per field, replaced rather than appended", () => {
    let filter = setClause([], clause("status", "ANY", ["Open"]));
    filter = setClause(filter, clause("status", "ANY", ["Open", "Blocked"]));
    expect(filter).toHaveLength(1);
    expect(filter[0]?.values).toEqual(["Open", "Blocked"]);
  });

  test("a clause with no values and no set-ness drops out", () => {
    const filter = setClause([clause("status", "ANY", ["Open"])], clause("status", "ANY", []));
    expect(filter).toEqual([]);
  });

  test("IS NOT SET survives having no values", () => {
    expect(setClause([], clause("assignee", "IS NOT SET"))).toHaveLength(1);
  });

  test("removeClause takes out only its own field", () => {
    const filter = [clause("status", "ANY", ["Open"]), clause("tag", "ANY", ["x"])];
    expect(removeClause(filter, "status").map((c) => c.field)).toEqual(["tag"]);
  });

  test("negate flips both pairs", () => {
    expect(negate("ANY")).toBe("NOT ANY");
    expect(negate("NOT ANY")).toBe("ANY");
    expect(negate("IS SET")).toBe("IS NOT SET");
    expect(negate("IS NOT SET")).toBe("IS SET");
    expect(negate("EQ")).toBe("EQ");
  });
});

describe("closed statuses", () => {
  test("only ClickUp's two finished types count", () => {
    expect(isClosedType("closed")).toBe(true);
    expect(isClosedType("done")).toBe(true);
    expect(isClosedType("open")).toBe(false);
    expect(isClosedType("custom")).toBe(false);
    expect(isClosedType(null)).toBe(false);
  });
});
