import type { Resource } from "solid-js";

/**
 * Non-suspending, non-throwing reads of a resource.
 *
 * The router wraps every route match in a Suspense boundary with no fallback,
 * and the shell outside the Outlet sits under the root route's. A plain
 * `resource()` read while a fetch is in flight registers with that boundary
 * and unmounts everything up to it — the page goes blank for the length of the
 * round trip and remounts when it lands. `resource.latest` still suspends
 * before the first value ever arrives, and both accessors re-throw the
 * fetcher's rejection once nothing is in flight, which with no ErrorBoundary
 * anywhere takes the page down for good — one failed 30-second poll used to be
 * enough. These two never suspend and never throw; they differ only in what
 * they answer while a refetch is in flight, so pick by what stale means at the
 * call site.
 *
 * A resource built with an `initialValue` whose fetcher catches its own
 * rejections is already safe to read plainly — it resolves at birth and never
 * errors. These helpers are for the rest.
 */

/** The value in hand: the previous answer during a refetch, nothing on error. */
export function heldValue<T>(resource: Resource<T>): T | undefined {
  return resource.state === "ready" || resource.state === "refreshing"
    ? resource.latest
    : undefined;
}

/** Only a current answer: `undefined` the moment a fetch is in flight. */
export function readyValue<T>(resource: Resource<T>): T | undefined {
  return resource.state === "ready" ? resource.latest : undefined;
}
