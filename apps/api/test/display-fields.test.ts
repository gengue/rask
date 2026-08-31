import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, customFieldDefs, taskCustomValues, tasks } from "@rask/schema";
import { like } from "drizzle-orm";
import { withDisplayFields } from "../src/filters.ts";
import { listDisplayFields, listTasks } from "../src/queries.ts";

/**
 * The column picker's catalogue, and the ride-along values it makes the rows
 * carry.
 *
 * The catalogue question is scoping: a field used in another list must not be
 * offered here, and a field of a type the filter menu turns away — text,
 * number — must. The values question is the union: a column the filter never
 * mentioned still has to arrive on the row, without narrowing what the filter
 * asked for.
 */

const db = createTestDb();

const LIST = "dsp-list";
const OTHER = "dsp-other";
const ID = (suffix: string) => `dsp-${suffix}`;

const SEVERITY = ID("f-severity");
const BUDGET = ID("f-budget");
const ELSEWHERE = ID("f-elsewhere");

beforeAll(async () => {
  await cleanup();

  await db.insert(customFieldDefs).values([
    {
      id: SEVERITY,
      name: "Severity",
      type: "drop_down",
      typeConfig: { options: [{ id: "o0", name: "Minor", orderindex: 0 }] },
    },
    { id: BUDGET, name: "Budget", type: "number", typeConfig: null },
    { id: ELSEWHERE, name: "Elsewhere", type: "text", typeConfig: null },
  ]);

  await db.insert(tasks).values([
    { id: ID("one"), listId: LIST, name: "Has both fields" },
    { id: ID("two"), listId: LIST, name: "Has neither field" },
    { id: ID("far"), listId: OTHER, name: "Another list entirely" },
  ]);

  await db.insert(taskCustomValues).values([
    { taskId: ID("one"), fieldId: SEVERITY, value: 0 },
    { taskId: ID("one"), fieldId: BUDGET, value: 1200 },
    { taskId: ID("far"), fieldId: ELSEWHERE, value: "not here" },
  ]);
});

afterAll(cleanup);

async function cleanup() {
  await db.delete(taskCustomValues).where(like(taskCustomValues.taskId, "dsp-%"));
  await db.delete(tasks).where(like(tasks.id, "dsp-%"));
  await db.delete(customFieldDefs).where(like(customFieldDefs.id, "dsp-%"));
}

describe("listDisplayFields", () => {
  test("offers every type with a value in the list, and nothing from other lists", async () => {
    const fields = await listDisplayFields(db, LIST);
    const ours = fields.filter((field) => field.id.startsWith("dsp-"));
    expect(ours.map((field) => field.id)).toEqual([BUDGET, SEVERITY]);
    expect(ours.map((field) => field.type).sort()).toEqual(["drop_down", "number"]);
  });

  test("keeps the typeConfig verbatim, which is what the formatter reads", async () => {
    const fields = await listDisplayFields(db, LIST);
    const severity = fields.find((field) => field.id === SEVERITY);
    expect(severity?.typeConfig).toEqual({ options: [{ id: "o0", name: "Minor", orderindex: 0 }] });
  });
});

describe("withDisplayFields", () => {
  test("unions the columns onto the filter's ids without dropping either", () => {
    expect(withDisplayFields(["a"], "b, c ,a")).toEqual(["a", "b", "c"]);
  });

  test("no param means the filter's ids alone", () => {
    expect(withDisplayFields(["a"], undefined)).toEqual(["a"]);
    expect(withDisplayFields([], "")).toEqual([]);
  });

  test("keeps the filter's ids when the cap trims the tail", () => {
    const many = Array.from({ length: 80 }, (_, i) => `col-${i}`).join(",");
    const kept = withDisplayFields(["filtered"], many);
    expect(kept).toHaveLength(50);
    expect(kept[0]).toBe("filtered");
  });
});

describe("the rows", () => {
  test("carry values for display-only fields, as the JSON text the mirror holds", async () => {
    const rows = await listTasks(db, { listId: LIST, fieldIds: [BUDGET], includeClosed: true });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(ID("one"))?.customValues).toEqual({ [BUDGET]: "1200" });
    // A task with no value still says "tested, nothing there" — {} rather than
    // null, which the browser reads as "never fetched".
    expect(byId.get(ID("two"))?.customValues).toEqual({});
  });
});
