import type { TaskDetail } from "./api.ts";

/**
 * The same detail, as the same object.
 *
 * An open task is re-read every 30s and pushed at again over SSE — and the API
 * pushes whether or not ClickUp had anything new, because comments do not move
 * `tasks.synced_at` and it has no cheaper way to know. Almost every one of
 * those answers is byte-identical to the one already on screen.
 *
 * A fresh object for identical bytes is still a fresh identity, and the panel
 * is built out of things that key on identity: `<For>` over the comment threads
 * rebuilds every `<li>`, and the description and each comment body re-parse and
 * re-inject their `innerHTML`, which reloads the images inside them. Nothing
 * changed and the whole panel blinks.
 *
 * Handing back the previous object means Solid's default equality sees no
 * change at all, so a poll that finds nothing costs one comparison and no
 * render. `JSON.stringify` over one task is cheap next to what it saves; the
 * rows are plain JSON off the wire, so there is nothing in them it cannot see.
 *
 * Two tasks can never collapse into one object: `id` is a field of the detail,
 * so it is inside the string being compared. An explicit id check on top of
 * that is unreachable — no test can tell the two apart, which is how it was
 * found — so the comparison is the whole rule.
 */
export function stableDetail(): (next: TaskDetail) => TaskDetail {
  let last: { json: string; value: TaskDetail } | null = null;

  return (next) => {
    const json = JSON.stringify(next);
    if (last && last.json === json) return last.value;
    last = { json, value: next };
    return next;
  };
}
