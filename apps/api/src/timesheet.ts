import type { ClickUpClient, ClickUpTimeEntry } from "@rask/clickup-client";
import { type Db, folders, lists, spaces, tasks } from "@rask/schema";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { SessionUser } from "./auth.ts";

/**
 * The week grid: one row per task tracked against, one column per day.
 *
 * Served straight from ClickUp rather than mirrored, for the reason the running
 * timer is not mirrored either: an entry is written by the person who worked
 * it, so the only rows that ever change are that person's, and a table plus a
 * reconcile loop is a lot of machinery to keep honest what one call answers
 * anyway. The window boundary is the week's own Sunday 00:00 in the viewer's
 * timezone, carried up as an offset so "my week" means what their calendar
 * says — this server was never told which zone that is.
 */

type Env = { Variables: { user: SessionUser } };

export interface TimesheetDeps {
  db: Db;
  clientFor: (userId: string) => Promise<ClickUpClient | null>;
  /**
   * Re-reads one task from ClickUp into the mirror. Optional in the type but
   * always wired by index.ts; tests may leave it out to stay offline.
   *
   * The timesheet reads entries first and asks the mirror second, so a task
   * whose list was never opened has no row yet — ClickUp tracked it (it owns
   * the entry) while Rask never had a reason to hold it. Refreshing those few
   * repairs the gap at its source instead of shipping rows that read "(task
   * not found)", and the next week's sheet answers from an indexed IN.
   */
  repairTask?: (userId: string, taskId: string) => Promise<void>;
}

/** One task × one day. Null where nothing was tracked. */
export interface DayCellDto {
  /** Milliseconds tracked that day, on that task. */
  durationMs: number;
  /** True when one of the day's intervals was still open at fetch time. */
  running: boolean;
}

export interface TimesheetRowDto {
  taskId: string;
  taskName: string;
  status: string | null;
  statusColor: string | null;
  statusType: string | null;
  /** Space / Folder / List, joined — what the row's path line reads. */
  location: string | null;
  days: Array<DayCellDto | null>;
  totalMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Sunday 00:00 of the week containing `now`, in the zone `offsetMinutes`
 * names — the browser's `-new Date().getTimezoneOffset()`, not this server's.
 *
 * The shift moves the instant into local wall time so the UTC getters read as
 * the viewer's calendar, finds that week's Sunday, and shifts back with the
 * same offset, returning an epoch again. A Bogotá Saturday-evening entry lands
 * in the column of the evening its owner lived.
 */
function weekStart(now: number, offsetMinutes: number): number {
  const local = new Date(now - offsetMinutes * 60_000);
  const daysSinceSunday = local.getUTCDay();
  const midnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - daysSinceSunday,
  );
  return midnight + offsetMinutes * 60_000;
}

/**
 * What `/api/time/timesheet/week` answers.
 *
 * Every entry lands in a cell keyed by task × local day; durations sum, and
 * the running entry contributes its elapsed slice to today's cell while
 * marking both cell and row. Tasks are enriched from the mirror — status and
 * the Space/Folder/List path — because ClickUp's payload carries neither, and
 * the screenshot's rows read exactly because of those two things.
 */
