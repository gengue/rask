/**
 * Measures a real sync against a real workspace.
 *
 *   bun run --cwd apps/worker measure                 # hierarchy only
 *   bun run --cwd apps/worker measure --space 90020068902
 *   bun run --cwd apps/worker measure --space 90020068902 --lists 5
 *
 * Uses CLICKUP_PERSONAL_TOKEN so it works before OAuth is wired up. Reports the
 * request count so the 100 req/min budget can be checked against real data
 * rather than guessed at.
 */

import { ClickUpClient } from "@rask/clickup-client";
import { createDb, lists as listsTable } from "@rask/schema";
import { eq } from "drizzle-orm";
import {
  syncHierarchy,
  syncList,
  syncListCustomFields,
  taskCount,
  trackList,
} from "../src/sync.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  const value = process.argv[i + 1];
  if (key && value) args.set(key, value);
}

const token = process.env.CLICKUP_PERSONAL_TOKEN;
if (!token) {
  console.error("CLICKUP_PERSONAL_TOKEN is not set. Get one from ClickUp > Settings > Apps.");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL ?? "postgres://rask:rask@localhost:5432/rask");
const client = new ClickUpClient({ token, auth: "personal" });

const teams = await client.getAuthorizedTeams();
const teamId = args.get("team") ?? teams[0]?.id;
if (!teamId) throw new Error("no ClickUp workspace on this token");
console.log(`workspace ${teamId} (${teams.find((t) => t.id === teamId)?.name ?? "?"})`);

const started = Date.now();
let requests = 1;

const hierarchy = await syncHierarchy(db, client, teamId);
requests += hierarchy.requests;
console.log(`hierarchy: ${hierarchy.requests} requests, ${hierarchy.ms}ms`);

const spaceId = args.get("space");
if (spaceId) {
  const limit = Number(args.get("lists") ?? 10);
  const candidates = await db
    .select({ id: listsTable.id, name: listsTable.name })
    .from(listsTable)
    .where(eq(listsTable.spaceId, spaceId))
    .limit(limit);

  console.log(`\nsyncing ${candidates.length} list(s) from space ${spaceId}`);

  for (const list of candidates) {
    await trackList(db, list.id);
    await syncListCustomFields(db, client, list.id);
    const stats = await syncList(db, client, list.id, { full: true, teamId });
    requests += stats.requests + 1;
    console.log(
      `  ${list.name.padEnd(38).slice(0, 38)} ${String(stats.tasks).padStart(5)} tasks  ` +
        `${String(stats.requests + 1).padStart(3)} req  ${String(stats.ms).padStart(6)}ms`,
    );
  }
}

const elapsed = Date.now() - started;
console.log(
  `\ntotal: ${requests} requests, ${await taskCount(db)} tasks in the mirror, ${(elapsed / 1000).toFixed(1)}s ` +
    `(${(requests / (elapsed / 60000)).toFixed(0)} req/min sustained; ClickUp allows 100)`,
);
process.exit(0);
