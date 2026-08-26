import type { Accessor, Setter } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

/**
 * Resource storage that swaps replacement for reconciliation.
 *
 * A refetch answers with a fresh object graph, and handing that to Solid
 * wholesale repaints everything that read the old one — the task-detail
 * flicker, and the time-entry list rebuilding every row (avatars re-decoding,
 * :hover dropping) on the refetch that follows a stopped timer. `reconcile`
 * diffs by `id` instead, so only what actually changed touches the DOM.
 */
export function reconcileStorage<T>(
  initial: T | undefined,
): [Accessor<T | undefined>, Setter<T | undefined>] {
  const [state, setState] = createStore<{ value: T | undefined }>({ value: initial });
  const set = ((next?: T | ((current: T | undefined) => T | undefined)) => {
    const value =
      typeof next === "function" ? (next as (c: T | undefined) => T)(state.value) : next;
    setState("value", value === undefined ? undefined : reconcile(value));
    return state.value;
  }) as Setter<T | undefined>;

  return [() => state.value, set];
}
