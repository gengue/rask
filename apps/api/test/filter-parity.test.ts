import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Clause } from "@rask/clickup-client/vocabulary";
import { createTestDb, taskAssignees, tasks, users } from "@rask/schema";
import { like } from "drizzle-orm";
/*
 * The browser's evaluator, imported across the package line on purpose.
 *
 * `apps/web/src/lib/filters.ts` imports nothing but the shared vocabulary and a
 * type, so this costs no Solid and no bundler. Comparing the two by reading
 * them side by side is what we did before, and it is how the two divergences
 * this file now pins got in.
 */
import { type FilterableTask, matchesTask } from "../../web/src/lib/filters.ts";
import { listTasks } from "../src/queries.ts";

/**
 * One question, asked of both evaluators, over the same rows.
 *
 * `apps/api/src/filters.ts` turns a clause into SQL; `apps/web/src/lib/filters.ts`
 * answers the same clause over rows already in the browser. Both exist for a
 * reason — the server decides which of 147,000 rows arrive, the browser decides
 * which of the ones in hand are on screen — and neither has to trust the other.
 *
 * What they may not do is disagree. When they do, the list shows one set before
 * a refetch and another after, and the count in the header describes neither.
 * A comment in `apps/api/src/filters.ts` claimed this test existed for months
 * before it did; two real divergences had accumulated behind that claim.
 */

const db = createTestDb();
const LIST = "par-list";
const ID = (suffix: string) => `par-${suffix}`;
const ANNA = ID("u-anna");
const BEN = ID("u-ben");

const DAY = 86_400_000;
const NOW = new Date("2026-06-15T12:00:00.000Z");

/**
 * The fixture, written once and projected two ways.
 *
 * Two hand-written fixtures would let the rows drift apart, at which point the
 * test compares two different questions and passes.
 */
const ROWS = [
  {
    id: ID("overdue"),
    name: "Refund webhook drops the currency",
    customId: "PAR-1",
    status: "Open",
    statusType: "open",
    priority: 1,
    dueDate: new Date(NOW.getTime() - 2 * DAY),
    description: "The reconciliation job swallows a mismatched currency.",
    tags: [{ name: "urgent" }, { name: "billing" }],
    assignee: ANNA,
    parentId: null as string | null,
  },
  {
    id: ID("soon"),
    name: "Tidy the export screen",
    customId: null,
    status: "In review",
    statusType: "custom",
    priority: 3,
    dueDate: new Date(NOW.getTime() + 3 * DAY),
    description: "Nothing to do with money.",
    tags: [{ name: "template" }],
    assignee: BEN,
    parentId: null,
  },
  {
    id: ID("nodate"),
    name: "Unfiled thought",
    customId: null,
    status: null,
    statusType: null,
    priority: null,
    dueDate: null,
    description: null,
    tags: [],
    assignee: null,
    parentId: null,
  },
  {
    id: ID("sub"),
    name: "Subtask: add the failing test",
    customId: null,
    status: "Open",
    statusType: "open",
    priority: null,
    dueDate: new Date(NOW.getTime() + 40 * DAY),
    description: null,
    tags: [],
    assignee: null,
    parentId: ID("overdue"),
  },
] as const;

const IN_HAND: Array<FilterableTask & { id: string }> = ROWS.map((row) => ({
  id: row.id,
  customId: row.customId,
  name: row.name,
  status: row.status,
  statusType: row.statusType,
  priority: row.priority,
  dueDate: row.dueDate ? row.dueDate.toISOString() : null,
  dateUpdated: NOW.toISOString(),
  dateCreated: NOW.toISOString(),
  listId: LIST,
  parentId: row.parentId,
  tags: [...row.tags],
  assignees: row.assignee
    ? [{ id: row.assignee, username: null, initials: null, color: null }]
    : [],
  customValues: null,
}));

beforeAll(async () => {
  await cleanup();
  await db
    .insert(users)
    .values([
      { id: ANNA, username: "anna" },
      { id: BEN, username: "ben" },
    ])
    .onConflictDoNothing();

  await db.insert(tasks).values(
    ROWS.map((row) => ({
      id: row.id,
      listId: LIST,
      parentId: row.parentId,
      name: row.name,
      customId: row.customId,
      status: row.status,
      statusType: row.statusType,
      priority: row.priority,
      dueDate: row.dueDate,
      dateCreated: NOW,
      dateUpdated: NOW,
      description: row.description,
      tags: [...row.tags],
    })),
  );

  await db.insert(taskAssignees).values(
    ROWS.filter((row) => row.assignee).map((row) => ({
      taskId: row.id,
      userId: row.assignee as string,
    })),
  );
});

afterAll(cleanup);

async function cleanup() {
  await db.delete(tasks).where(like(tasks.id, "par-%"));
  await db.delete(users).where(like(users.id, "par-%"));
}

async function fromServer(clauses: Clause[]): Promise<string[]> {
  const rows = await listTasks(db, { listId: LIST, clauses, fieldIds: [], includeClosed: true });
  return rows.map((row) => row.id).sort();
}

function inBrowser(clauses: Clause[]): string[] {
  return IN_HAND.filter((task) => matchesTask(task, clauses, NOW))
    .map((task) => task.id)
    .sort();
}

