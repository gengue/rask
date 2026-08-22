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
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://rask:rask@localhost:5432/rask_test";

export function createTestDb(options: { max?: number } = {}): Db {
  return createDb(TEST_DATABASE_URL, { max: options.max ?? 1 });
}
