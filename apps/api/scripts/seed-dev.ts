/**
 * Fills the local database with a workspace that looks like a real one, and
 * prints a session cookie so the UI can be opened without going through
 * ClickUp OAuth.
 *
 *   bun run --cwd apps/api seed
 *
 * Deliberately not a login endpoint: this writes a session row directly and
 * hands you the cookie. There is no code path in the server that can be
 * tricked into doing the same thing, in any environment.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  comments,
  createDb,
  customFieldDefs,
  folders,
  lists,
  loadKey,
  oauthTokens,
  saveToken,
  sessions,
  spaces,
  syncCursors,
  taskAssignees,
  taskCustomValues,
  tasks,
  users,
} from "@rask/schema";
import { sql } from "drizzle-orm";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://rask:rask@localhost:5432/rask";
const db = createDb(databaseUrl);

const TEAM_ID = "529";

const PEOPLE = [
  {
    id: "1001",
    username: "genesis",
    email: "genesis@example.com",
    color: "#7b68ee",
    initials: "GG",
  },
  { id: "1002", username: "marta", email: "marta@example.com", color: "#2ecd6f", initials: "MR" },
  { id: "1003", username: "tobias", email: "tobias@example.com", color: "#f9d900", initials: "TK" },
  { id: "1004", username: "ana", email: "ana@example.com", color: "#ff7fab", initials: "AL" },
  { id: "1005", username: "kwame", email: "kwame@example.com", color: "#0ab4ff", initials: "KO" },
];

const STATUS_SET = [
  { id: "s1", status: "backlog", color: "#6b6f76", type: "open", orderindex: 0 },
  { id: "s2", status: "todo", color: "#8a8f98", type: "custom", orderindex: 1 },
  { id: "s3", status: "in progress", color: "#f2c94c", type: "custom", orderindex: 2 },
  { id: "s4", status: "in review", color: "#9b8afb", type: "custom", orderindex: 3 },
  { id: "s5", status: "done", color: "#2ecd6f", type: "done", orderindex: 4 },
];

const TAGS = [
  { name: "performance", fg: "#FFFFFF", bg: "#EA4335" },
  { name: "infra", fg: "#FFFFFF", bg: "#0ab4ff" },
  { name: "ios", fg: "#FFFFFF", bg: "#7b68ee" },
  { name: "billing", fg: "#FFFFFF", bg: "#f9a825" },
  { name: "flaky", fg: "#FFFFFF", bg: "#ff7fab" },
];

const TITLES = [
  "Faster app launch",
  "Render UI before vehicle_state sync",
  "Dropped websocket reconnect on background",
  "Migrate booking service to Postgres 17",
  "Rate limiter drops the 101st request",
  "Reconcile ClickUp webhooks that never arrive",
  "Trip search returns stale availability",
  "Payment retry loops on 402",
  "Cache invalidation on itinerary edit",
  "Refactor auth middleware for OAuth rotation",
  "Timezone drift in departure reminders",
  "Bulk import chokes above 5k rows",
  "Sentry noise from cancelled fetches",
  "Design tokens out of sync with Figma",
  "Flaky checkout e2e on CI",
  "Add index on tasks.date_updated",
  "Split the monolith worker queue",
  "Guest checkout skips address validation",
  "Push notification opt-in copy",
  "Audit log missing actor on system writes",
  "Optimistic status change flickers back",
  "Kill the legacy PDF renderer",
  "Onboarding stalls at step 3",
  "Currency rounding in the invoice total",
  "Deduplicate supplier records",
];

/** Shorter than a task title, because a subtask is a step and not a problem. */
const SUBTASK_TITLES = [
  "Write the migration",
  "Back-fill the existing rows",
  "Add the index",
  "Update the client",
  "Review with infra",
  "Ship behind a flag",
  "Measure before and after",
  "Delete the old path",
];

