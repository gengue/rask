import { spawnSync } from "node:child_process";
import { E2E, E2E_ENV } from "./env.ts";

/**
 * Builds the fixture workspace the suite runs against.
 *
 * The database is created over a plain connection rather than by shelling out
 * to `docker compose`: CI runs Postgres as a service container and has no
 * compose file to exec into. The connection goes through a `bun -e` subprocess
 * because Playwright runs this file under Node, which has no `bun:sql`.
 *
 * Recreated rather than migrated onto, for the same reason `db:test` is: a
 * renamed migration otherwise leaves a column from an old tag behind and the
 * failures point everywhere except at the cause.
 */
export default function globalSetup(): void {
  const env = { ...process.env, ...E2E_ENV };

  run(
    [
      "bun",
      "-e",
      `import { SQL } from "bun";
       const url = new URL(process.env.DATABASE_URL);
       url.pathname = "/postgres";
       const sql = new SQL({ url: url.toString(), max: 1 });
       await sql\`drop database if exists rask_e2e with (force)\`;
       await sql\`create database rask_e2e\`;
       await sql.end();`,
    ],
    env,
    "could not create rask_e2e; is Postgres up? (bun run db:up)",
  );

  run(["bun", "run", "--cwd", "../../packages/schema", "src/migrate.ts"], env, "migrations failed");
  run(["bun", "run", "--cwd", "../api", "seed"], env, "seeding rask_e2e failed");

  console.log(`[e2e] ${E2E.databaseUrl}, api :${E2E.apiPort}, web :${E2E.webPort}`);
}

function run(argv: string[], env: NodeJS.ProcessEnv, message: string): void {
  const [command, ...args] = argv;
  if (!command) throw new Error("empty command");
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.status !== 0) throw new Error(message);
}
