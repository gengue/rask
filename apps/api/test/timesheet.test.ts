import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ClickUpClient, RateLimiter } from "@rask/clickup-client";
import { createTestDb, folders, lists, spaces, tasks } from "@rask/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { SessionUser } from "../src/auth.ts";
import { timesheetRoutes } from "../src/timesheet.ts";

/**
 * The timesheet week route, against a stubbed ClickUp.
 *
 * The piece worth testing at this level is the fold: entries in, task-by-day
 * cells out. Its traps are all quiet ones — a day boundary drawn in the wrong
 * timezone drops somebody's evening into the wrong column; a negative
 * duration treated as a total writes gibberish into a cell; a missing mirror
 * row either vanishes off the sheet or ships as "(task not found)". Each test
 * below pins one.
 *
 * `ClickUpClient` takes a `baseUrl`, so nothing here reaches ClickUp.
 */

const db = createTestDb();

const TEAM = "42";
const ME = "api-sheet-user";
const TASK = "api-sheet-task";
const OTHER = "api-sheet-other";

const USER: SessionUser = {
  id: ME,
  username: "Ada",
  email: "ada@example.com",
  initials: "A",
  color: null,
  avatar: null,
  teamId: TEAM,
  inboxSeenAt: new Date(0),
};

interface Call {
  method: string;
  url: string;
}

function stub(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const queue = [...responses];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input) });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected ClickUp request: ${init?.method ?? "GET"} ${input}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const client = new ClickUpClient({
    token: "pk_test",
    fetch: fetchImpl,
    limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
    sleep: async () => {},
  });

  return { client, calls };
}

function mount(client: ClickUpClient | null) {
  const repaired: string[] = [];

  const app = new Hono<{ Variables: { user: SessionUser } }>();
  app.use("*", async (c, next) => {
    c.set("user", USER);
    await next();
  });
  app.route(
    "/timesheet",
    timesheetRoutes({
      db,
      clientFor: async () => client,
      repairTask: async (_userId, taskId) => {
        repaired.push(taskId);
      },
    }),
  );

  return { app, repaired };
}

/**
 * An entry in ClickUp's shape. `start` is epoch ms as ClickUp sends it — a
 * number-in-string is what the real payload carries, and keeping that here is
 * how a parser slip would get caught instead of papered over.
 */
function entry(over: Record<string, unknown> = {}) {
  return {
    id: "e1",
    task: { id: TASK, name: "Write the thing" },
    wid: TEAM,
    user: { id: 7, username: "Ada" },
    billable: false,
    start: "1756080000000",
    end: "1756083600000",
    duration: "3600000",
    description: "",
    tags: [],
    ...over,
  };
}

/** Sunday 00:00 of a fixed week, Bogotá time (UTC-5): Aug 23–29, 2026. */
const SUNDAY_BOGOTA = Date.UTC(2026, 7, 23, 5, 0, 0);
const TZ_BOGOTA = -300;

const WEEKQ = (over = "") => `/timesheet/week?tz=${encodeURIComponent(String(TZ_BOGOTA))}${over}`;

beforeEach(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
  await db.delete(tasks).where(eq(tasks.id, OTHER));
});

afterAll(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
  await db.delete(tasks).where(eq(tasks.id, OTHER));
});

