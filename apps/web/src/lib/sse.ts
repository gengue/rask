import { createSignal } from "solid-js";
import type { Task, TaskDetail } from "./api.ts";
import { merge } from "./store.ts";
import { pushToast } from "./toast.ts";

/**
 * Whether the change feed is connected.
 *
 * EventSource reconnects silently, so with the API down a user reads a stale
 * mirror with no signal at all. For a client whose whole premise is "this is a
 * mirror of ClickUp", saying so is the cheapest trust available.
 */
export const [connected, setConnected] = createSignal(false);

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

  source.addEventListener("open", () => setConnected(true));
  source.addEventListener("error", () => setConnected(source.readyState === EventSource.OPEN));
  source.addEventListener("ready", () => setConnected(true));

  source.addEventListener("tasks", (event) => {
    merge(JSON.parse((event as MessageEvent<string>).data) as Task[]);
  });

  source.addEventListener("task", (event) => {
    const detail = JSON.parse((event as MessageEvent<string>).data) as TaskDetail;
    merge([detail]);
    handlers.onDetail?.(detail);
  });

  source.addEventListener("write-failed", (event) => {
    const failure = JSON.parse((event as MessageEvent<string>).data) as {
      op: string;
      error: string;
    };
    pushToast({
      tone: "error",
      title: `ClickUp rejected your ${FAILURE_LABELS[failure.op] ?? "change"}`,
      detail: failure.error,
    });
  });

  return () => {
    setConnected(false);
    source.close();
  };
}

const FAILURE_LABELS: Record<string, string> = {
  update_task: "edit",
  create_task: "new task",
  create_comment: "comment",
  set_custom_field: "field change",
};
