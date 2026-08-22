import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDb } from "./db.ts";

/**
 * Applies the SQL in ./migrations.
 *
 * drizzle-kit's own `migrate` command runs under Node and refuses to work
 * without a Node Postgres driver. The runtime already has Bun.sql, so we drive
 * drizzle's bun-sql migrator directly and keep drizzle-kit for codegen only.
 */
export async function runMigrations(url: string): Promise<void> {
  const db = createDb(url, { max: 1 });
  await migrate(db, {
    migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"),
  });
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  await runMigrations(url);
  console.log("migrations applied");
  process.exit(0);
}
