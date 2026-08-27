import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ClickUpClient, RateLimiter } from "@rask/clickup-client";
import { createTestDb, tasks, users } from "@rask/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { SessionUser } from "../src/auth.ts";
import { timeRoutes } from "../src/time.ts";

/**
 * The time-tracking routes, against a stubbed ClickUp.
 *
 * Worth testing at this level rather than through the client alone, because
 * what these routes do is *orchestration*: a start is a read, a stop and a
 * start, and the order of those three is the whole feature. Get it wrong and
 * somebody's morning is split into two entries, or lost.
 *
 * `ClickUpClient` takes a `baseUrl`, so nothing here reaches ClickUp.
 */

const db = createTestDb();

const TEAM = "42";
const ME = "api-time-user";
const TASK = "api-time-task";
const OTHER_TASK = "api-time-other-task";
const LIST = "api-time-list";

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
  body: unknown;
}

/** Replays canned ClickUp responses and records what was asked for. */
function stub(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const queue = [...responses];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
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
  const pushed: Array<{ event: string; data: unknown }> = [];
  const refreshed: Array<{ taskId: string; comments?: boolean }> = [];

  const app = new Hono<{ Variables: { user: SessionUser } }>();
  app.use("*", async (c, next) => {
    c.set("user", USER);
    await next();
  });
  app.route(
    "/",
    timeRoutes({
      db,
      clientFor: async () => client,
      pushTo: (_userId, event, data) => pushed.push({ event, data }),
      refreshTask: async (_userId, taskId, options) => {
        refreshed.push({ taskId, comments: options?.comments });
      },
    }),
  );

  return { app, pushed, refreshed };
}

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

/** ClickUp's shape for a live timer: negative duration, no end. */
const RUNNING = entry({ id: "live", duration: -1756080000000, end: undefined });

beforeEach(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
  await db.delete(tasks).where(eq(tasks.id, OTHER_TASK));
  await db.delete(users).where(eq(users.id, ME));
  await db.insert(users).values({ id: ME, username: "Ada" });
  await db.insert(tasks).values({
    id: TASK,
    listId: LIST,
    name: "Write the thing",
    dateCreated: new Date(1_756_000_000_000),
  });
});

afterAll(async () => {
  await db.delete(tasks).where(eq(tasks.id, TASK));
  await db.delete(tasks).where(eq(tasks.id, OTHER_TASK));
  await db.delete(users).where(eq(users.id, ME));
});

describe("GET /timer", () => {
  test("normalises a running entry so nothing downstream sees the negative duration", async () => {
    const { client } = stub([{ body: { data: RUNNING } }]);
    const { app } = mount(client);

    const body = (await (await app.request("/timer")).json()) as {
      entry: { running: boolean; durationMs: number | null; start: number };
    };

    expect(body.entry.running).toBe(true);
    // Null rather than a negative number: a caller doing arithmetic on it would
    // render a timer that has been going since 1914.
    expect(body.entry.durationMs).toBeNull();
    expect(body.entry.start).toBe(1_756_080_000_000);
  });

  test("nothing running is an answer, not an error", async () => {
    const { client } = stub([{ body: { data: null } }]);
    const { app } = mount(client);

    const response = await app.request("/timer");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entry: null });
  });
});