const DESCRIPTIONS = [
  "Render UI before `vehicle_state` sync when minimum required state is present, instead of blocking on full refresh during iOS startup.\n\n- Measure cold start with the profiler\n- Gate on `hasMinimumState`\n- Keep the spinner for the genuinely empty case",
  "## Context\n\nThe reconnect handler assumes the socket is still open. Backgrounding the app on iOS closes it silently, so the first message after resume is dropped.\n\n## Fix\n\nCheck `readyState` before writing and requeue on failure.",
  "Straightforward: the index is missing, so every incremental poll does a sequential scan.\n\n```sql\ncreate index concurrently tasks_updated_idx on tasks (date_updated);\n```",
  null,
  "Repro is flaky, roughly 1 in 8 runs. Suspect a race between the fixture teardown and the next test's login.",
];

const COMMENT_TEXTS = [
  "Right now we show a spinner forever, which makes it look like the car disappeared.",
  "Can you take a stab at this? Should be a small change.",
  "Reproduced on staging. Logs attached in the thread.",
  "I'd rather fix the root cause than add another retry.",
  "Shipped behind a flag, rolling out to 10% today.",
];

/** Deterministic PRNG: the same seed produces the same workspace every time. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
const random = makeRandom(20260822);
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;

/**
 * The most tasks this seed ever writes. Anything above it is somebody's mirror.
 *
 * `DATABASE_URL` in a working `.env` points at the database the app is actually
 * using, and this script's first act is to delete every row in it. On a fresh
 * clone that is empty and nothing is lost; on a checkout that has synced a real
 * workspace it is 147,000 tasks, and the recovery is a full resync that takes
 * the better part of an hour.
 *
 * So: count first, refuse if the number is bigger than anything this script
 * could have produced, and make the override loud enough that nobody types it
 * by accident.
 */
const SEED_TASK_CEILING = 500;

async function guardDatabase(): Promise<void> {
  if (process.env.RASK_SEED_FORCE === "1") return;

  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks);
  const existing = row?.n ?? 0;
  if (existing <= SEED_TASK_CEILING) return;

  const name = new URL(databaseUrl).pathname.replace(/^\//, "");
  console.error(
    `Refusing to seed: "${name}" holds ${existing.toLocaleString()} tasks, which is more\n` +
      `than this script ever writes. That looks like a real ClickUp mirror, and\n` +
      `seeding deletes every row in it.\n\n` +
      `If you meant it: RASK_SEED_FORCE=1 bun run --cwd apps/api seed`,
  );
  process.exit(1);
}

