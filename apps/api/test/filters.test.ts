import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTestDb,
  customFieldDefs,
  taskAssignees,
  taskCustomValues,
  tasks,
  users,
} from "@rask/schema";
import { eq, like } from "drizzle-orm";
import { type Clause, toTsQuery } from "../src/filters.ts";
import { listTasks, searchTasks } from "../src/queries.ts";

/**
 * The filter as SQL, over real rows.
 *
 * The point of doing this against Postgres rather than in memory is everything
 * SQL does differently from JavaScript: three-valued logic around NULL, `not
 * exists` over a join table, `jsonb` containment, and a `tsvector` that only
 * exists because the database computed it. None of that is catchable without a
 * database, which is what `createTestDb` is for.
 *
 * `apps/web/test/filters.test.ts` asks the same questions of the browser's
 * evaluator. When these two drift, a filter starts showing a different set
 * before and after a refetch.
 */

const db = createTestDb();

const LIST = "flt-list";
const OTHER = "flt-other";
const FIELD = "flt-field-severity";
const ID = (suffix: string) => `flt-${suffix}`;

const ANNA = ID("u-anna");
const BEN = ID("u-ben");

const clause = (field: string, op: Clause["op"], values: string[] = []): Clause => ({
  field,
  op,
  values,
});

/** Ids of the rows a filter keeps, sorted so the comparison is order-free. */
async function ids(clauses: Clause[], fieldIds: string[] = []): Promise<string[]> {
  const rows = await listTasks(db, { listId: LIST, clauses, fieldIds, includeClosed: true });
  return rows.map((row) => row.id).sort();
}

beforeAll(async () => {
  await cleanup();

  await db
    .insert(users)
    .values([
      { id: ANNA, username: "anna" },
      { id: BEN, username: "ben" },
    ])
    .onConflictDoNothing();

  await db.insert(customFieldDefs).values({
    id: FIELD,
    name: "Severity",
    type: "drop_down",
    typeConfig: {
      options: [
        { id: "o0", name: "Minor", orderindex: 0 },
        { id: "o1", name: "Major", orderindex: 1 },
        { id: "o2", name: "Critical", orderindex: 2 },
      ],
    },
  });

  const day = 86_400_000;
  const now = Date.now();

  await db.insert(tasks).values([
    {
      id: ID("open-anna"),
      listId: LIST,
      name: "Refund webhook drops the currency",
      customId: "FLT-1",
      status: "Open",
      statusType: "open",
      priority: 1,
      dueDate: new Date(now - 2 * day),
      dateCreated: new Date(now - 40 * day),
      dateUpdated: new Date(now - 1 * day),
      description: "The reconciliation job silently swallows a mismatched currency.",
      tags: [{ name: "urgent" }, { name: "billing" }],
    },
    {
      id: ID("review-ben"),
      listId: LIST,
      name: "Tidy the export screen",
      status: "In review",
      statusType: "custom",
      priority: 3,
      dueDate: new Date(now + 3 * day),
      dateCreated: new Date(now - 3 * day),
      dateUpdated: new Date(now - 3 * day),
      description: "Nothing to do with money.",
      tags: [{ name: "template" }],
    },
    {
      id: ID("nostatus"),
      listId: LIST,
      name: "Unfiled thought",
      status: null,
      statusType: null,
      dateCreated: new Date(now - 200 * day),
      dateUpdated: new Date(now - 200 * day),
      tags: [],
    },
    {
      id: ID("sub"),
      listId: LIST,
      parentId: ID("open-anna"),
      name: "Subtask: add the failing test",
      status: "Open",
      statusType: "open",
      dateCreated: new Date(now - day),
      dateUpdated: new Date(now - day),
      tags: [],
    },
    {
      id: ID("elsewhere"),
      listId: OTHER,
      name: "Refund webhook, other list",
      status: "Open",
      statusType: "open",
      tags: [{ name: "urgent" }],
    },
  ]);

  await db.insert(taskAssignees).values([
    { taskId: ID("open-anna"), userId: ANNA },
    { taskId: ID("review-ben"), userId: BEN },
  ]);

  await db.insert(taskCustomValues).values([
    { taskId: ID("open-anna"), fieldId: FIELD, value: 2 },
    { taskId: ID("review-ben"), fieldId: FIELD, value: 0 },
  ]);
});

afterAll(cleanup);

async function cleanup() {
  await db.delete(tasks).where(like(tasks.id, "flt-%"));
  await db.delete(users).where(like(users.id, "flt-%"));
  await db.delete(customFieldDefs).where(eq(customFieldDefs.id, FIELD));
}

