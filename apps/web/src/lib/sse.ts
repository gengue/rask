import { createSignal } from "solid-js";
import { type Task, type TaskDetail, type TimeEntry, taskHalf } from "./api.ts";
import { merge, tasks } from "./store.ts";
import { setRunningTimer } from "./timer.ts";
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
 * The last task detail the server pushed at us.
 *
 * The API refreshes an open task from ClickUp in the background and sends the
 * result here, which is the only way newly fetched comments reach a panel that
 * is already on screen. A signal rather than a callback so the detail panel can
 * pick it up without the shell having to thread a handler through.
 */
const [pushedDetail, setPushedDetail] = createSignal<TaskDetail | null>(null);

export { pushedDetail };

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
    /*
     * Only the Task half goes into the collection — see `taskHalf` for why a
     * whole detail in there means the list rebuilds on every push. The panel
     * still gets everything, through `pushedDetail` below.
     *
     * `customValues` is kept from the row already here: a detail never carries
     * that key, list rows always do, and a row stripped of it both breaks the
     * dedupe and fails the Custom Field clause its view is filtered on —
     * which would drop the open task from the list it is being read in.
     */
    const row = taskHalf(detail);
    const prev = tasks.get(detail.id);
    if (prev && "customValues" in prev) row.customValues = prev.customValues;
    merge([row]);
    setPushedDetail(detail);
    handlers.onDetail?.(detail);
  });

  /*
   * The timer this person has running, pushed by the API after any start or
   * stop. It is how a second tab — or the same browser after the phone started
   * one — finds out, since the timer lives in ClickUp and not in the mirror the
   * `tasks` feed watches.
   */
  source.addEventListener("timer", (event) => {
    const { entry } = JSON.parse((event as MessageEvent<string>).data) as {
      entry: TimeEntry | null;
    };
    setRunningTimer(entry);
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
  update_comment: "comment edit",
  delete_comment: "comment deletion",
  set_custom_field: "field change",
  create_checklist: "new checklist",
  update_checklist: "checklist rename",
  delete_checklist: "checklist deletion",
  create_checklist_item: "new checklist item",
  update_checklist_item: "checklist tick",
  delete_checklist_item: "checklist item deletion",
};