async function seed() {
  await guardDatabase();

  console.log("clearing...");
  await db.delete(comments);
  await db.delete(taskCustomValues);
  await db.delete(taskAssignees);
  await db.delete(tasks);
  await db.delete(customFieldDefs);
  await db.delete(syncCursors);
  await db.delete(lists);
  await db.delete(folders);
  await db.delete(spaces);
  await db.delete(sessions);
  await db.delete(oauthTokens);
  await db.delete(users);

  await db.insert(users).values(
    PEOPLE.map((person, index) => ({
      ...person,
      profilePicture: null,
      isRaskUser: index === 0,
    })),
  );

  const spaceRows = [
    { id: "90020068902", teamId: TEAM_ID, name: "Tickets", statuses: STATUS_SET },
    { id: "3215874", teamId: TEAM_ID, name: "Teams", statuses: STATUS_SET },
  ];
  await db.insert(spaces).values(spaceRows);

  const folderRows = [
    { id: "90150113354", spaceId: "90020068902", name: "GO", orderindex: 0 },
    { id: "90150113356", spaceId: "90020068902", name: "Infra", orderindex: 1 },
    { id: "90150113400", spaceId: "90020068902", name: "APP", orderindex: 2 },
    { id: "7362893", spaceId: "3215874", name: "IT", orderindex: 0 },
  ];
  await db.insert(folders).values(folderRows);

  const listRows = [
    {
      id: "L1",
      spaceId: "90020068902",
      folderId: "90150113354",
      name: "GO Backend",
      orderindex: 0,
    },
    {
      id: "L2",
      spaceId: "90020068902",
      folderId: "90150113354",
      name: "GO Frontend",
      orderindex: 1,
    },
    { id: "L3", spaceId: "90020068902", folderId: "90150113356", name: "Platform", orderindex: 0 },
    { id: "L4", spaceId: "90020068902", folderId: "90150113400", name: "Mobile", orderindex: 0 },
    { id: "L5", spaceId: "90020068902", folderId: null, name: "Triage", orderindex: 3 },
    { id: "L6", spaceId: "3215874", folderId: "7362893", name: "IT Requests", orderindex: 0 },
  ];
  await db.insert(lists).values(listRows.map((list) => ({ ...list, statuses: null })));
  await db
    .insert(syncCursors)
    .values(listRows.map((list) => ({ scope: "list" as const, scopeId: list.id })));

  const fieldRows = [
    {
      id: "cf-impact",
      name: "Impact",
      type: "drop_down",
      typeConfig: {
        options: [
          { id: "opt-low", name: "Low", orderindex: 0, color: null },
          { id: "opt-med", name: "Medium", orderindex: 1, color: "#f9a825" },
          { id: "opt-high", name: "High", orderindex: 2, color: "#EA4335" },
        ],
      },
      required: false,
    },
    { id: "cf-sprint", name: "Sprint", type: "text", typeConfig: null, required: false },
    { id: "cf-verified", name: "Verified", type: "checkbox", typeConfig: null, required: false },
  ];
  await db.insert(customFieldDefs).values(fieldRows);

  console.log("generating tasks...");
  const now = Date.now();
  const taskRows: Array<typeof tasks.$inferInsert> = [];
  const assigneeRows: Array<typeof taskAssignees.$inferInsert> = [];
  const valueRows: Array<typeof taskCustomValues.$inferInsert> = [];
  const commentRows: Array<typeof comments.$inferInsert> = [];

  let counter = 2600;

  for (const list of listRows) {
    const count = list.id === "L1" ? 180 : list.id === "L5" ? 90 : 45;

    for (let i = 0; i < count; i++) {
      counter++;
      const id = `t${counter}`;
      const status = pick(STATUS_SET);
      const dueOffset = Math.floor(random() * 30) - 8;
      const hasDue = random() > 0.35;
      const assignedToMe = random() > 0.55;

      taskRows.push({
        id,
        customId: `ENG-${counter}`,
        listId: list.id,
        folderId: list.folderId,
        spaceId: list.spaceId,
        teamId: TEAM_ID,
        name: pick(TITLES),
        description: pick(DESCRIPTIONS),
        status: status.status,
        statusColor: status.color,
        statusType: status.type,
        priority: random() > 0.5 ? Math.ceil(random() * 4) : null,
        dueDate: hasDue ? new Date(now + dueOffset * 86_400_000) : null,
        dateCreated: new Date(now - Math.floor(random() * 90) * 86_400_000),
        dateUpdated: new Date(now - Math.floor(random() * 14) * 86_400_000),
        creatorId: pick(PEOPLE).id,
        tags: random() > 0.6 ? [pick(TAGS)] : [],
        url: `https://app.clickup.com/t/${id}`,
      });

      if (assignedToMe) assigneeRows.push({ taskId: id, userId: "1001" });
      if (random() > 0.6) {
        const other = pick(PEOPLE);
        if (!(assignedToMe && other.id === "1001")) {
          assigneeRows.push({ taskId: id, userId: other.id });
        }
      }

      if (random() > 0.5) {
        valueRows.push({
          taskId: id,
          fieldId: "cf-impact",
          value: pick(["opt-low", "opt-med", "opt-high"]),
        });
      }
      if (random() > 0.7) {
        valueRows.push({
          taskId: id,
          fieldId: "cf-sprint",
          value: `S${20 + Math.floor(random() * 6)}`,
        });
      }

      /*
       * A few parents, so the subtask panel is reachable without a real
       * workspace. It used to be invisible here: the fixture had 450 tasks and
       * not one `parentId`, so every change to that panel had to be checked
       * against ClickUp or not at all.
       *
       * Estimates and tracked totals are deliberately patchy. Most ClickUp
       * tasks carry neither, and a row that shows a number for every subtask
       * would hide the case the layout actually has to survive.
       */
      if (list.id === "L1" && i < 6) {
        const howMany = 2 + Math.floor(random() * 3);
        for (let c = 0; c < howMany; c++) {
          const childStatus = pick(STATUS_SET);
          const child = `${id}-s${c}`;
          taskRows.push({
            id: child,
            customId: null,
            listId: list.id,
            folderId: list.folderId,
            spaceId: list.spaceId,
            teamId: TEAM_ID,
            parentId: id,
            name: pick(SUBTASK_TITLES),
            status: childStatus.status,
            statusColor: childStatus.color,
            statusType: childStatus.type,
            orderindex: String(c),
            dueDate:
              random() > 0.25 ? new Date(now + (Math.floor(random() * 20) - 5) * 86_400_000) : null,
            timeEstimate: random() > 0.5 ? (1 + Math.floor(random() * 8)) * 1_800_000 : null,
            timeSpent: random() > 0.5 ? Math.floor(random() * 300) * 60_000 : 0,
            dateCreated: new Date(now - Math.floor(random() * 30) * 86_400_000),
            dateUpdated: new Date(now - Math.floor(random() * 5) * 86_400_000),
            creatorId: pick(PEOPLE).id,
            tags: [],
            url: `https://app.clickup.com/t/${child}`,
          });
          if (random() > 0.3) assigneeRows.push({ taskId: child, userId: pick(PEOPLE).id });
        }
      }

      if (random() > 0.75) {
        const howMany = 1 + Math.floor(random() * 3);
        for (let c = 0; c < howMany; c++) {
          commentRows.push({
            id: `${id}-c${c}`,
            taskId: id,
            userId: pick(PEOPLE).id,
            text: pick(COMMENT_TEXTS),
            date: new Date(now - Math.floor(random() * 10) * 86_400_000),
          });
        }
      }
    }
  }

  for (const chunk of chunks(taskRows, 300)) await db.insert(tasks).values(chunk);
  for (const chunk of chunks(assigneeRows, 500)) {
    await db.insert(taskAssignees).values(chunk).onConflictDoNothing();
  }
  for (const chunk of chunks(valueRows, 500)) {
    await db.insert(taskCustomValues).values(chunk).onConflictDoNothing();
  }
  for (const chunk of chunks(commentRows, 500)) {
    await db.insert(comments).values(chunk).onConflictDoNothing();
  }

  // A session is only usable alongside a ClickUp token, so seed one. It is not
  // a real token: every write will fail against ClickUp until you sign in for
  // real, which is the honest behaviour for seeded data.
  await saveToken(db, {
    userId: "1001",
    teamId: TEAM_ID,
    token: "seed-not-a-real-clickup-token",
    key: loadKey(process.env.TOKEN_ENCRYPTION_KEY),
  });

  const raw = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    id: createHash("sha256").update(raw).digest("hex"),
    userId: "1001",
    expiresAt: new Date(now + 30 * 86_400_000),
  });

  // The Vite dev server reads this to hand out the cookie at /__dev-login.
  await Bun.write(new URL("../../web/.dev-session", import.meta.url), raw);

  console.log(
    `\n${taskRows.length} tasks, ${commentRows.length} comments, ${listRows.length} lists`,
  );
  console.log("\nSign in: open http://localhost:5173/__dev-login\n");
  process.exit(0);
}

function* chunks<T>(rows: T[], size: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

await seed();
