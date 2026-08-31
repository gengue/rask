import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb } from "../src/test-db.ts";

/**
 * Two distinct queries must never agree on the first 41 characters of their
 * prepared-statement name.
 *
 * Bun names a statement `P` + the first 40 characters of the SQL + `$` + a
 * per-connection counter (oven-sh/bun#30494). Drizzle's generated selects
 * share those 40 characters wholesale — every tasks select starts
 * `select "id", "custom_id", "name", "statu` — and when a counter race lands
 * two of them behind one name, the server binds one query's parameters to the
 * other's plan. That was the 2026-08-29 e2e flake: `bind message supplies 1
 * parameters, but prepared statement requires 3` on random routes.
 *
 * `createDb` prefixes every query with a fingerprint comment (`q` + a hash of
 * the full text) so the first 40 characters are unique per query text. A real
 * connection is the only
 * honest seam: the name lives server-side, in `pg_prepared_statements`, and
 * a wrapper accidentally dropped from the client would change nothing the
 * ORM can see.
 */
test("distinct queries never share a statement name prefix", async () => {
  const db = createTestDb({ max: 1 });

  // Same first 40+ characters, different tails and parameter counts — the
  // exact shape that collided in production.
  await db.execute(sql`select ${"a"}::text as shared_prefix_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_one`);
  await db.execute(
    sql`select ${"b"}::text as shared_prefix_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_two, ${1}::int as extra`,
  );

  const rows = (await db.execute(
    sql`select name from pg_prepared_statements where statement like '%shared_prefix_%'`,
  )) as Array<{ name: string }>;

  expect(rows.length).toBe(2);
  const prefixes = rows.map((row) => row.name.slice(0, 41));
  expect(new Set(prefixes).size).toBe(2);
  for (const name of rows.map((row) => row.name)) {
    expect(name).toMatch(/^P\/\*q[0-9a-z]+\*\//);
  }
});
