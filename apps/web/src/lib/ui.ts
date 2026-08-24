import { createStore } from "solid-js/store";
import type { Clause } from "./filters.ts";

export type GroupBy = "status" | "due" | "assignee" | "priority" | "list" | "none";
export type Layout = "list" | "board";

/**
 * View state that the URL does not own.
 *
 * Which task is open lives in the URL, because those links get shared. Grouping,
 * the cursor position and whichever overlay is up do not: they are per-tab
 * ephemera, and putting them in the URL would make the back button undo a
 * keystroke.
 */
export const [ui, setUi] = createStore({
  /** Cursor for j/k navigation. Index into the flattened, grouped row list. */
  cursor: 0,
  groupBy: "status" as GroupBy,
  /**
   * Rows or columns. Sits next to `groupBy` because it is the same kind of
   * decision — how this view is arranged, per tab, not per link — and because
   * the cursor above means the same thing in both: an index into the flattened
   * row list, which the board reads as a column plus a depth.
   */
  layout: "list" as Layout,
  showClosed: false,
  search: "",
  palette: false,
  quickAdd: false,
  shortcuts: false,
  /**
   * The sidebar drawer, below the `dock` breakpoint only.
   *
   * Above `dock` the sidebar is a column and this flag does nothing, which is
   * why it is not persisted: a window that grows past `dock` should not
   * remember that a drawer was once open at 900.
   */
  sidebarOpen: false,
  /** Set while a keystroke-driven menu is open, so j/k stop moving the cursor. */
  menu: null as null | "status" | "assignee" | "priority" | "filter",
  /**
   * The filter, as a list of clauses.
   *
   * The ponytail comment this replaces said no round trip: a view holds a few
   * hundred rows, filtering them is one pass, and narrowing by status is
   * instant. It was right about the cost and wrong about the answer, and it
   * named its own expiry — "push these into the query the day a view needs more
   * rows than one request returns". The Bugs list holds 5,696 tasks and a view
   * loads 500 of them, so "filter by status" meant "filter by the statuses that
   * happened to be in the first 500" and said nothing about it.
   *
   * So the clauses go to the server, which applies them over the whole list,
   * and the browser evaluates the same clauses over the rows it holds. The
   * round trip that comment was avoiding is 0.2-2ms on the mirror; what it
   * bought was a filter that lied about how much it had seen.
   *
   * `search` — the text from `/` — is deliberately not in here. It lives in
   * `search` below because an input field wants a plain string, and joins the
   * clauses in `lib/view.ts` where the filter is assembled.
   */
  filters: [] as Clause[],
});

export function closeOverlays(): void {
  setUi({ palette: false, quickAdd: false, shortcuts: false, menu: null, sidebarOpen: false });
}

export function clearFilters(): void {
  setUi("filters", []);
}