describe("GET /timesheet/week", () => {
  test("asks for one person's entries across no particular task", async () => {
    const { client, calls } = stub([{ body: { data: [] } }]);
    const { app } = mount(client);

    await app.request(WEEKQ());

    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("assignee")).toBe(ME);
    expect(url.searchParams.has("task_id")).toBe(false);
  });

  test("a Monday-evening entry lands on Monday's column, not the week edge", async () => {
    // Mon Aug 24 2026, 18:00 Bogotá = 23:00 UTC — inside day index 1.
    const mondayEvening = Date.UTC(2026, 7, 24, 23, 0, 0);
    const { client } = stub([
      { body: { data: [entry({ start: String(mondayEvening), duration: "1800000" })] } },
    ]);
    const { app } = mount(client);

    const response = await app.request(WEEKQ());
    const { rows, start } = (await response.json()) as {
      rows: Array<{ days: Array<{ durationMs: number } | null> }>;
      start: number;
    };

    // The answered window opens exactly on the requested zone's Sunday.
    expect(start).toBe(SUNDAY_BOGOTA);
    expect(rows[0]?.days[0]).toBeNull();
    expect(rows[0]?.days[1]?.durationMs).toBe(1_800_000);
  });

  test("two intervals on one task and day sum into one cell", async () => {
    const base = SUNDAY_BOGOTA + 30 * 60 * 60 * 1000; // Mon ~06:00 local
    const first = entry({ id: "e1", start: String(base), duration: "3600000" });
    const second = entry({ id: "e2", start: String(base + 7_200_000), duration: "1800000" });
    const { client } = stub([{ body: { data: [first, second] } }]);
    const { app } = mount(client);

    const response = await app.request(WEEKQ());
    const { rows } = (await response.json()) as {
      rows: Array<{ days: Array<{ durationMs: number } | null>; totalMs: number }>;
    };

    expect(rows[0]?.days[1]?.durationMs).toBe(5_400_000);
    expect(rows[0]?.totalMs).toBe(5_400_000);
  });

  test("the running entry contributes its elapsed slice and marks cell and row", async () => {
    const now = Date.now();
    // Started half an hour ago today; duration negative, end absent.
    const startedAt = String(now - 1_800_000);
    const live = entry({ id: "live", start: startedAt, duration: "-1", end: undefined });
    const { client } = stub([{ body: { data: [live] } }]);
    const { app } = mount(client);

    const response = await app.request(WEEKQ());
    const payload = (await response.json()) as {
      rows: Array<{
        days: Array<{ durationMs: number; running: boolean } | null>;
        totalMs: number;
      }>;
    };
    const row = payload.rows[0];
    // Today in the BOGOTÁ frame, the frame the grid is laid out in: folding
    // the epoch only works until UTC's midnight runs ahead of local evening,
    // and then the test reads one column to the right of the entry.
    const localNow = now - TZ_BOGOTA * 60_000;
    const localSunday = SUNDAY_BOGOTA - TZ_BOGOTA * 60_000;
    const todayIndex = Math.floor((localNow - localSunday) / 86_400_000);

    const todayCell = row?.days[todayIndex];
    expect(todayCell).not.toBeNull();
    // Roughly thirty minutes; exact equality would make this test flaky by
    // construction, since the server reads its own clock between ours.
    const cell = todayCell ?? { durationMs: 0, running: false };
    expect(Math.abs(cell.durationMs - 1_800_000)).toBeLessThan(5_000);
    expect(cell.running).toBe(true);
    expect(row?.days.filter((entry) => entry !== null)).toHaveLength(1);
  });

  test("an explicit ?start anchors the sheet to that week, not this one", async () => {
    // The previous week's Friday — any instant names the week and the route
    // snaps it to the boundary.
    const lastWeekInstant = SUNDAY_BOGOTA - 86_400_000 * 2;
    const { client } = stub([{ body: { data: [] } }]);
    const { app } = mount(client);

    const response = await app.request(`${WEEKQ()}&start=${lastWeekInstant}`);
    const payload = (await response.json()) as { start: number; rows: Array<object> };

    expect(payload.start).toBe(SUNDAY_BOGOTA - 7 * 86_400_000);
    expect(payload.rows).toEqual([]);
  });

  test("a hand-typed start falls back to this week rather than exploding", async () => {
    const { client } = stub([{ body: { data: [] } }]);
    const { app } = mount(client);

    const response = await app.request(`${WEEKQ()}&start=not-a-number`);
    const payload = (await response.json()) as { start: number };

    // Whatever the garbage, the answered window must be a real week — and the
    // boundary is midnight in some zone, hence a multiple of a quarter hour
    // rather than of a whole day.
    expect(Number.isFinite(payload.start)).toBe(true);
    expect(payload.start % 900_000).toBe(0);
  });

  test("entries outside the asked week land nowhere and still count nowhere", async () => {
    // A moment inside the previous week.
    const lastWeek = SUNDAY_BOGOTA - 3_600_000;
    const { client } = stub([{ body: { data: [entry({ start: String(lastWeek) })] } }]);
    const { app } = mount(client);

    const response = await app.request(WEEKQ());
    const { rows } = (await response.json()) as { rows: Array<object> };

    // The fold must neither clip it into column 0 nor crash on the negative
    // day index: an off-grid hour belongs to last week's sheet.
    expect(rows).toEqual([]);
  });

  test("rows sort heaviest first", async () => {
    const base = SUNDAY_BOGOTA + 26 * 60 * 60 * 1000;
    const light = entry({
      id: "light",
      task: { id: OTHER, name: "Small thing" },
      start: String(base),
      duration: "600000",
    });
    const heavy = entry({ id: "heavy", start: String(base), duration: "7200000" });
    const { client } = stub([{ body: { data: [light, heavy] } }]);
    const { app } = mount(client);

    const response = await app.request(WEEKQ());
    const { rows } = (await response.json()) as { rows: Array<{ taskId: string }> };

    expect(rows.map((row) => row.taskId)).toEqual([TASK, OTHER]);
  });

  test("status and location come from the mirror, path joined space-first", async () => {
    await db.insert(spaces).values({ id: "s1", teamId: TEAM, name: "Teams" });
    await db.insert(folders).values({ id: "f1", spaceId: "s1", name: "Tailor Made" });
    await db.insert(lists).values({ id: "l1", spaceId: "s1", folderId: "f1", name: "MyVentura" });
    await db.insert(tasks).values({
      id: TASK,
      listId: "l1",
      folderId: "f1",
      spaceId: "s1",
      name: "Mirrored name",
      status: "in progress",
      statusColor: "#f8ae00",
      statusType: "custom",
    });

    const base = SUNDAY_BOGOTA + 26 * 60 * 60 * 1000;
    const { client } = stub([{ body: { data: [entry({ start: String(base) })] } }]);
    const { app } = mount(client);

    try {
      const response = await app.request(WEEKQ());
      const { rows } = (await response.json()) as {
        rows: Array<{
          taskName: string;
          status: string | null;
          statusColor: string | null;
          location: string | null;
        }>;
      };

      expect(rows[0]?.taskName).toBe("Mirrored name");
      expect(rows[0]?.status).toBe("in progress");
      expect(rows[0]?.statusColor).toBe("#f8ae00");
      expect(rows[0]?.location).toBe("Teams / Tailor Made / MyVentura");
    } finally {
      await db.delete(tasks).where(eq(tasks.id, TASK));
      await db.delete(lists).where(eq(lists.id, "l1"));
      await db.delete(folders).where(eq(folders.id, "f1"));
      await db.delete(spaces).where(eq(spaces.id, "s1"));
    }
  });

  test("a task the mirror never held still shows, upstream name and all", async () => {
    const base = SUNDAY_BOGOTA + 26 * 60 * 60 * 1000;
    const stranger = entry({
      id: "stranger",
      task: { id: "never-mirrored", name: "Lives only in ClickUp" },
      start: String(base),
      duration: "900000",
    });
    const { client } = stub([{ body: { data: [stranger] } }]);
    const { app, repaired } = mount(client);

    const response = await app.request(WEEKQ());
    const { rows } = (await response.json()) as {
      rows: Array<{ taskId: string; taskName: string; location: string | null }>;
    };

    expect(repaired).toEqual(["never-mirrored"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.taskId).toBe("never-mirrored");
    expect(rows[0]?.location).toBeNull();
  });
});
