import { describe, expect, test } from "bun:test";
import { ClickUpClient } from "../src/client.ts";
import { RateLimiter } from "../src/rate-limit.ts";
import { clickUpTimeEntry, isTimeEntryRunning } from "../src/schemas.ts";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function makeClient(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const queue = [...responses];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request: ${input}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const client = new ClickUpClient({
    token: "pk_123",
    fetch: fetchImpl,
    limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
    sleep: async () => {},
  });
  return { client, calls };
}

/** A stopped entry, in the shape the list endpoint answers with: strings. */
const stopped = {
  id: "3141",
  task: { id: "9hz", name: "Write the thing", status: { status: "in progress" } },
  wid: "42",
  user: { id: 7, username: "Ada", initials: "A" },
  billable: false,
  start: "1756080000000",
  end: "1756083600000",
  duration: "3600000",
  description: "drafting",
  tags: [{ name: "billable-ish", tag_fg: "#fff", tag_bg: "#000" }],
};

/** A live one. ClickUp signals it with a negative duration and omits `end`. */
const live = { ...stopped, id: "3142", end: undefined, duration: -1756080000000 };

describe("time entry schema", () => {
  test("reads the decimal string the list endpoint sends", () => {
    const parsed = clickUpTimeEntry.parse(stopped);
    expect(parsed.duration).toBe(3_600_000);
    expect(parsed.start?.getTime()).toBe(1_756_080_000_000);
    expect(parsed.end?.getTime()).toBe(1_756_083_600_000);
  });

  test("reads the integer the create endpoint sends", () => {
    const parsed = clickUpTimeEntry.parse({ ...stopped, duration: 3_600_000 });
    expect(parsed.duration).toBe(3_600_000);
  });

  test("survives an entry with no task, which the higher plans allow", () => {
    const parsed = clickUpTimeEntry.parse({ ...stopped, task: undefined });
    expect(parsed.task ?? null).toBeNull();
  });

  test("a negative duration is a running timer, not a finished one", () => {
    expect(isTimeEntryRunning(clickUpTimeEntry.parse(live))).toBe(true);
    expect(isTimeEntryRunning(clickUpTimeEntry.parse(stopped))).toBe(false);
  });

  test("a zero-length entry is not running", () => {
    expect(isTimeEntryRunning(clickUpTimeEntry.parse({ ...stopped, duration: 0 }))).toBe(false);
  });
});

describe("updateTimeEntry", () => {
  /*
   * The one that matters. `tags` is a required field on this endpoint, and
   * every shape other than an empty array under `tag_action: "add"` either
   * fails the request or silently replaces the entry's tags with nothing.
   */
  test("always sends the tag no-op, even when only the note changes", async () => {
    const { client, calls } = makeClient([{ body: { data: stopped } }]);
    await client.updateTimeEntry("42", "3141", { description: "redrafting" });

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toMatchObject({
      tags: [],
      tag_action: "add",
      description: "redrafting",
    });
  });

  test("sends start and end together, never one alone", async () => {
    const { client, calls } = makeClient([{ body: { data: stopped } }]);
    await client.updateTimeEntry("42", "3141", {
      span: { start: 1_756_080_000_000, end: 1_756_085_400_000 },
    });

    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.start).toBe(1_756_080_000_000);
    expect(body.end).toBe(1_756_085_400_000);
    expect(body.duration).toBe(5_400_000);
  });

  test("leaves out what the caller did not ask to change", async () => {
    const { client, calls } = makeClient([{ body: { data: stopped } }]);
    await client.updateTimeEntry("42", "3141", { billable: true });

    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.billable).toBe(true);
    expect("description" in body).toBe(false);
    expect("start" in body).toBe(false);
  });
});

describe("getTimeEntries", () => {
  /*
   * No `assignee` filter, verified against ClickUp on 2026-08-27: with an
   * OAuth token, two or more comma-joined ids are answered with 403
   * TIMEENTRY_059 "You have no access", while a task-scoped call without the
   * parameter returns every entry on the task — which is what Rask's panel
   * asks for in the first place. (A single id, or a personal key, accepts the
   * parameter; that is how the assumption survived as long as it did.)
   */
  test("scopes to the task and the date window, letting everyone's entries through", async () => {
    const { client, calls } = makeClient([{ body: { data: [stopped] } }]);
    await client.getTimeEntries("42", {
      taskId: "9hz",
      startDate: 1_700_000_000_000,
      endDate: 1_756_083_600_000,
    });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("task_id")).toBe("9hz");
    expect(url.searchParams.has("assignee")).toBe(false);
    expect(url.searchParams.get("start_date")).toBe("1700000000000");
    expect(url.searchParams.get("end_date")).toBe("1756083600000");
  });

  test("a single assignee rides along, scopes the answer to that person", async () => {
    const { client, calls } = makeClient([{ body: { data: [stopped] } }]);
    await client.getTimeEntries("42", {
      assignee: "7",
      startDate: 1_700_000_000_000,
      endDate: 1_756_083_600_000,
    });

    const url = new URL(calls[0]?.url ?? "");
    // Single id, not the comma-joined list: one person across every task is
    // what the timesheet week asks for, and a list is a 403 on OAuth.
    expect(url.searchParams.get("assignee")).toBe("7");
    expect(url.searchParams.has("task_id")).toBe(false);
    expect(url.searchParams.get("start_date")).toBe("1700000000000");
  });

  test("an empty data array is an answer, not a crash", async () => {
    const { client } = makeClient([{ body: { data: null } }]);
    const entries = await client.getTimeEntries("42", {
      taskId: "9hz",
      startDate: 0,
      endDate: 1,
    });
    expect(entries).toEqual([]);
  });
});

describe("the running timer", () => {
  /*
   * `assignee` stays off this endpoint's query, verified against ClickUp on
   * 2026-08-27: with an OAuth token the parameter is answered with
   * 403 TEAMM_002 "You have no an access" even when it names the token's own
   * owner. Without it the endpoint answers for the owner — which is the one
   * person Rask ever asks about here. (A personal key accepts the parameter,
   * which is how the two stayed confused for as long as they did.)
   */
  test("asks for the token's own timer, without naming an assignee", async () => {
    const { client, calls } = makeClient([{ body: { data: live } }]);
    const entry = await client.getRunningTimeEntry("42", "7");

    expect(calls[0]?.url).not.toContain("assignee");
    expect(entry && isTimeEntryRunning(entry)).toBe(true);
  });

  test("null data means nothing is running", async () => {
    const { client } = makeClient([{ body: { data: null } }]);
    expect(await client.getRunningTimeEntry("42", "7")).toBeNull();
  });

  test("start names the task in `tid`", async () => {
    const { client, calls } = makeClient([{ body: { data: live } }]);
    await client.startTimeEntry("42", { taskId: "9hz" });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v2/team/42/time_entries/start");
    expect(calls[0]?.body).toEqual({ tid: "9hz" });
  });

  test("stop sends no body and answers with the finished interval", async () => {
    const { client, calls } = makeClient([{ body: { data: stopped } }]);
    const entry = await client.stopTimeEntry("42");

    expect(calls[0]?.url).toContain("/v2/team/42/time_entries/stop");
    expect(calls[0]?.body).toBeUndefined();
    expect(entry.duration).toBe(3_600_000);
  });
});
