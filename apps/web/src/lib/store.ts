import { createCollection } from "@tanstack/solid-db";
import { api, type Task, type TaskQuery } from "./api.ts";

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
let markReadyOnce: (() => void) | null = null;

export const tasks = createCollection<Task, string>({
  id: "tasks",
  getKey: (task) => task.id,
  sync: {
    // The API always sends whole rows, never patches.
    rowUpdateMode: "full",
    sync: ({ begin, write, commit, markReady, markError }) => {
      syncApi = { begin, write, commit } as SyncApi;
      markReadyOnce = markReady;

      void api
        .tasks({ assignee: "me", limit: 500 })
        .then((rows) => {
          merge(rows);
          markReady();
        })
        .catch(markError);

      return () => {
        syncApi = null;
        markReadyOnce = null;
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
  if (!syncApi || rows.length === 0) return;
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
export async function load(query: TaskQuery): Promise<void> {
  const rows = await api.tasks({ limit: 500, ...query });
  merge(rows);
  markReadyOnce?.();
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
