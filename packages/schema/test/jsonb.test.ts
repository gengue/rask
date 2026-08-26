import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ClickUpClient, type CommentSegment, RateLimiter } from "@rask/clickup-client";
import { sql } from "drizzle-orm";
import {
  comments,
  customFieldDefs,
  lists,
  outbox,
  spaces,
  taskCustomValues,
  tasks,
  viewMemberships,
} from "../src/schema.ts";
import { createTestDb } from "../src/test-db.ts";

/**
 * jsonb columns must land in Postgres as objects and arrays, not as JSON
 * strings.
 *
 * This is worth a real database because it cannot be caught any other way:
 * Drizzle parses the value back on read, so a double-encoded column round-trips
 * perfectly through the ORM while `@>` containment silently matches nothing and
 * raw SQL reads get a string. The bug is invisible from the application's own
 * reads, which is exactly why it needs a test that looks at the stored type.
 */

const db = createTestDb();

const SPACE = "jsonb-test-space";
const TASK = "jsonb-test-task";
const FIELD = "jsonb-test-field";

afterAll(async () => {
  await db.delete(taskCustomValues).where(sql`task_id = ${TASK}`);
  await db.delete(tasks).where(sql`id = ${TASK}`);
  // The legacy row below deletes itself on success only. Left behind by a
  // failing run it makes every later run fail on a duplicate key instead, which
  // reads as a second bug and hides the first.
  await db.delete(tasks).where(sql`id = ${`${TASK}-legacy`}`);
  await db.delete(customFieldDefs).where(sql`id = ${FIELD}`);
  await db.delete(spaces).where(sql`id = ${SPACE}`);
  await db.delete(outbox).where(sql`user_id = ${"jsonb-test-user"}`);
});

/**
 * A ClickUp client that answers everything with `{}` and records what it sent.
 *
 * Here rather than in the client package because the thing under test is the
 * hand-off: what Postgres gives back is what goes on the wire.
 */
function commentClient() {
  const calls: Array<{ body: unknown }> = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  const client = new ClickUpClient({
    token: "pk_test",
    fetch: fetchImpl,
    limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
  });
  return { client, calls };
}

async function storedType(table: string, column: string, where: string): Promise<string> {
  const rows = (await db.execute(
    sql.raw(`select jsonb_typeof(${column}) as t from ${table} where ${where} limit 1`),
  )) as unknown as Array<{ t: string }>;
  return rows[0]?.t ?? "missing";
}

