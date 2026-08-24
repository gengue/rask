/**
 * Fixed-height windowing, shared by the list and the board.
 *
 * Both had their own byte-identical copy, written once per branch. TanStack
 * Virtual is not here for the reason the README gives: its Solid adapter binds
 * to a 0x0 rect on the path where the detail panel mounts first, and rows are a
 * known height anyway, so prefix sums and a binary search do the whole job.
 */

/** Rows to draw beyond the viewport, so a fast scroll does not show blanks. */
export const OVERSCAN = 4;

/** The slice of items on screen, as indices into the flat list. */
export interface Range {
  start: number;
  end: number;
}

/**
 * Whether two windows are the same window.
 *
 * `visibleRange` returns a fresh object every call and Solid's default memo
 * equality is `===`, so a memo wrapping it notifies on every scroll event —
 * where a pixel of scrolling almost never moves either edge past an item. Both
 * callers build their rows imperatively into an array, and `reconcileArrays`
 * keys on DOM node identity, so nothing is reused: a notification destroys and
 * recreates every visible row. That means fresh `<img>` avatars to decode,
 * `:hover` lost until the pointer moves, `transition-colors` starting at its
 * end value, and any text selection gone — several hundred nodes per event,
 * inside the scroll handler. Passing this as the memo's `equals` leaves only
 * the events that actually move the window: measured on the board, sixteen
 * over the first ten cards of travel rather than one per pixel.
 */
export function sameRange(a: Range, b: Range): boolean {
  return a.start === b.start && a.end === b.end;
}

export function visibleRange(
  offsets: Float64Array,
  scrollTop: number,
  height: number,
  overscan = OVERSCAN,
): Range {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, indexAt(offsets, scrollTop, count) - overscan);
  const end = Math.min(count, indexAt(offsets, scrollTop + height, count) + 1 + overscan);
  return { start, end };
}

/** Largest index whose offset is <= `pixel`. Offsets ascend, so binary search. */
function indexAt(offsets: Float64Array, pixel: number, count: number): number {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((offsets[mid] ?? 0) <= pixel) low = mid;
    else high = mid - 1;
  }
  return low;
}