describe("POST /timer", () => {
  test("stops what was running before starting the new one", async () => {
    const { client, calls } = stub([
      { body: { data: entry({ id: "live", task: { id: OTHER_TASK, name: "Something else" } }) } },
      {
        body: { data: entry({ id: "stopped", task: { id: OTHER_TASK, name: "Something else" } }) },
      },
      { body: { data: RUNNING } },
    ]);
    const { app, pushed, refreshed } = mount(client);

    const response = await app.request("/timer", {
      method: "POST",
      body: JSON.stringify({ taskId: TASK }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    // Read, stop, start — in that order. Leaving the stop to `start` would rely
    // on behaviour the vendored spec does not document.
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/v2/team/42/time_entries/current",
      "POST /api/v2/team/42/time_entries/stop",
      "POST /api/v2/team/42/time_entries/start",
    ]);

    const body = (await response.json()) as { stopped: { taskId: string } | null };
    expect(body.stopped?.taskId).toBe(OTHER_TASK);

    // Both totals moved, and neither task's `date_updated` need have.
    expect(refreshed.map((r) => r.taskId).sort()).toEqual([TASK, OTHER_TASK].sort());
    expect(pushed[0]?.event).toBe("timer");
  });

  test("starting on the task already running does nothing at all", async () => {
    // `t` is a toggle, so a double press lands here. Splitting one interval in
    // two on a stray keystroke is damage nobody notices until payroll.
    const { client, calls } = stub([{ body: { data: RUNNING } }]);
    const { app } = mount(client);

    const response = await app.request("/timer", {
      method: "POST",
      body: JSON.stringify({ taskId: TASK }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(((await response.json()) as { stopped: unknown }).stopped).toBeNull();
  });

  test("starts straight away when nothing was running", async () => {
    const { client, calls } = stub([{ body: { data: null } }, { body: { data: RUNNING } }]);
    const { app } = mount(client);

    await app.request("/timer", {
      method: "POST",
      body: JSON.stringify({ taskId: TASK }),
      headers: { "content-type": "application/json" },
    });

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1]?.body).toEqual({ tid: TASK });
  });

  test("refuses a task the outbox has not shipped yet", async () => {
    const { client, calls } = stub([]);
    const { app } = mount(client);

    const response = await app.request("/timer", {
      method: "POST",
      body: JSON.stringify({ taskId: "tmp_abc123" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(409);
    // Refused before spending a request: `tid` would 404 upstream.
    expect(calls).toHaveLength(0);
  });

  test("a ClickUp refusal reaches the user without reading as a lost session", async () => {
    // 401 is never forwarded: the browser signs itself out on one, and a bad
    // *server* token is not the user's session ending.
    const { client } = stub([{ status: 401, body: { err: "Token invalid" } }]);
    const { app } = mount(client);

    const response = await app.request("/timer", {
      method: "POST",
      body: JSON.stringify({ taskId: TASK }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(502);
  });

  test("never re-reads the conversation, which nothing here changed", async () => {
    /*
     * `refreshTask` pages comments and spends a request per thread whose count
     * moved unless told not to. An interval says nothing about the
     * conversation, and this is charged against the user's own 100/min on every
     * press of `t` — a cost regression that no other test would notice.
     */
    const { client } = stub([{ body: { data: null } }, { body: { data: RUNNING } }]);
    const { app, refreshed } = mount(client);

    await app.request("/timer", {
      method: "POST",
      body: JSON.stringify({ taskId: TASK }),
      headers: { "content-type": "application/json" },
    });

    expect(refreshed).toEqual([{ taskId: TASK, comments: false }]);
  });

  test("repairs the task it stopped even when the start then fails", async () => {
    // The interval was recorded upstream either way. Without this the stopped
    // task keeps serving yesterday's total until the next poll, which is the
    // failure the whole feature exists to avoid.
    const { client } = stub([
      { body: { data: entry({ id: "live", task: { id: OTHER_TASK, name: "Something else" } }) } },
      {
        body: { data: entry({ id: "stopped", task: { id: OTHER_TASK, name: "Something else" } }) },
      },
      { status: 400, body: { err: "Task not found" } },
    ]);
    const { app, pushed, refreshed } = mount(client);

    const response = await app.request("/timer", {
      method: "POST",
      body: JSON.stringify({ taskId: TASK }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(422);
    expect(refreshed).toEqual([{ taskId: OTHER_TASK, comments: false }]);
    // And no timer is announced, because none is running.
    expect(pushed).toEqual([]);
  });

  test("a permission refusal comes back readable", async () => {
    const { client } = stub([{ status: 403, body: { err: "Team not authorized" } }]);
    const { app } = mount(client);

    const response = await app.request("/timer", {
      method: "POST",
      body: JSON.stringify({ taskId: TASK }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(422);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("Team not authorized"),
    });
  });
});

describe("DELETE /timer", () => {
  test("stopping when nothing runs is already true, not an error", async () => {
    const { client, calls } = stub([{ body: { data: null } }]);
    const { app, pushed } = mount(client);

    const response = await app.request("/timer", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: null });
    expect(calls).toHaveLength(1);
    // The tab still hears it: its own guess may be the thing that was stale.
    expect(pushed).toEqual([{ event: "timer", data: { entry: null } }]);
  });

  test("re-reads the task it stopped", async () => {
    const { client } = stub([{ body: { data: RUNNING } }, { body: { data: entry() } }]);
    const { app, refreshed } = mount(client);

    await app.request("/timer", { method: "DELETE" });

    expect(refreshed).toEqual([{ taskId: TASK, comments: false }]);
  });
});

describe("GET /tasks/:id/time-entries", () => {
  test("names the window and leaves the assignee off, because OAuth forbids the list", async () => {
    const { client, calls } = stub([{ body: { data: [entry()] } }]);
    const { app } = mount(client);

    await app.request(`/tasks/${TASK}/time-entries`);

    const url = new URL(calls[0]?.url ?? "");
    // The task's own creation date, not 30 days ago: an entry older than the
    // default window would be missing from a 200 with no sign anything was cut.
    expect(url.searchParams.get("start_date")).toBe("1756000000000");
    // No assignee: a comma-joined member list is a 403 TIMEENTRY_059 on an
    // OAuth token, and the task-scoped call answers with everyone's entries
    // anyway — which is what this route wants.
    expect(url.searchParams.has("assignee")).toBe(false);
    expect(url.searchParams.get("task_id")).toBe(TASK);
  });

  test("answers newest first", async () => {
    const { client } = stub([
      {
        body: {
          data: [
            entry({ id: "old", start: "1756000000000" }),
            entry({ id: "new", start: "1756090000000" }),
          ],
        },
      },
    ]);
    const { app } = mount(client);

    const body = (await (await app.request(`/tasks/${TASK}/time-entries`)).json()) as {
      entries: Array<{ id: string }>;
    };
    expect(body.entries.map((e) => e.id)).toEqual(["new", "old"]);
  });

  test("a placeholder task has no entries and costs no request", async () => {
    const { client, calls } = stub([]);
    const { app } = mount(client);

    const response = await app.request("/tasks/tmp_abc123/time-entries");

    expect(await response.json()).toEqual({ entries: [] });
    expect(calls).toHaveLength(0);
  });

  test("a task the mirror never held is a 404, not an empty list", async () => {
    const { client } = stub([]);
    const { app } = mount(client);

    expect((await app.request("/tasks/nope-not-here/time-entries")).status).toBe(404);
  });
});

describe("POST /tasks/:id/time-entries", () => {
  test("sends the interval as tid + start + duration and re-reads the task", async () => {
    const { client, calls } = stub([{ body: { data: entry({ description: "yesterday" }) } }]);
    const { app, refreshed } = mount(client);

    const response = await app.request(`/tasks/${TASK}/time-entries`, {
      method: "POST",
      body: JSON.stringify({ start: 1_756_080_000_000, durationMs: 3_600_000 }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({
      tid: TASK,
      start: 1_756_080_000_000,
      duration: 3_600_000,
    });
    expect(refreshed).toEqual([{ taskId: TASK, comments: false }]);
  });

  test("refuses a zero or negative length before it costs a request", async () => {
    // ClickUp encodes "running" as a negative duration, so a manual entry that
    // stored one would come back looking live.
    const { client, calls } = stub([]);
    const { app } = mount(client);

    const response = await app.request(`/tasks/${TASK}/time-entries`, {
      method: "POST",
      body: JSON.stringify({ start: 1_756_080_000_000, durationMs: 0 }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("refuses a task the outbox has not shipped yet", async () => {
    const { client, calls } = stub([]);
    const { app } = mount(client);

    const response = await app.request("/tasks/tmp_abc123/time-entries", {
      method: "POST",
      body: JSON.stringify({ start: 1_756_080_000_000, durationMs: 3_600_000 }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  test("a task the mirror never held is a 404, before the body is even read", async () => {
    // The path id names which task the server then writes into the shared
    // mirror, so it is checked against the mirror, not taken on trust.
    const { client, calls } = stub([]);
    const { app } = mount(client);

    const response = await app.request("/tasks/nope-not-here/time-entries", {
      method: "POST",
      body: JSON.stringify({ start: 1_756_080_000_000, durationMs: 3_600_000 }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("PATCH /time-entries/:id", () => {
  test("re-reads the task whose total just moved", async () => {
    const { client } = stub([{ body: { data: entry({ description: "drafting" }) } }]);
    const { app, refreshed } = mount(client);

    const response = await app.request("/time-entries/e1", {
      method: "PATCH",
      body: JSON.stringify({ description: "drafting" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(refreshed).toEqual([{ taskId: TASK, comments: false }]);
  });

  test("refuses an end that precedes its start", async () => {
    // A negative duration is how ClickUp encodes "running". Storing one by
    // arithmetic would make a finished entry come back looking live.
    const { client, calls } = stub([]);
    const { app } = mount(client);

    const response = await app.request("/time-entries/e1", {
      method: "PATCH",
      body: JSON.stringify({ span: { start: 1_756_083_600_000, end: 1_756_080_000_000 } }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("refuses a patch that changes nothing", async () => {
    const { client, calls } = stub([]);
    const { app } = mount(client);

    const response = await app.request("/time-entries/e1", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("DELETE /time-entries/:id", () => {
  test("re-reads the task the caller names", async () => {
    const { client, calls } = stub([{ body: {} }]);
    const { app, refreshed } = mount(client);

    const response = await app.request(`/time-entries/e1?taskId=${TASK}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(calls[0]?.method).toBe("DELETE");
    expect(refreshed).toEqual([{ taskId: TASK, comments: false }]);
  });

  test("ignores a task id the mirror has never held", async () => {
    /*
     * The id arrives in a query string. Unchecked, it is a caller choosing
     * which task the server fetches from ClickUp and writes into the mirror
     * everybody reads.
     */
    const { client } = stub([{ body: {} }]);
    const { app, refreshed } = mount(client);

    const response = await app.request("/time-entries/e1?taskId=not-in-the-mirror", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(refreshed).toEqual([]);
  });

  test("still deletes when no task is named", async () => {
    const { client } = stub([{ body: {} }]);
    const { app, refreshed } = mount(client);

    expect((await app.request("/time-entries/e1", { method: "DELETE" })).status).toBe(200);
    expect(refreshed).toEqual([]);
  });
});
