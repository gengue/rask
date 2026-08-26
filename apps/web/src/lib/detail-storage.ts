import type { Accessor, Setter } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { TaskDetail } from "./api.ts";

/** Keeps resource updates granular so one changed field does not repaint every rich body. */
export function detailStorage(
  initial: TaskDetail | undefined,
): [Accessor<TaskDetail | undefined>, Setter<TaskDetail | undefined>] {
  const [state, setState] = createStore<{ value: TaskDetail | undefined }>({ value: initial });
  const set = ((
    next?: TaskDetail | ((current: TaskDetail | undefined) => TaskDetail | undefined),
  ) => {
    const value = typeof next === "function" ? next(state.value) : next;
    setState("value", value === undefined ? undefined : reconcile(value));
    return state.value;
  }) as Setter<TaskDetail | undefined>;

  return [() => state.value, set];
}
