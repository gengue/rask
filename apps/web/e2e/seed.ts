import { spawnSync } from "node:child_process";

/** Rebuilds the fixture workspace and the dev session cookie before the run. */
export default function globalSetup(): void {
  const result = spawnSync("bun", ["run", "--cwd", "../api", "seed"], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) throw new Error("seeding failed; is Postgres up? (bun run db:up)");
}
