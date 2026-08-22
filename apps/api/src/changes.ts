import type { Db } from "@rask/schema";
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
export class ChangeFeed {
  private readonly subscribers = new Set<(tasks: TaskRow[]) => void>();
  private since = new Date();
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
      if (changed.length === 0) return;
      for (const notify of this.subscribers) notify(changed);
    } catch (error) {
      console.error("[changes]", error instanceof Error ? error.message : error);
    }
  }
}
