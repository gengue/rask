import { useLiveQuery } from "@tanstack/solid-db";
import type { Accessor } from "solid-js";
import { createMemo } from "solid-js";
import type { Task } from "./api.ts";
import { tasks } from "./store.ts";

/**
 * A view over the single task collection.
 *
 * ponytail: the predicate runs in Solid rather than in TanStack DB's query
 * builder. The collection is a few thousand rows at most and a plain filter
 * over it is microseconds; expressing the same thing as a live query would
 * mean pushing route params through the builder's expression API for no
 * measurable gain. Move it into the builder if a view ever gets large enough
 * to need incremental maintenance.
 */
export function useLiveTasks(predicate: Accessor<(task: Task) => boolean>): Accessor<Task[]> {
  const all = useLiveQuery((q) => q.from({ task: tasks }));

  return createMemo(() => {
    const rows = (all() ?? []) as Task[];
    return rows.filter(predicate());
  });
}
