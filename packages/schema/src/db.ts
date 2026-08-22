import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema.ts";

/**
 * Bun's built-in Postgres client. No `pg`, no `postgres.js`: the runtime ships
 * a pooled driver and Drizzle has a first-party adapter for it.
 */
export function createDb(url: string, options: { max?: number } = {}) {
  const client = new SQL({ url, max: options.max ?? 10 });
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;
