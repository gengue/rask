import type { ClickUpClient, ClickUpTimeEntry } from "@rask/clickup-client";
import { ClickUpError, isTimeEntryRunning } from "@rask/clickup-client";
import { isPlaceholder } from "@rask/clickup-client/vocabulary";
import { type Db, tasks } from "@rask/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "./auth.ts";
import { NOT_YET } from "./writes.ts";

/**
 * Time tracking, read and written straight through to ClickUp.
 *
 * The one corner of Rask that does not answer from the mirror, and the only
 * mirrored trace it leaves is `tasks.time_spent` — which rides free on the task
 * payload every sync already reads.
 *
 * Two reasons it is shaped this way.
 *
 * The running timer is one row per user that changes only when that user acts.
 * Mirroring it would cost a table, a worker loop polling `GET .../current` per
 * signed-in person, and a reconcile path to keep that single row honest. The
 * same trade already decided `GET /spaces/:id/tags`, which is not mirrored for
 * exactly this reason.
 *
 * The writes cannot use the outbox. `POST /time_entries/start` is stamped with
 * ClickUp's own clock at the moment it arrives, so a queued start that drains
 * three minutes late records the wrong interval and says nothing; and the
 * outbox's retry plus `STALE_SENDING` reclaim would happily start the same
 * timer twice. So these wait for ClickUp, as the attachment upload does.
 */

type Env = { Variables: { user: SessionUser } };

export interface TimeDeps {
  db: Db;
  clientFor: (userId: string) => Promise<ClickUpClient | null>;
  pushTo: (userId: string, event: string, data: unknown) => void;
  refreshTask: (userId: string, taskId: string, options?: { comments?: boolean }) => Promise<void>;
}

/** What the browser sees. `running` is resolved here so nothing downstream has
 * to know that ClickUp signals it with a negative duration. */
export interface TimeEntryDto {
  id: string;
  taskId: string | null;
  taskName: string | null;
  user: {
    id: string;
    username: string | null;
    initials: string | null;
    color: string | null;
    avatar: string | null;
  } | null;
  /** Epoch milliseconds. The live counter is `now - start`; see `running`. */
  start: number | null;
  end: number | null;
  /** Null while running, because the number ClickUp sends there is negative. */
  durationMs: number | null;
  running: boolean;
  description: string;
  billable: boolean;
}

function toDto(entry: ClickUpTimeEntry): TimeEntryDto {
  const running = isTimeEntryRunning(entry);
  return {
    id: entry.id,
    taskId: entry.task?.id ?? null,
    taskName: entry.task?.name ?? null,
    user: entry.user
      ? {
          id: String(entry.user.id),
          username: entry.user.username ?? null,
          initials: entry.user.initials ?? null,
          color: entry.user.color ?? null,
          avatar: entry.user.profilePicture ?? null,
        }
      : null,
    start: entry.start?.getTime() ?? null,
    end: entry.end?.getTime() ?? null,
    durationMs: running ? null : (entry.duration ?? null),
    running,
    description: entry.description ?? "",
    billable: entry.billable ?? false,
  };
}

/**
 * ClickUp's refusals reach the user; its outages do not pretend to be one.
 *
 * 4xx is an answer the person should read — "you cannot edit someone else's
 * entry" is the common one, since Rask has no way to know who is an admin.
 * It is deliberately not forwarded verbatim: a 401 from ClickUp means *our*
 * token is bad, and the browser treats a 401 as its own session ending and
 * signs the user out of Rask.
 */
function upstream(error: unknown): { status: 422 | 502; error: string } {
  if (error instanceof ClickUpError) {
    const status = error.status >= 400 && error.status < 500 && error.status !== 401 ? 422 : 502;
    return { status, error: error.message };
  }
  return { status: 502, error: error instanceof Error ? error.message : "ClickUp call failed" };
}

const startInput = z.object({ taskId: z.string().min(1) });

/**
 * A manual entry is an interval that already happened, so unlike the running
 * timer nothing here depends on ClickUp's clock — the caller names the moment.
 * It still writes straight through rather than into the outbox, for the outbox's
 * other reason: a retry that lands twice records somebody's afternoon twice.
 */
const manualEntryInput = z.object({
  start: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  description: z.string().max(2000).optional(),
});

/**
 * `start` and `end` are one field, not two.
 *
 * "When providing `start`, you must also provide `end`" is the endpoint's own
 * rule, so the pair is the only shape that can be sent and the only shape that
 * is accepted here. `end` before `start` would store a negative duration, which
 * is how ClickUp encodes "still running" — refusing it is cheaper than
 * explaining the entry that came back looking live.
 */