describe("status", () => {
  test("ANY over several values", async () => {
    expect(await ids([clause("status", "ANY", ["Open", "In review"])])).toEqual([
      ID("open-anna"),
      ID("review-ben"),
      ID("sub"),
    ]);
  });

  test("NOT ANY keeps the row with no status", async () => {
    // SQL's three-valued logic would drop it: `not (null in ('Open'))` is null,
    // not true. The clause has to say so out loud, and this is why.
    expect(await ids([clause("status", "NOT ANY", ["Open"])])).toEqual([
      ID("nostatus"),
      ID("review-ben"),
    ]);
  });
});

describe("assignee", () => {
  test("ANY over two people", async () => {
    expect(await ids([clause("assignee", "ANY", [ANNA, BEN])])).toEqual([
      ID("open-anna"),
      ID("review-ben"),
    ]);
  });

  test("NOT ANY", async () => {
    expect(await ids([clause("assignee", "NOT ANY", [ANNA])])).toEqual([
      ID("nostatus"),
      ID("review-ben"),
      ID("sub"),
    ]);
  });

  test("unassigned", async () => {
    expect(await ids([clause("assignee", "IS NOT SET")])).toEqual([ID("nostatus"), ID("sub")]);
  });
});

describe("tag", () => {
  test("ANY, through the jsonb containment index", async () => {
    expect(await ids([clause("tag", "ANY", ["urgent", "template"])])).toEqual([
      ID("open-anna"),
      ID("review-ben"),
    ]);
  });

  test("NOT ANY keeps untagged rows", async () => {
    expect(await ids([clause("tag", "NOT ANY", ["template"])])).toEqual([
      ID("nostatus"),
      ID("open-anna"),
      ID("sub"),
    ]);
  });

  test("has no tags at all", async () => {
    expect(await ids([clause("tag", "IS NOT SET")])).toEqual([ID("nostatus"), ID("sub")]);
  });
});

describe("priority, subtask and dates", () => {
  test("priority ANY", async () => {
    expect(await ids([clause("priority", "ANY", ["1", "2"])])).toEqual([ID("open-anna")]);
  });

  test("no priority set", async () => {
    expect(await ids([clause("priority", "IS NOT SET")])).toEqual([ID("nostatus"), ID("sub")]);
  });

  test("subtask, both ways", async () => {
    expect(await ids([clause("subtask", "EQ", ["true"])])).toEqual([ID("sub")]);
    expect(await ids([clause("subtask", "EQ", ["false"])])).toEqual([
      ID("nostatus"),
      ID("open-anna"),
      ID("review-ben"),
    ]);
  });

  test("overdue is an open-ended RANGE", async () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(await ids([clause("dueDate", "RANGE", ["", midnight.toISOString()])])).toEqual([
      ID("open-anna"),
    ]);
  });

  test("two disjoint ranges are a union", async () => {
    const now = Date.now();
    const past = new Date(now - 10 * 86_400_000).toISOString();
    const soon = new Date(now + 86_400_000).toISOString();
    const later = new Date(now + 10 * 86_400_000).toISOString();
    expect(
      await ids([clause("dueDate", "RANGE", [past, new Date(now).toISOString(), soon, later])]),
    ).toEqual([ID("open-anna"), ID("review-ben")]);
  });

  test("no due date", async () => {
    expect(await ids([clause("dueDate", "IS NOT SET")])).toEqual([ID("nostatus"), ID("sub")]);
  });

  test("created in the last 30 days", async () => {
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    expect(await ids([clause("dateCreated", "RANGE", [from, ""])])).toEqual([
      ID("review-ben"),
      ID("sub"),
    ]);
  });
});

describe("custom fields", () => {
  test("ANY over option orderindexes", async () => {
    expect(await ids([clause(`cf:${FIELD}`, "ANY", ["2"])], [FIELD])).toEqual([ID("open-anna")]);
  });

  test("NOT ANY includes rows with no value for the field", async () => {
    expect(await ids([clause(`cf:${FIELD}`, "NOT ANY", ["2"])], [FIELD])).toEqual([
      ID("nostatus"),
      ID("review-ben"),
      ID("sub"),
    ]);
  });

  test("is not set", async () => {
    expect(await ids([clause(`cf:${FIELD}`, "IS NOT SET")], [FIELD])).toEqual([
      ID("nostatus"),
      ID("sub"),
    ]);
  });

  test("the values ride along on the rows, keyed by field id", async () => {
    const rows = await listTasks(db, { listId: LIST, fieldIds: [FIELD], includeClosed: true });
    const row = rows.find((candidate) => candidate.id === ID("open-anna"));
    // Raw JSON text, exactly as the browser's evaluator compares it.
    expect(row?.customValues?.[FIELD]).toBe("2");
    expect(rows.find((candidate) => candidate.id === ID("sub"))?.customValues).toEqual({});
  });

  test("null, not an empty object, when nobody asked", async () => {
    const rows = await listTasks(db, { listId: LIST, includeClosed: true });
    expect(rows[0]?.customValues).toBeNull();
  });
});

