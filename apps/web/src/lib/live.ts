import type { Accessor } from "solid-js";
import { createMemo, createRoot } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { Task } from "./api.ts";
import { tasks } from "./store.ts";

/**
 * A view over the single task collection.
 *
 * The rows are mirrored into a keyed Solid store rather than read through
 * `useLiveQuery`. The query builder was never used for anything — the view
 * predicate is a plain function of route params, and expressing it in the
 * builder's expression API would buy incremental maintenance we do not need
 * for a few thousand rows. Skipping it drops the compiler, the optimizer and
 * the dataflow operators from the bundle, which is about 40kB gzipped, and
 * removes a full O(n) array reconcile on every change batch.
 *
 * `subscribeChanges` still carries optimistic state, so a local edit shows up
 * here before the write is sent, and a rollback shows up when it is undone.
 */
const [rows, setRows] = createStore<Record<string, Task>>({});

/*
 * Subscribed for the life of the tab, in a root of its own for the same reason
 * the collection has one: a computation at module scope has no owner.
 */
createRoot(() =>
  tasks.subscribeChanges(
    (changes) => {
      setRows(
        produce((draft) => {
          for (const change of changes) {
            if (change.type === "delete") delete draft[change.key];
            else draft[change.key] = change.value as Task;
          }
        }),
      );
    },
    { includeInitialState: true },
  ),
);

export function useLiveTasks(predicate: Accessor<(task: Task) => boolean>): Accessor<Task[]> {
  return createMemo(() => Object.values(rows).filter(predicate()));
}
