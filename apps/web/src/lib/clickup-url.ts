/**
 * Turns a ClickUp URL into the ids Rask should look up.
 *
 * This is deliberately a resolver rather than a grammar for ClickUp's routes.
 * ClickUp has a lot of URL shapes and keeps adding more, so enumerating them
 * means being wrong every time they ship one. What the shapes have in common is
 * that the interesting id sits at the end of the path and everything in front
 * of it is routing vocabulary:
 *
 *   /t/{task}                 /{team}/v/li/{list}      /{team}/home
 *   /t/{team}/{custom_id}     /{team}/v/l/{view}       /{team}/v/f/{folder}
 *                             /{team}/v/o/s/{space}
 *
 * So: drop the routing words, keep what is left as candidate ids (last segment
 * first, because that is the specific one), and let the mirror say what they
 * actually are. A shape nobody has seen still resolves as long as it ends in an
 * id we know about.
 */

/** Segments that are ClickUp's routing vocabulary, never an id. */
const ROUTE_WORDS = new Set(["t", "v", "li", "l", "f", "o", "s"]);

/** Paths that mean "the signed-in user's work", which is Rask's home view. */
const MY_WORK = new Set(["home", "my-work"]);

/**
 * More than this and we are guessing. Every real shape has the id within two
 * segments of the end, and each extra candidate costs the API another lookup.
 */
const MAX_CANDIDATES = 3;

export type ClickUpPath =
  | { kind: "my-work" }
  | { kind: "lookup"; ids: string[]; remote: boolean }
  | { kind: "unknown" };

export function parseClickUpPath(input: string): ClickUpPath {
  const segments = pathname(input)
    .split("/")
    .map(decodeSegment)
    .filter((segment) => segment.length > 0);

  const last = segments.at(-1);
  if (!last) return { kind: "my-work" };
  if (MY_WORK.has(last.toLowerCase())) return { kind: "my-work" };

  const ids = segments
    .filter((segment) => !ROUTE_WORDS.has(segment.toLowerCase()))
    .reverse()
    .slice(0, MAX_CANDIDATES);

  if (ids.length === 0) return { kind: "unknown" };

  // `/t/` means "task" in every ClickUp URL there is, so it is the one case
  // where it is worth asking ClickUp itself when the mirror comes up empty.
  return { kind: "lookup", ids, remote: segments[0]?.toLowerCase() === "t" };
}

/** Accepts a pasted absolute URL as readily as the path the router hands us. */
function pathname(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return "";
    }
  }
  return trimmed.split(/[?#]/)[0] ?? "";
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is not an id we could ever match. Keep it raw and let
    // the lookup miss rather than throwing on the way to a "not found" screen.
    return segment;
  }
}
