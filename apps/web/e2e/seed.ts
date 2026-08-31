import { spawnSync } from "node:child_process";
import { E2E, E2E_ENV } from "./env.ts";

/**
 * Builds the fixture workspace the suite runs against.
 *
 * The database is recreated and migrated by `scripts/db-test.ts` — the one
 * copy of that procedure — through a `bun` subprocess because Playwright runs
 * this file under Node, which has no `bun:sql`. The script reads
 * `DATABASE_URL` (set to the e2e database in `E2E_ENV`) and its inner spawns
 * resolve from the repo root, hence the cwd.
 */
export default function globalSetup(): void {
  const env = { ...process.env, ...E2E_ENV };

  run(
    ["bun", "scripts/db-test.ts", E2E.dbName],
    env,
    `could not create ${E2E.dbName}; is Postgres up? (bun run db:up)`,
    "../..",
  );
  run(["bun", "run", "--cwd", "../api", "seed"], env, `seeding ${E2E.dbName} failed`);

  console.log(`[e2e] ${E2E.databaseUrl}, api :${E2E.apiPort}, web :${E2E.webPort}`);
}

function run(argv: string[], env: NodeJS.ProcessEnv, message: string, cwd?: string): void {
  const [command, ...args] = argv;
  if (!command) throw new Error("empty command");
  const result = spawnSync(command, args, { stdio: "inherit", env, cwd });
  if (result.status !== 0) throw new Error(message);
}