describe("jsonb columns", () => {
  test("stores task tags as an array, not a string", async () => {
    await db.insert(tasks).values({
      id: TASK,
      listId: "jsonb-test-list",
      name: "jsonb probe",
      tags: [{ name: "performance", fg: "#fff", bg: "#EA4335" }],
    });

    expect(await storedType("tasks", "tags", `id = '${TASK}'`)).toBe("array");
  });

  test("tag containment matches, which is what the tag filter relies on", async () => {
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        sql`${tasks.tags} @> jsonb_build_array(jsonb_build_object('name', ${"performance"}::text))`,
      );

    expect(rows.map((row) => row.id)).toContain(TASK);
  });

  test("stores space statuses as an array", async () => {
    await db.insert(spaces).values({
      id: SPACE,
      teamId: "1",
      name: "probe",
      statuses: [{ status: "todo", color: "#fff", type: "open", orderindex: 0 }],
    });

    expect(await storedType("spaces", "statuses", `id = '${SPACE}'`)).toBe("array");
  });

  test("stores custom field config as an object", async () => {
    await db.insert(customFieldDefs).values({
      id: FIELD,
      name: "Impact",
      type: "drop_down",
      typeConfig: { options: [{ id: "a", name: "High", orderindex: 0 }] },
    });

    expect(await storedType("custom_field_defs", "type_config", `id = '${FIELD}'`)).toBe("object");
  });

  /**
   * ClickUp Custom Fields hold any JSON scalar. A number field sends 42, a
   * checkbox sends true, and both used to blow up on insert because the driver
   * bound them as int4 and bool against a jsonb column.
   */
  test("keeps custom field values as text, not jsonb", async () => {
    // Without this the scalar round-trip below passes for the wrong reason:
    // stringify-then-jsonb-encode cancels out on the way back through Drizzle.
    const rows = (await db.execute(
      sql`select data_type from information_schema.columns
          where table_name = 'task_custom_values' and column_name = 'value'`,
    )) as unknown as Array<{ data_type: string }>;

    expect(rows[0]?.data_type).toBe("text");
  });

  test.each([
    ["a number", 42],
    ["a float", 1.5],
    ["a boolean", true],
    ["a string", "opt-2"],
    ["an array", ["a", "b"]],
    ["an object", { raw: "a" }],
    ["null, meaning explicitly cleared", null],
  ])("round-trips %s as a custom field value", async (_label, value) => {
    await db
      .insert(customFieldDefs)
      .values({ id: FIELD, name: "F", type: "number" })
      .onConflictDoNothing();
    await db.delete(taskCustomValues).where(sql`task_id = ${TASK} and field_id = ${FIELD}`);
    await db.insert(taskCustomValues).values({ taskId: TASK, fieldId: FIELD, value });

    const [row] = await db
      .select({ value: taskCustomValues.value })
      .from(taskCustomValues)
      .where(sql`task_id = ${TASK} and field_id = ${FIELD}`);

    expect(row?.value).toEqual(value);
  });

  /**
   * A double-encoded membership reads back fine through Drizzle — a JSON
   * string of ids parses to the same array — while the row itself is wrong in
   * Postgres, which is the invisible half this file exists for.
   */
  test("stores a view membership's ids as an array, not a string", async () => {
    await db
      .delete(viewMemberships)
      .where(sql`view_id = ${"jsonb-test-view"} and user_id = ${"jsonb-test-user"}`);
    await db.insert(viewMemberships).values({
      viewId: "jsonb-test-view",
      userId: "jsonb-test-user",
      taskIds: [TASK, "jsonb-test-task-2"],
    });

    expect(await storedType("view_memberships", "task_ids", `view_id = 'jsonb-test-view'`)).toBe(
      "array",
    );

    await db.delete(viewMemberships).where(sql`view_id = ${"jsonb-test-view"}`);
  });

  test("stores the outbox payload as an object the worker can read with raw SQL", async () => {
    await db.insert(outbox).values({
      userId: "jsonb-test-user",
      op: "create_task",
      payload: { listId: "L1", name: "probe" },
    });

    expect(await storedType("outbox", "payload", `user_id = 'jsonb-test-user'`)).toBe("object");

    // The drain claims rows with raw SQL, which bypasses Drizzle's parsing.
    const claimed = (await db.execute(
      sql`select payload from ${outbox} where user_id = 'jsonb-test-user' limit 1`,
    )) as unknown as Array<{ payload: { listId?: string } }>;

    expect(claimed[0]?.payload.listId).toBe("L1");
  });
});

describe("reading a double-encoded row", () => {
  test("unwraps it rather than handing a string to the UI", async () => {
    // Exactly what the pre-fix writer left behind: JSON inside JSON.
    await db.insert(tasks).values({ id: `${TASK}-legacy`, listId: "L", name: "legacy" });
    await db.execute(
      sql`update ${tasks} set tags = to_jsonb(${'[{"name":"perf"}]'}::text) where id = ${`${TASK}-legacy`}`,
    );

    const stored = (await db.execute(
      sql`select jsonb_typeof(tags) t from ${tasks} where id = ${`${TASK}-legacy`}`,
    )) as unknown as Array<{ t: string }>;
    expect(stored[0]?.t).toBe("string");

    const [row] = await db
      .select({ tags: tasks.tags })
      .from(tasks)
      .where(sql`id = ${`${TASK}-legacy`}`);

    expect(row?.tags).toEqual([{ name: "perf" }]);
    await db.delete(tasks).where(sql`id = ${`${TASK}-legacy`}`);
  });
});

