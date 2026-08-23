import { type Accessor, createMemo, createRoot } from "solid-js";

/**
 * A memo that belongs to the application rather than to a component.
 *
 * A `createMemo` at module scope has no owner, which Solid warns about on every
 * boot: "computations created outside a createRoot or render will never be
 * disposed". The warning is right about the mechanism and wrong about the
 * intent — these derive view state that outlives every component that reads it,
 * so never being disposed is the point.
 *
 * Giving each one its own root says that on purpose, and stops the warning from
 * burying the ones that mean something.
 */
export function globalMemo<T>(compute: () => T): Accessor<T> {
  return createRoot(() => createMemo(compute));
}
