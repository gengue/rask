import { type Db, outbox } from "@rask/schema";
import { and, eq, gt } from "drizzle-orm";
import { listTasks, type TaskRow } from "./queries.ts";

/**
 * Fans changed tasks out to connected browsers.
 *
 * ponytail: one poller for the whole process, watching `tasks.synced_at`
 * against its indexed column. LISTEN/NOTIFY would shave the polling interval
 * off the latency, but it needs a dedicated connection per process and gives
 * up ordering guarantees on reconnect. Swap it in if a second of lag ever
 * shows. Nothing else has to change: subscribers already take whole rows.
 *
 * Because the worker only bumps synced_at when ClickUp actually changed
 * something, an idle workspace produces one cheap indexed query per second and
 * zero traffic.
 */
export interface WriteFailure {
  userId: string;
  op: string;
  entityId: string | null;
  error: string;
}

export class ChangeFeed {
  private readonly subscribers = new Set<(tasks: TaskRow[]) => void>();
  private readonly failureHandlers = new Set<(failure: WriteFailure) => void>();
  private since = new Date();
  private failuresSince = new Date();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly intervalMs = 1000,
  ) {}

  subscribe(onChange: (tasks: TaskRow[]) => void): () => void {
    this.subscribers.add(onChange);
    if (this.subscribers.size === 1) this.start();
    return () => {
      this.subscribers.delete(onChange);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /**
   * Notified when the worker gives up on a write.
   *
   * The mirror has already been repaired from ClickUp by then, so the user has
   * watched their change snap back. Without this they get no explanation.
   */
  onFailure(handler: (failure: WriteFailure) => void): () => void {
    this.failureHandlers.add(handler);
    if (this.subscribers.size === 0 && this.failureHandlers.size === 1) this.start();
    return () => {
      this.failureHandlers.delete(handler);
      if (this.subscribers.size === 0 && this.failureHandlers.size === 0) this.stop();
    };
  }

  private start(): void {
    // Start from now, not from whenever the last subscriber left. A client that
    // reconnects refetches its view anyway.
    this.since = new Date();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const cutoff = new Date();
    try {
      const changed = await listTasks(this.db, {
        syncedAfter: this.since,
        includeClosed: true,
        limit: 200,
      });
      // Advance only after the query succeeds, so a database blip replays
      // rather than drops the window.
      this.since = cutoff;
      if (changed.length > 0) {
        for (const notify of this.subscribers) notify(changed);
      }
    } catch (error) {
      console.error("[changes]", error instanceof Error ? error.message : error);
    }

    await this.pollFailures();
  }

  private async pollFailures(): Promise<void> {
    if (this.failureHandlers.size === 0) return;
    const cutoff = new Date();
    try {
      const failed = await this.db
        .select({
          userId: outbox.userId,
          op: outbox.op,
          entityId: outbox.entityId,
          error: outbox.lastError,
        })
        .from(outbox)
        .where(and(eq(outbox.status, "failed"), gt(outbox.updatedAt, this.failuresSince)))
        .limit(20);

      this.failuresSince = cutoff;

      for (const row of failed) {
        for (const notify of this.failureHandlers) {
          notify({ ...row, error: row.error ?? "ClickUp rejected the change" });
        }
      }
    } catch (error) {
      console.error("[changes:failures]", error instanceof Error ? error.message : error);
    }
  }
}