/**
 * `comments.segments` is the one jsonb column whose shape is load-bearing on a
 * write, not only on a read.
 *
 * `ClickUpClient.updateComment` branches on `segments?.length`. Stored
 * correctly that is the number of segments. Stored double-encoded the column
 * reads back as a *string*, `?.length` is its character count — still truthy —
 * and the PUT that resolves the comment sends `{ comment: "<json text>" }`.
 * ClickUp's PUT replaces the body, so the screenshot or table the comment held
 * is gone, upstream, with no copy anywhere.
 */
describe("comments.segments", () => {
  const COMMENT_TASK = "jsonb-test-comment-task";
  const COMMENT = "jsonb-test-comment";

  /** The shape ClickUp sends: an image is a segment, not characters. */
  const SEGMENTS = [
    { text: "the cold start looks like " },
    { type: "attachment", attachment: { id: "5f1e2a", title: "cold-start.png" } },
    { text: " — can you confirm?" },
  ];

  beforeAll(async () => {
    await db
      .insert(tasks)
      .values({ id: COMMENT_TASK, listId: "jsonb-test-list", name: "comment probe" })
      .onConflictDoNothing();
    await db.delete(comments).where(sql`id = ${COMMENT}`);
    await db.insert(comments).values({
      id: COMMENT,
      taskId: COMMENT_TASK,
      text: "the cold start looks like  — can you confirm?",
      segments: SEGMENTS,
    });
  });

  afterAll(async () => {
    await db.delete(comments).where(sql`task_id = ${COMMENT_TASK}`);
    await db.delete(tasks).where(sql`id = ${COMMENT_TASK}`);
  });

  test("stores the segments as an array, not as a JSON string", async () => {
    // 'string' here means every resolve on this comment flattens it upstream.
    expect(await storedType("comments", "segments", `id = '${COMMENT}'`)).toBe("array");
  });

  test("containment matches the attachment segment", async () => {
    // Proves the array is real jsonb structure and not text that merely parses:
    // `@>` never matches inside a jsonb string, so this is the honest probe.
    const rows = await db
      .select({ id: comments.id })
      .from(comments)
      .where(
        sql`${comments.segments} @> jsonb_build_array(jsonb_build_object('type', ${"attachment"}::text))`,
      );

    expect(rows.map((row) => row.id)).toContain(COMMENT);
  });

  test("hands the write path an array, so `segments?.length` counts segments", async () => {
    const [row] = await db
      .select({ segments: comments.segments })
      .from(comments)
      .where(sql`id = ${COMMENT}`);

    // Not `toEqual(SEGMENTS)` alone: a JSON string of the same content would
    // satisfy a length check while being the thing that destroys the comment.
    expect(Array.isArray(row?.segments)).toBe(true);
    expect(row?.segments).toEqual(SEGMENTS);
    expect(row?.segments?.length).toBe(3);
  });

  test("resolving a comment sends the segments up, never the flattened text", async () => {
    const [row] = await db
      .select({ text: comments.text, segments: comments.segments })
      .from(comments)
      .where(sql`id = ${COMMENT}`);

    const { client, calls } = commentClient();
    await client.updateComment(COMMENT, {
      text: row?.text ?? "",
      resolved: true,
      segments: row?.segments as CommentSegment[] | null,
    });

    expect(calls[0]?.body).toEqual({ comment: SEGMENTS, resolved: true });
  });

  test("survives a legacy double-encoded row instead of shipping it to ClickUp", async () => {
    // What the pre-fix writer left behind. Without the unwrap in `fromDriver`
    // this reaches updateComment as a 137-character string and ClickUp replaces
    // the comment body with those literal characters.
    await db.execute(
      sql`update ${comments} set segments = to_jsonb(${JSON.stringify(SEGMENTS)}::text) where id = ${COMMENT}`,
    );
    expect(await storedType("comments", "segments", `id = '${COMMENT}'`)).toBe("string");

    const [row] = await db
      .select({ segments: comments.segments })
      .from(comments)
      .where(sql`id = ${COMMENT}`);
    expect(Array.isArray(row?.segments)).toBe(true);

    const { client, calls } = commentClient();
    await client.updateComment(COMMENT, {
      text: "flattened",
      resolved: true,
      segments: row?.segments as CommentSegment[] | null,
    });

    const body = calls[0]?.body as { comment?: unknown };
    expect(typeof body.comment).not.toBe("string");
    expect(body.comment).toEqual(SEGMENTS);

    // Put the row back so test order cannot decide what the others see.
    await db.update(comments).set({ segments: SEGMENTS }).where(sql`id = ${COMMENT}`);
  });
});

