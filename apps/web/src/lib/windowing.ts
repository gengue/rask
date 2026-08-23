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

export function visibleRange(
  offsets: Float64Array,
  scrollTop: number,
  height: number,
  overscan = OVERSCAN,
): { start: number; end: number } {
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
