/**
 * Creates and migrates one test database per package.
 *
 * `bun run test` runs the five packages in parallel against one Postgres. They
 * used to share a single `rask_test`, and two of them are global by design:
 * the outbox drain claims *any* pending row, and the reconciliation reads every
 * list. So the worker's suite would occasionally pick up rows the API's suite
 * had just queued, and a green suite would go red once in a few runs with a
 * count off by one. A flaky suite is a suite people stop reading.
 *
 * A database each is cheaper than making every test defensive about rows it
 * did not write.
 *
 * `rask_test` itself stays because `packages/schema/src/test-db.ts` falls back
 * to it, which is what a bare `bun test` inside one package lands on.
 */
import { SQL } from "bun";

const BASE = process.env.DATABASE_URL ?? "postgres://rask:rask@localhost:5432/rask";
const NAMES = ["rask_test", "rask_test_api", "rask_test_worker", "rask_test_schema"];

function urlFor(name: string): string {
  const url = new URL(BASE);
  url.pathname = `/${name}`;
  return url.toString();
}

const admin = new SQL({ url: urlFor("postgres"), max: 1 });
for (const name of NAMES) {
  // Recreated rather than migrated onto: a renamed migration otherwise leaves a
  // column from an old tag behind, and the failures point everywhere but here.
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
}
await admin.end();

for (const name of NAMES) {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "--cwd", "packages/schema", "src/migrate.ts"],
    env: { ...process.env, DATABASE_URL: urlFor(name) },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`migrating ${name} failed`);
}

console.log(`ready: ${NAMES.join(", ")}`);
