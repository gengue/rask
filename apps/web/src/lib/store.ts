import { createCollection } from "@tanstack/solid-db";
import { api, type Task, type TaskQuery } from "./api.ts";
import { pushToast } from "./toast.ts";
import { setViewLoading } from "./view.ts";

/**
 * One collection holds every task the session has loaded, from any view.
 *
 * Views are live queries over that single collection rather than collections of
 * their own. Switching from My Tasks to a list is then instant for anything
 * already loaded, and a task that appears in two views is one row that updates
 * once.
 *
 * Writes go through `collection.update`, which applies optimistically and rolls
 * back on its own if the API call throws. The server is doing the same thing
 * one layer down: write to Postgres, queue for ClickUp, repair if ClickUp says
 * no. The optimism is layered, not duplicated.
 */

type SyncApi = {
  begin: () => void;
  write: (message: { type: "insert" | "update" | "delete"; key: string; value?: Task }) => void;
  commit: () => void;
};

let syncApi: SyncApi | null = null;
/** Rows that arrived before the collection started syncing. */
let buffered: Task[] = [];

export const tasks = createCollection<Task, string>({
  id: "tasks",
  getKey: (task) => task.id,
  sync: {
    // The API always sends whole rows, never patches.
    rowUpdateMode: "full",
    sync: ({ begin, write, commit, markReady }) => {
      syncApi = { begin, write, commit } as SyncApi;

      if (buffered.length > 0) {
        const rows = buffered;
        buffered = [];
        merge(rows);
      }

      /*
       * Ready immediately, with nothing in it.
       *
       * The route that mounts decides what to load; fetching My Tasks here as
       * well meant every cold boot of the default view issued the same 500-row
       * query twice. But readiness cannot wait for that fetch: live queries
       * suspend until the collection is ready, and the read is also what starts
       * this sync, so deferring markReady deadlocks the two against each other
       * and the view renders nothing at all.
       *
       * An empty ready collection is honest. `viewLoading` is what stops the
       * first frame from claiming the list is empty.
       */
      markReady();

      return () => {
        syncApi = null;
      };
    },
  },

  onUpdate: async ({ transaction }) => {
    for (const mutation of transaction.mutations) {
      const patch = toApiPatch(mutation.changes as Partial<Task>);
      if (Object.keys(patch).length === 0) continue;
      await api.patchTask(String(mutation.key), patch);
    }
  },

  onInsert: async ({ transaction }) => {
    for (const mutation of transaction.mutations) {
      const task = mutation.modified as Task;
      await api.createTask({
        listId: task.listId,
        name: task.name,
        status: task.status ?? undefined,
        priority: task.priority,
        dueDate: task.dueDate ? Date.parse(task.dueDate) : null,
        assignees: task.assignees.map((a) => a.id),
        // The placeholder id doubles as the idempotency key the server matches
        // ClickUp's reply back to.
        clientId: task.id.replace(/^tmp_/, ""),
      });
    }
  },
});

/** Folds server rows into the collection: insert, update, or drop if deleted. */
export function merge(rows: Task[]): void {
  if (rows.length === 0) return;
  if (!syncApi) {
    buffered.push(...rows);
    return;
  }
  syncApi.begin();
  for (const row of rows) {
    if (row.deletedAt) {
      syncApi.write({ type: "delete", key: row.id });
    } else {
      syncApi.write({ type: tasks.get(row.id) ? "update" : "insert", key: row.id, value: row });
    }
  }
  syncApi.commit();
}

/**
 * Pulls a view's tasks into the collection.
 *
 * Deliberately additive: it never drops rows that fall outside the query, so
 * navigating back to a view already has its data. The cost is that a task that
 * left a list stays visible until the next SSE frame corrects it.
 */
export async function load(query: TaskQuery): Promise<boolean> {
  setViewLoading(true);
  try {
    const page = await api.tasks({ limit: 500, ...query });
    merge(page.tasks);
    return page.truncated;
  } catch (error) {
    // Silently showing an empty list is how a failed fetch reads as "no tasks".
    pushToast({
      tone: "error",
      title: "Could not load tasks",
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    setViewLoading(false);
  }
}

/**
 * Pulls a view's tasks into the collection and reports which rows it holds.
 *
 * The membership set is the point. Every other route recovers "what am I
 * showing" from the collection with a predicate — this list, this assignee —
 * but a view is a subset ClickUp computed from filters the browser never sees,
 * so the ids are the only thing that says which rows belong to it.
 *
 * Merging into the shared collection anyway is what keeps a task open in the
 * detail panel, edited from the palette, or updated over SSE in step with the
 * rest of the app: a view is a different set of the same rows, not a copy.
 */
export async function loadViewTasks(
  viewId: string,
): Promise<{ ids: Set<string>; truncated: boolean }> {
  setViewLoading(true);
  try {
    const page = await api.viewTasks(viewId);
    merge(page.tasks);
    return { ids: new Set(page.tasks.map((task) => task.id)), truncated: page.truncated };
  } catch (error) {
    pushToast({
      tone: "error",
      title: "Could not load this view",
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ids: new Set(), truncated: false };
  } finally {
    setViewLoading(false);
  }
}

function toApiPatch(changes: Partial<Task>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (changes.name !== undefined) patch.name = changes.name;
  if (changes.status !== undefined) patch.status = changes.status;
  if (changes.priority !== undefined) patch.priority = changes.priority;
  if (changes.dueDate !== undefined) {
    patch.dueDate = changes.dueDate ? Date.parse(changes.dueDate) : null;
  }
  if (changes.assignees !== undefined) patch.assignees = changes.assignees.map((a) => a.id);
  return patch;
}
