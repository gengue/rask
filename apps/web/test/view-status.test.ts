import { describe, expect, test } from "bun:test";
import { type Clause, namedStatuses, needsClosed, statusVisible } from "../src/lib/filters.ts";

/**
 * The one rule that decides whether a closed task is on screen.
 *
 * The list reads it as "does this row appear", the board reads it as "does this
 * column get drawn" — `toColumns` is handed this very predicate — so the set of
 * columns and the set of rows cannot disagree. That is what stops a card
 * dragged into a column from disappearing out of it: either the column is not
 * drawn and nothing can be dropped there, or it is drawn and what lands in it
 * stays.
 *
 * Pure and here rather than in `lib/view.ts` because `bun test` resolves
 * solid-js to its server build, where a memo computes once and never again. Any
 * rule worth a test has to be a function of its arguments.
 */

const clause = (values: string[], op: Clause["op"] = "ANY"): Clause[] => [
  { field: "status", op, values },
];

const NONE: ReadonlySet<string> = new Set();

describe("statusVisible", () => {
  test("closed statuses are hidden by default and shown on demand", () => {
    expect(statusVisible("done", "done", false, NONE)).toBe(false);
    expect(statusVisible("archived", "closed", false, NONE)).toBe(false);
    expect(statusVisible("done", "done", true, NONE)).toBe(true);
  });

  test("everything else is always shown", () => {
    expect(statusVisible("Open", "open", false, NONE)).toBe(true);
    expect(statusVisible("in review", "custom", false, NONE)).toBe(true);
    expect(statusVisible(null, null, false, NONE)).toBe(true);
  });

  test("a status the filter names is shown, whatever the toggle says", () => {
    const named = namedStatuses(clause(["done"]));
    expect(statusVisible("done", "done", false, named)).toBe(true);
    // Only the one that was named. "archived" was not asked for.
    expect(statusVisible("archived", "closed", false, named)).toBe(false);
  });

  test("excluding a status is not the same as naming one", () => {
    const named = namedStatuses(clause(["done"], "NOT ANY"));
    expect(named.size).toBe(0);
    expect(statusVisible("done", "done", false, named)).toBe(false);
  });
});

describe("needsClosed", () => {
  test("follows the toggle when no status is named", () => {
    expect(needsClosed([], false)).toBe(false);
    expect(needsClosed([], true)).toBe(true);
  });

  test("a status clause makes the query fetch closed rows too", () => {
    // Otherwise picking "done" out of the menu narrows to nothing: the clause
    // matches and a separate rule then removes everything it matched.
    expect(needsClosed(clause(["done"]), false)).toBe(true);
  });

  test("an empty clause is not a clause", () => {
    expect(needsClosed(clause([]), false)).toBe(false);
  });
});
