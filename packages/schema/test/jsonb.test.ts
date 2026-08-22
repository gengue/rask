import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db.ts";
import { customFieldDefs, outbox, spaces, taskCustomValues, tasks } from "../src/schema.ts";

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

const url = process.env.DATABASE_URL;
const db = createDb(url ?? "postgres://rask:rask@localhost:5432/rask", { max: 1 });

const SPACE = "jsonb-test-space";
const TASK = "jsonb-test-task";
const FIELD = "jsonb-test-field";

afterAll(async () => {
  await db.delete(taskCustomValues).where(sql`task_id = ${TASK}`);
  await db.delete(tasks).where(sql`id = ${TASK}`);
  await db.delete(customFieldDefs).where(sql`id = ${FIELD}`);
  await db.delete(spaces).where(sql`id = ${SPACE}`);
  await db.delete(outbox).where(sql`user_id = ${"jsonb-test-user"}`);
});

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

  test("stores custom field config and values as objects", async () => {
    await db.insert(customFieldDefs).values({
      id: FIELD,
      name: "Impact",
      type: "drop_down",
      typeConfig: { options: [{ id: "a", name: "High", orderindex: 0 }] },
    });
    await db.insert(taskCustomValues).values({ taskId: TASK, fieldId: FIELD, value: { raw: "a" } });

    expect(await storedType("custom_field_defs", "type_config", `id = '${FIELD}'`)).toBe("object");
    expect(await storedType("task_custom_values", "value", `field_id = '${FIELD}'`)).toBe("object");
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
