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
 *                             /{team}/v/o/s/{space}    /{team}/v/dc/{doc}/{page}
 *
 * So: drop the routing words, keep what is left as candidate ids (last segment
 * first, because that is the specific one), and let the mirror say what they
 * actually are. A shape nobody has seen still resolves as long as it ends in an
 * id we know about.
 */

/** Segments that are ClickUp's routing vocabulary, never an id. */
const ROUTE_WORDS = new Set(["t", "v", "li", "l", "f", "o", "s", "dc"]);

/** Paths that mean "the signed-in user's work", which is Rask's home view. */
const MY_WORK = new Set(["home", "my-work"]);

/**
 * More than this and we are guessing. Every real shape has the id within two
 * segments of the end, and each extra candidate costs the API another lookup.
 */
const MAX_CANDIDATES = 3;

/**
 * Which single ClickUp request is worth making when the mirror comes up empty.
 *
 * Null for almost every shape, because a miss there is a miss: asking about a
 * typo costs a round trip to be told what the mirror already said. Two shapes
 * earn it, because the URL itself says what kind of thing the id is, and both
 * can name something real that no list anyone opened ever put in the mirror —
 * `/t/{id}` is a task, and `/{team}/v/l/{id}` is a view.
 */
export type RemoteLookup = "task" | "view" | null;

export type ClickUpPath =
  | { kind: "my-work" }
  | { kind: "lookup"; ids: string[]; remote: RemoteLookup }
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

  return { kind: "lookup", ids, remote: remoteLookup(segments) };
}

/**
 * What the routing words say the id is, when they say anything.
 *
 * Read off the route rather than the id, because the ids give nothing away:
 * a view is `gh-96335` or `7-529-1`, a list is `5345534`, and a Workspace id
 * is a bare number too. The words in front of them are the only part of a
 * ClickUp URL that names what follows.
 *
 * Two shapes, both verified against the live app. `/t/` heads every task URL
 * there is. `/v/l/` heads every view URL — `/v/li/`, `/v/f/` and `/v/o/s/` are
 * a list, a folder and a space, and none of those is worth a request: the
 * mirror already holds every one Rask can do anything with.
 */
function remoteLookup(segments: string[]): RemoteLookup {
  const route = segments.map((segment) => segment.toLowerCase());
  if (route[0] === "t") return "task";
  const v = route.indexOf("v");
  return v >= 0 && route[v + 1] === "l" ? "view" : null;
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

/**
 * The page id a Doc URL was opened at, if it carried one.
 *
 * `/{team}/v/dc/{doc}/{page}` puts the page behind the Doc, and the resolver
 * above deliberately throws it away: it looks up ids and a page id is not one
 * the mirror holds. But the reader can open on a page without knowing anything
 * about it beyond the id, so the segment is worth keeping — read positionally,
 * off the Doc id the lookup did match, so no new route shape is assumed.
 */
export function docPageId(input: string, docId: string): string | undefined {
  const segments = pathname(input).split("/").map(decodeSegment);
  const at = segments.indexOf(docId);
  // `|| undefined` and not `??`: a trailing slash leaves an empty segment, and
  // an empty page id would put `?page=` in the bar for a Doc opened at no page.
  return at < 0 ? undefined : segments[at + 1] || undefined;
}