const entryPatchInput = z
  .object({
    description: z.string().max(2000).optional(),
    billable: z.boolean().optional(),
    span: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
  })
  .refine((v) => !v.span || v.span.end > v.span.start, {
    message: "the end of an entry must come after its start",
  })
  .refine((v) => v.description !== undefined || v.billable !== undefined || v.span !== undefined, {
    message: "nothing to change",
  });

export function timeRoutes(deps: TimeDeps) {
  const { db, clientFor, pushTo, refreshTask } = deps;
  const app = new Hono<Env>();

  /** Whoever is signed in, plus their team. Every endpoint here is team-scoped. */
  const who = (c: { get: (k: "user") => SessionUser }) => c.get("user");

  /**
   * Re-reads the tasks whose tracked total just moved.
   *
   * Not forced. The upsert guard in `ingestTasks` ORs `time_spent` in
   * alongside `date_updated` precisely so a changed total lands on its own, and
   * forcing on top of that would bump `synced_at` on rows nothing changed on —
   * fanning each one out over every open SSE connection for nothing.
   *
   * Comments are skipped, for the reason the attachment upload gives: an
   * interval says nothing about the conversation, and refreshing it costs a
   * page of comments plus a request per thread whose count moved. That is a
   * real bill against this person's own 100/min, charged on every press of `t`.
   */
  const repair = (userId: string, taskIds: Iterable<string>) =>
    Promise.all([...taskIds].map((id) => refreshTask(userId, id, { comments: false })));

  /** Whether the mirror holds this task. Guards an id that arrived from a caller. */
  const mirrored = async (taskId: string): Promise<boolean> => {
    if (isPlaceholder(taskId)) return false;
    const [row] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    return row !== undefined;
  };

  app.get("/timer", async (c) => {
    const user = who(c);
    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    try {
      const entry = await client.getRunningTimeEntry(user.teamId, user.id);
      return c.json({ entry: entry ? toDto(entry) : null });
    } catch (error) {
      const { status, error: message } = upstream(error);
      return c.json({ error: message }, status);
    }
  });

  /**
   * Starts a timer, stopping whatever was running first.
   *
   * The stop is explicit rather than left to `start`: the vendored spec
   * documents only a 200 for that endpoint and says nothing about what happens
   * when a timer is already live, and a feature that loses somebody's morning
   * is not the place to find out by experiment.
   *
   * Starting on the task that is already running is a no-op, not a stop and a
   * restart. `t` is a toggle in the UI, so a double press arrives here, and
   * splitting one interval into two on a stray keystroke is the kind of damage
   * nobody notices until they read their timesheet.
   */
  app.post("/timer", async (c) => {
    const user = who(c);
    const body = startInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

    const { taskId } = body.data;
    // Nothing upstream to track against yet: `tid` would 404 at ClickUp.
    if (isPlaceholder(taskId)) return c.json({ error: NOT_YET }, 409);

    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    /*
     * Collected as we go, not at the end, because a stop that succeeds and a
     * start that then fails still has to leave the mirror correct. The interval
     * really was recorded upstream; a task left showing yesterday's total until
     * the next poll is the exact failure this feature was written to avoid.
     */
    const touched = new Set<string>();
    let started: ClickUpTimeEntry | null = null;
    let stopped: ClickUpTimeEntry | null = null;
    let failure: unknown = null;

    try {
      const current = await client.getRunningTimeEntry(user.teamId, user.id);
      // Nothing moved, so there is nothing to repair and nothing to announce.
      if (current?.task?.id === taskId) {
        return c.json({ started: toDto(current), stopped: null });
      }

      if (current) {
        /*
         * A failure here is not fatal. The only way to get one is for the timer
         * to have been stopped between the read above and this call — from
         * ClickUp's own app, or another Rask tab — and in that case the thing
         * we wanted has already happened.
         */
        stopped = await client.stopTimeEntry(user.teamId).catch(() => null);
        if (stopped?.task?.id) touched.add(stopped.task.id);
      }

      started = await client.startTimeEntry(user.teamId, { taskId });
      touched.add(taskId);
    } catch (error) {
      failure = error;
    }

    await repair(user.id, touched);

    if (!started) {
      const { status, error: message } = upstream(failure);
      return c.json({ error: message }, status);
    }

    const dto = toDto(started);
    pushTo(user.id, "timer", { entry: dto });
    return c.json({ started: dto, stopped: stopped ? toDto(stopped) : null });
  });

  /** Stops the running timer. Answering 200 with `null` when there was none:
   * the caller asked for a state, not for an event, and it is already true. */
  app.delete("/timer", async (c) => {
    const user = who(c);
    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    try {
      const current = await client.getRunningTimeEntry(user.teamId, user.id);
      if (!current) {
        pushTo(user.id, "timer", { entry: null });
        return c.json({ stopped: null });
      }

      const stopped = await client.stopTimeEntry(user.teamId);
      if (stopped.task?.id) await repair(user.id, [stopped.task.id]);

      pushTo(user.id, "timer", { entry: null });
      return c.json({ stopped: toDto(stopped) });
    } catch (error) {
      const { status, error: message } = upstream(error);
      return c.json({ error: message }, status);
    }
  });

  /**
   * Every entry on one task, by everyone.
   *
   * Both query parameters are spelled out because both of ClickUp's defaults
   * are wrong here and neither wrong answer looks wrong: without a date window
   * it answers with the last 30 days, and without `assignee` it answers with
   * the caller's own entries alone. A task three people tracked last quarter
   * would come back empty, with a 200.
   */
  app.get("/tasks/:id/time-entries", async (c) => {
    const user = who(c);
    const taskId = c.req.param("id");
    // A task ClickUp has never seen has no entries, and asking would 404.
    if (isPlaceholder(taskId)) return c.json({ entries: [] });

    const [task] = await db
      .select({ dateCreated: tasks.dateCreated })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!task) return c.json({ error: "not found" }, 404);

    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    /*
     * No assignee list is assembled here. The endpoint answers a task-scoped
     * call with every entry on the task — which is what this route wants —
     * and on an OAuth token an explicit comma-joined list is a 403
     * TIMEENTRY_059. See `getTimeEntries`.
     */
    try {
      const entries = await client.getTimeEntries(user.teamId, {
        taskId,
        // An entry cannot predate the task it is on, and 0 would ask ClickUp to
        // scan from 1970 for every panel that opens.
        startDate: task.dateCreated?.getTime() ?? 0,
        endDate: Date.now(),
      });

      return c.json({
        entries: entries.map(toDto).sort((a, b) => (b.start ?? 0) - (a.start ?? 0)),
      });
    } catch (error) {
      const { status, error: message } = upstream(error);
      return c.json({ error: message }, status);
    }
  });

  /**
   * Logs time by hand, the way ClickUp's own "add manual time" does.
   *
   * Checked against the mirror for the same reason the delete's `taskId` is:
   * the id names which task the server then re-reads from ClickUp and writes
   * into the mirror everybody shares, so an unchecked one must not get to pick.
   */
  app.post("/tasks/:id/time-entries", async (c) => {
    const user = who(c);
    const taskId = c.req.param("id");
    if (isPlaceholder(taskId)) return c.json({ error: NOT_YET }, 409);
    if (!(await mirrored(taskId))) return c.json({ error: "not found" }, 404);

    const body = manualEntryInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    try {
      const created = await client.createTimeEntry(user.teamId, { taskId, ...body.data });
      await repair(user.id, [taskId]);
      return c.json({ entry: toDto(created) });
    } catch (error) {
      const { status, error: message } = upstream(error);
      return c.json({ error: message }, status);
    }
  });

  app.patch("/time-entries/:id", async (c) => {
    const user = who(c);
    const body = entryPatchInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);

    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    try {
      const updated = await client.updateTimeEntry(user.teamId, c.req.param("id"), body.data);
      if (updated.task?.id) await repair(user.id, [updated.task.id]);
      return c.json({ entry: toDto(updated) });
    } catch (error) {
      const { status, error: message } = upstream(error);
      return c.json({ error: message }, status);
    }
  });

  /**
   * Deletes an entry. ClickUp has no undo, so the confirmation lives in the UI.
   *
   * The delete answers with nothing that names a task, so the browser — already
   * rendering the list on one — says which to re-read. Checked against the
   * mirror rather than taken on trust: it arrives in a query string, and an
   * unchecked id here lets a caller pick which task the server fetches from
   * ClickUp and writes into the mirror everybody reads.
   */
  app.delete("/time-entries/:id", async (c) => {
    const user = who(c);
    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    try {
      await client.deleteTimeEntry(user.teamId, c.req.param("id"));
      const taskId = c.req.query("taskId");
      if (taskId && (await mirrored(taskId))) await repair(user.id, [taskId]);
      return c.json({ ok: true });
    } catch (error) {
      const { status, error: message } = upstream(error);
      return c.json({ error: message }, status);
    }
  });

  return app;
}
