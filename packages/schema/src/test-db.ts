import { createDb, type Db } from "./db.ts";

/**
 * The database the tests are allowed to write to.
 *
 * Deliberately not the same default as everything else. The tests insert and
 * delete real rows, and the obvious fallback — the `rask` database a developer
 * actually uses — means a bare `bun run test` with no environment set quietly
 * mutates the workspace mirror they are looking at. `rask_test` exists so that
 * mistake is impossible; `bun run db:test` creates and migrates it.
 */
const FALLBACK = "postgres://rask:rask@localhost:5432/rask_test";

/**
 * Never the database you are looking at.
 *
 * `DATABASE_URL` is not enough of a signal: Bun auto-loads the repo `.env`, so
 * a bare `bun test` from the root picks up the dev database and these tests
 * insert and delete real rows in it. Only an explicit `TEST_DATABASE_URL`, or a
 * `DATABASE_URL` that already names a test database, is honoured.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.DATABASE_URL?.includes("_test") ? process.env.DATABASE_URL : FALLBACK);

export function createTestDb(options: { max?: number } = {}): Db {
  return createDb(TEST_DATABASE_URL, { max: options.max ?? 1 });
}
