/**
 * Measures a real sync against a real workspace.
 *
 *   bun run --cwd apps/worker measure                       # hierarchy only
 *   bun run --cwd apps/worker measure --space <id>          # + its 10 biggest lists
 *   bun run --cwd apps/worker measure --space <id> --lists 3
 *   bun run --cwd apps/worker measure --list <id>           # one specific list
 *
 * Uses CLICKUP_PERSONAL_TOKEN so it works before OAuth is wired up. Lists are
 * taken biggest-first: the point is to find where the 100 req/min budget
 * actually binds, and that is the worst case, not the median one.
 */

import { ClickUpClient } from "@rask/clickup-client";
import { createDb, lists as listsTable } from "@rask/schema";
import { desc, eq } from "drizzle-orm";
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
const singleList = args.get("list");

const candidates = singleList
  ? await db
      .select({ id: listsTable.id, name: listsTable.name, taskCount: listsTable.taskCount })
      .from(listsTable)
      .where(eq(listsTable.id, singleList))
  : spaceId
    ? await db
        .select({ id: listsTable.id, name: listsTable.name, taskCount: listsTable.taskCount })
        .from(listsTable)
        .where(eq(listsTable.spaceId, spaceId))
        // Biggest first: the budget binds on the worst case, not the median.
        .orderBy(desc(listsTable.taskCount))
        .limit(Number(args.get("lists") ?? 10))
    : [];

if (candidates.length > 0) {
  console.log(`\nfull sync of ${candidates.length} list(s), biggest first\n`);
  console.log(
    `  ${"list".padEnd(38)} ${"tasks".padStart(6)} ${"req".padStart(5)} ${"time".padStart(8)}`,
  );

  for (const list of candidates) {
    await trackList(db, list.id);
    await syncListCustomFields(db, client, list.id);
    const stats = await syncList(db, client, list.id, { full: true, teamId });
    requests += stats.requests + 1;
    console.log(
      `  ${list.name.padEnd(38).slice(0, 38)} ${String(stats.tasks).padStart(6)} ` +
        `${String(stats.requests + 1).padStart(5)} ${`${(stats.ms / 1000).toFixed(1)}s`.padStart(8)}`,
    );
  }

  console.log("\n--- incremental pass over the same lists (nothing changed) ---\n");
  const incrementalStart = Date.now();
  let incrementalRequests = 0;
  for (const list of candidates) {
    const stats = await syncList(db, client, list.id, { teamId });
    incrementalRequests += stats.requests;
  }
  console.log(
    `  ${candidates.length} lists, ${incrementalRequests} requests, ` +
      `${((Date.now() - incrementalStart) / 1000).toFixed(1)}s — this is what polling costs`,
  );
  requests += incrementalRequests;
}

const elapsed = Date.now() - started;
const totalLists = (await db.select({ id: listsTable.id }).from(listsTable)).length;

console.log(
  `\ntotal: ${requests} requests, ${await taskCount(db)} tasks mirrored, ${(elapsed / 1000).toFixed(1)}s`,
);
console.log(
  `budget: ClickUp allows 100 req/min per token. ${totalLists} lists exist; polling every one ` +
    `costs ${totalLists} req/cycle, so a single token needs ${(totalLists / 100).toFixed(1)} min per full pass.`,
);
console.log(
  "Rask only polls lists someone has opened, and spreads them across every signed-in user's token.",
);
process.exit(0);
