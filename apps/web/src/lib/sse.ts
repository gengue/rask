import type { Task, TaskDetail } from "./api.ts";
import { merge } from "./store.ts";

/**
 * Server-sent events from the API.
 *
 * `tasks` carries whatever the mirror changed workspace-wide; `task` is a
 * single refreshed detail addressed to this user. EventSource reconnects on its
 * own, and because both payloads are whole rows a missed frame is corrected by
 * the next one rather than leaving the client subtly wrong.
 */
export function connect(handlers: { onDetail?: (task: TaskDetail) => void } = {}): () => void {
  const source = new EventSource("/api/events");

  source.addEventListener("tasks", (event) => {
    merge(JSON.parse((event as MessageEvent<string>).data) as Task[]);
  });

  source.addEventListener("task", (event) => {
    const detail = JSON.parse((event as MessageEvent<string>).data) as TaskDetail;
    merge([detail]);
    handlers.onDetail?.(detail);
  });

  return () => source.close();
}