/**
 * `lists.statuses` is what a List that overrides its Space's workflow shows in
 * the status picker.
 *
 * Double-encoded it reads back through `statusesForList` as a string, and the
 * picker renders one option per character. Null is a separate, correct state —
 * "this list does not override" — and it has to stay SQL NULL rather than the
 * jsonb value `null`, because the fallback to the Space's statuses is `??`.
 */
describe("lists.statuses", () => {
  const OVERRIDING = "jsonb-test-list-override";
  const INHERITING = "jsonb-test-list-inherit";

  const STATUSES = [
    { status: "to do", color: "#87909e", type: "open", orderindex: 0 },
    { status: "blocked", color: "#e50000", type: "custom", orderindex: 1 },
    { status: "done", color: "#008844", type: "closed", orderindex: 2 },
  ];

  beforeAll(async () => {
    await db.delete(lists).where(sql`id in (${OVERRIDING}, ${INHERITING})`);
    await db.insert(lists).values([
      { id: OVERRIDING, spaceId: SPACE, name: "overrides", statuses: STATUSES },
      { id: INHERITING, spaceId: SPACE, name: "inherits" },
    ]);
  });

  afterAll(async () => {
    await db.delete(lists).where(sql`id in (${OVERRIDING}, ${INHERITING})`);
  });

  test("stores an overriding list's statuses as an array", async () => {
    expect(await storedType("lists", "statuses", `id = '${OVERRIDING}'`)).toBe("array");
  });

  test("containment matches the custom status the list added", async () => {
    const rows = await db
      .select({ id: lists.id })
      .from(lists)
      .where(
        sql`${lists.statuses} @> jsonb_build_array(jsonb_build_object('status', ${"blocked"}::text))`,
      );

    expect(rows.map((row) => row.id)).toEqual([OVERRIDING]);
  });

  test("leaves a list that does not override at SQL NULL, not jsonb null", async () => {
    // `listStatuses ?? spaceStatuses` only falls through on null/undefined. A
    // jsonb `null` would come back as the JS value null too, but an empty array
    // would not — and either way the distinction is what makes every list in a
    // Space stop showing its statuses if it drifts.
    const rows = (await db.execute(
      sql`select statuses is null as is_null, jsonb_typeof(statuses) as t
          from lists where id = ${INHERITING}`,
    )) as unknown as Array<{ is_null: boolean; t: string | null }>;

    expect(rows[0]?.is_null).toBe(true);
    expect(rows[0]?.t).toBeNull();
  });

  test("hands the status picker an array of objects", async () => {
    const [row] = await db
      .select({ statuses: lists.statuses })
      .from(lists)
      .where(sql`id = ${OVERRIDING}`);

    expect(Array.isArray(row?.statuses)).toBe(true);
    expect(row?.statuses?.map((s) => s.status)).toEqual(["to do", "blocked", "done"]);
  });
});
