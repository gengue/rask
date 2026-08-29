import { type Accessor, type Setter, untrack } from "solid-js";
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
  /*
   * `untrack`ed throughout, because a setter runs in its *caller's* reactive
   * scope and `state.value` is a live store read. Solid's own signal setter
   * subscribes the caller to nothing; this one silently subscribed anyone who
   * called `mutate` inside an effect to the resource's value — the effect that
   * resets the time-entries panel on a task switch called `mutate(undefined)`,
   * got subscribed, and re-ran on every fetch that landed, folding the section
   * and discarding the answer it had just been handed.
   */
  const set = ((next?: T | ((current: T | undefined) => T | undefined)) =>
    untrack(() => {
      const value =
        typeof next === "function" ? (next as (c: T | undefined) => T)(state.value) : next;
      setState("value", value === undefined ? undefined : reconcile(value));
      return state.value;
    })) as Setter<T | undefined>;

  return [() => state.value, set];
}