describe("text", () => {
  test("matches a word in the description, not just the name", async () => {
    expect(await ids([clause("search", "EQ", ["reconciliation"])])).toEqual([ID("open-anna")]);
  });

  test("matches the middle of a name, which full text alone would not", async () => {
    expect(await ids([clause("search", "EQ", ["ebhook"])])).toEqual([ID("open-anna")]);
  });

  test("two words are ANDed, and the last one matches by prefix", async () => {
    expect(await ids([clause("search", "EQ", ["mismatched curr"])])).toEqual([ID("open-anna")]);
    expect(await ids([clause("search", "EQ", ["mismatched export"])])).toEqual([]);
  });

  test("custom id", async () => {
    expect(await ids([clause("search", "EQ", ["FLT-1"])])).toEqual([ID("open-anna")]);
  });

  test("a tsquery is built from alphanumeric tokens only", () => {
    expect(toTsQuery("purchase order")).toBe("purchase & order:*");
    expect(toTsQuery("  spaced   out ")).toBe("spaced & out:*");
    // Nothing a person can type survives as a tsquery operator.
    expect(toTsQuery("a & b | !c")).toBe("a & b & c:*");
    expect(toTsQuery("!!!")).toBeNull();
  });
});

describe("clauses together", () => {
  test("status and tag and not-a-subtask", async () => {
    expect(
      await ids([
        clause("status", "ANY", ["Open", "In review"]),
        clause("tag", "NOT ANY", ["template"]),
        clause("subtask", "EQ", ["false"]),
      ]),
    ).toEqual([ID("open-anna")]);
  });

  test("the list scope still applies", async () => {
    // `elsewhere` matches every clause except the one that is not a clause.
    expect(await ids([clause("tag", "ANY", ["urgent"])])).toEqual([ID("open-anna")]);
  });
});

describe("searchTasks", () => {
  test("finds a task by a word only its description holds", async () => {
    const hits = await searchTasks(db, "reconciliation");
    expect(hits.map((hit) => hit.id)).toContain(ID("open-anna"));
  });

  test("ranks a name match above a description-only match", async () => {
    // "export" is in one name and in another row's description.
    const hits = await searchTasks(db, "export");
    const ranked = hits.filter((hit) => hit.id.startsWith("flt-")).map((hit) => hit.id);
    expect(ranked[0]).toBe(ID("review-ben"));
  });

  test("a term of one character is not a search", async () => {
    expect(await searchTasks(db, "a")).toEqual([]);
  });

  /*
   * A ClickUp task id (86cbahrxg) is what the URL bar, the mobile app and
   * every "paste me this task" conversation hand you. It is not the custom id
   * (ENG-3011) — nothing in the mirror maps the opaque id to a row unless the
   * search looks at tasks.id itself.
   */
  test("finds a task by its ClickUp id", async () => {
    const hits = await searchTasks(db, ID("open-anna"));
    expect(hits.map((hit) => hit.id)).toContain(ID("open-anna"));
  });

  test("an exact id match outranks a name that merely contains the term", async () => {
    // Two rows: one whose *id* is the term, one whose *name* contains it. The
    // id is the address — someone pasting it wants that row first. Both carry
    // the flt- prefix in name or id so the suite's cleanup finds them; the
    // bare-id row is removed here because cleanup's like() cannot see it.
    try {
      await db
        .insert(tasks)
        .values({
          id: "86cbahrxg",
          listId: LIST,
          name: "flt-id-exact",
          status: "open",
          archived: false,
        })
        .onConflictDoNothing();
      await db
        .insert(tasks)
        .values({
          id: ID("id-rank-name"),
          listId: LIST,
          name: "plan 86cbahrxg review",
          status: "open",
          archived: false,
        })
        .onConflictDoNothing();

      const hits = await searchTasks(db, "86cbahrxg");
      expect(hits[0]?.id).toBe("86cbahrxg");
    } finally {
      await db.delete(tasks).where(eq(tasks.id, "86cbahrxg"));
    }
  });
});
