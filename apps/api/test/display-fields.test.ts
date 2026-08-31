import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, customFieldDefs, taskCustomValues, tasks } from "@rask/schema";
import { like } from "drizzle-orm";
import { withDisplayFields } from "../src/filters.ts";
import { getTaskDetail, listDisplayFields, listTasks } from "../src/queries.ts";

/**
 * The column picker's catalogue, and the ride-along values it makes the rows
 * carry.
 *
 * The catalogue question is what a picker can offer: every field the workspace
 * knows, including the ones this list has never filled in, since waiting for a
 * value before offering the column is waiting forever. Which ones the list
 * does use is a flag rather than a filter — the filter menu still needs it.
 *
 * The values question is the union: a column the filter never mentioned still
 * has to arrive on the row, without narrowing what the filter asked for.
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
  test("offers a field this list has never used, so a column can be started", async () => {
    // The whole point: ELSEWHERE has values only in another list. Left out, a
    // list nobody had filled a field in on could never be given the column —
    // which is 243 of the 249 lists in the workspace this was found on.
    const fields = await listDisplayFields(db, LIST);
    const ours = fields.filter((field) => field.id.startsWith("dsp-"));
    expect(ours.map((field) => field.id).sort()).toEqual([BUDGET, ELSEWHERE, SEVERITY].sort());
  });

  test("flags the ones this list uses, and sorts them first", async () => {
    const ours = (await listDisplayFields(db, LIST)).filter((f) => f.id.startsWith("dsp-"));
    expect(ours.filter((f) => f.usedHere).map((f) => f.id)).toEqual([BUDGET, SEVERITY]);
    // Used first, so the relevant fields are at the top of the picker; within
    // each group the name order survives.
    expect(ours.map((f) => f.id)).toEqual([BUDGET, SEVERITY, ELSEWHERE]);
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

describe("a task's own fields", () => {
  test("include the ones it has no value for, which is the only way to set one", async () => {
    // ID("two") has never had a Custom Field set. Driven from the values
    // table, its detail carried nothing at all and the panel could offer
    // nothing to fill in — every field is a blank until it isn't.
    const detail = await getTaskDetail(db, ID("two"));
    const ours = (detail?.customFields ?? []).filter((field) => field.id.startsWith("dsp-"));
    expect(ours.map((field) => field.id)).toEqual([BUDGET, ELSEWHERE, SEVERITY]);
    expect(ours.every((field) => field.value === null)).toBe(true);
  });

  test("still carry the values of the ones it does have", async () => {
    const detail = await getTaskDetail(db, ID("one"));
    const byId = new Map((detail?.customFields ?? []).map((field) => [field.id, field.value]));
    expect(byId.get(BUDGET)).toBe(1200);
    expect(byId.get(SEVERITY)).toBe(0);
    expect(byId.get(ELSEWHERE)).toBeNull();
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