/**
 * Every clause worth asking, and what both sides must answer.
 *
 * Expected ids are written out rather than derived, so a change that breaks
 * both evaluators the same way still fails instead of agreeing on nonsense.
 */
const CASES: Array<{ name: string; clauses: Clause[]; expected: string[] }> = [
  {
    name: "status ANY over several values",
    clauses: [{ field: "status", op: "ANY", values: ["Open", "In review"] }],
    expected: [ID("overdue"), ID("soon"), ID("sub")],
  },
  {
    name: "status NOT ANY keeps the row that has no status",
    clauses: [{ field: "status", op: "NOT ANY", values: ["Open"] }],
    expected: [ID("nodate"), ID("soon")],
  },
  {
    name: "assignee ANY",
    clauses: [{ field: "assignee", op: "ANY", values: [ANNA] }],
    expected: [ID("overdue")],
  },
  {
    name: "assignee IS NOT SET",
    clauses: [{ field: "assignee", op: "IS NOT SET", values: [] }],
    expected: [ID("nodate"), ID("sub")],
  },
  {
    name: "tag ANY",
    clauses: [{ field: "tag", op: "ANY", values: ["urgent"] }],
    expected: [ID("overdue")],
  },
  {
    name: "tag IS NOT SET",
    clauses: [{ field: "tag", op: "IS NOT SET", values: [] }],
    expected: [ID("nodate"), ID("sub")],
  },
  {
    name: "priority ANY",
    clauses: [{ field: "priority", op: "ANY", values: ["1", "3"] }],
    expected: [ID("overdue"), ID("soon")],
  },
  {
    name: "subtask EQ false",
    clauses: [{ field: "subtask", op: "EQ", values: ["false"] }],
    expected: [ID("nodate"), ID("overdue"), ID("soon")],
  },
  {
    name: "dueDate IS NOT SET",
    clauses: [{ field: "dueDate", op: "IS NOT SET", values: [] }],
    expected: [ID("nodate")],
  },
  {
    name: "dueDate RANGE, overdue",
    clauses: [{ field: "dueDate", op: "RANGE", values: ["", String(NOW.getTime())] }],
    expected: [ID("overdue")],
  },
  {
    name: "two clauses narrow together",
    clauses: [
      { field: "status", op: "ANY", values: ["Open"] },
      { field: "subtask", op: "EQ", values: ["false"] },
    ],
    expected: [ID("overdue")],
  },
  {
    name: "search matches the name",
    clauses: [{ field: "search", op: "EQ", values: ["export"] }],
    expected: [ID("soon")],
  },
  {
    name: "search matches the custom id",
    clauses: [{ field: "search", op: "EQ", values: ["PAR-1"] }],
    expected: [ID("overdue")],
  },
  {
    /*
     * One character constrains nothing, on either side.
     *
     * The server cannot answer it cheaply — trigram indexes need three
     * characters and `ILIKE '%a%'` is a sequential scan — so it ignores the
     * term. The browser used to filter on it anyway, which is how the header
     * came to say `500+` over a list narrowed to nine.
     */
    name: "a one-character search is ignored by both",
    clauses: [{ field: "search", op: "EQ", values: ["e"] }],
    expected: [ID("nodate"), ID("overdue"), ID("soon"), ID("sub")],
  },
];

for (const testCase of CASES) {
  test(`both evaluators agree: ${testCase.name}`, async () => {
    const server = await fromServer(testCase.clauses);
    const browser = inBrowser(testCase.clauses);

    expect(server).toEqual(testCase.expected);
    expect(browser).toEqual(testCase.expected);
  });
}

test("the browser only sees a description match the server can find", async () => {
  // The server reads descriptions through a tsvector; the browser holds no
  // description at all. So a description-only term must return rows from the
  // server and be passed through — not filtered out — by the browser, or a
  // search that worked would empty itself one keystroke later.
  const clauses: Clause[] = [{ field: "search", op: "EQ", values: ["reconciliation"] }];

  expect(await fromServer(clauses)).toEqual([ID("overdue")]);
  // Passing rows it cannot judge is the browser's half of that bargain.
  expect(inBrowser(clauses)).toEqual([]);
});

test("a date clause that never went through toWire narrows only in the browser", async () => {
  /*
   * `toWireClause` turns `dueDate ANY ["week"]` into a RANGE of instants before
   * it is sent, because "this week" is a question about the calendar behind the
   * person asking and the server cannot see it. A clause lifted straight out of
   * a mirrored ClickUp view skips that step and arrives as a token.
   *
   * The server then constrains nothing — it has no clock it is allowed to use —
   * and the browser resolves the bucket and narrows. That asymmetry is the
   * contract working, not breaking: the server decides which rows arrive, the
   * browser decides which are on screen. What it costs is the header count,
   * which describes the server's answer. Pinned here so that if someone later
   * teaches the server to resolve buckets, this test says out loud what changed.
   */
  const clauses: Clause[] = [{ field: "dueDate", op: "ANY", values: ["overdue"] }];

  expect(await fromServer(clauses)).toEqual([ID("nodate"), ID("overdue"), ID("soon"), ID("sub")]);
  expect(inBrowser(clauses)).toEqual([ID("overdue")]);
});