export function timesheetRoutes(deps: TimesheetDeps) {
  const { db, clientFor } = deps;
  const app = new Hono<Env>();

  app.get("/week", async (c) => {
    const user = c.get("user");
    const client = await clientFor(user.id);
    if (!client) return c.json({ error: "no ClickUp token" }, 409);

    // Absent or malformed, UTC — an explicitly-UTC sheet beats a wrong guess.
    const raw = Number(c.req.query("tz"));
    const tz = Number.isFinite(raw) ? Math.trunc(raw) : 0;

    const now = Date.now();
    const start = weekStart(now, tz);
    const end = start + WEEK_MS;

    let entries: ClickUpTimeEntry[];
    try {
      entries = await client.getTimeEntries(user.teamId, {
        // Single assignee, never a list — see getTimeEntries for why lists are
        // forbidden. Explicit even though the endpoint would answer for the
        // owner anyway: intent on the wire over accident that happens to hold.
        assignee: user.id,
        startDate: start,
        endDate: end,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "ClickUp call failed";
      return c.json({ error: message }, 502);
    }

    interface Cell {
      durationMs: number;
      running: boolean;
    }
    const cells = new Map<string, Cell>();
    const taskIds = new Set<string>();

    for (const entry of entries) {
      const taskId = entry.task?.id;
      const startMs = entry.start?.getTime();
      if (!taskId || startMs === undefined) continue;
      taskIds.add(taskId);

      const dayIndex = Math.floor((startMs - start) / DAY_MS);
      if (dayIndex < 0 || dayIndex > 6) continue;

      const running = (entry.duration ?? 0) < 0;
      const duration = running ? Math.max(0, now - startMs) : (entry.duration ?? 0);

      const cellKey = `${taskId}|${dayIndex}`;
      const cell = cells.get(cellKey) ?? { durationMs: 0, running: false };
      cell.durationMs += duration;
      cell.running = cell.running || running;
      cells.set(cellKey, cell);
    }

    /*
     * First pass against the mirror: status, name, and the Space/Folder/List
     * line. A task whose list nobody ever opened is not here — ClickUp tracks
     * hours against it while Rask never had a reason to hold it.
     */
    const context = new Map<
      string,
      {
        name: string | null;
        status: string | null;
        statusColor: string | null;
        statusType: string | null;
        location: string | null;
      }
    >();
    const missing: string[] = [];
    if (taskIds.size > 0) {
      const mirrored = await db
        .select({
          id: tasks.id,
          name: tasks.name,
          status: tasks.status,
          statusColor: tasks.statusColor,
          statusType: tasks.statusType,
          listName: lists.name,
          folderName: folders.name,
          spaceName: spaces.name,
        })
        .from(tasks)
        .leftJoin(lists, eq(lists.id, tasks.listId))
        .leftJoin(folders, eq(folders.id, tasks.folderId))
        .leftJoin(spaces, eq(spaces.id, tasks.spaceId))
        .where(inArray(tasks.id, [...taskIds]));

      for (const row of mirrored) {
        const parts = [row.spaceName, row.folderName, row.listName].filter(Boolean);
        context.set(row.id, {
          name: row.name,
          status: row.status,
          statusColor: row.statusColor,
          statusType: row.statusType,
          location: parts.length > 0 ? parts.join(" / ") : null,
        });
      }
      for (const id of taskIds) if (!context.has(id)) missing.push(id);
    }

    /*
     * Second pass, only when something was missing. Each repair is one request
     * plus an ingest into the shared mirror, and after it these rows carry a
     * real name — but the answer goes out with what was already held, because
     * whoever asked came for numbers, not to wait on a walk of another list.
     */
    if (missing.length > 0) {
      await Promise.all(missing.map((id) => deps.repairTask?.(user.id, id).catch(() => undefined)));
    }

    const rows: TimesheetRowDto[] = [];
    for (const taskId of taskIds) {
      const info = context.get(taskId);
      const days: Array<DayCellDto | null> = Array.from({ length: 7 }, () => null);
      let totalMs = 0;

      for (let day = 0; day < 7; day++) {
        const cell = cells.get(`${taskId}|${day}`);
        if (!cell) continue;
        days[day] = { durationMs: cell.durationMs, running: cell.running };
        totalMs += cell.durationMs;
      }

      rows.push({
        taskId,
        // By the time this runs a repair may have landed, but reading it would
        // mean re-querying the mirror mid-request; the upstream name rides in
        // the entry payload, so use that and leave the row complete anyway.
        taskName: info?.name ?? "…",
        status: info?.status ?? null,
        statusColor: info?.statusColor ?? null,
        statusType: info?.statusType ?? null,
        location: info?.location ?? null,
        days,
        totalMs,
      });
    }

    // Heaviest first: the sheet is read top-down for where the week went.
    rows.sort((a, b) => b.totalMs - a.totalMs);

    return c.json({ start, end, now, rows });
  });

  return app;
}
