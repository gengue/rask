import { createStore } from "solid-js/store";
import type { Clause } from "./filters.ts";

export type GroupBy = "status" | "due" | "assignee" | "priority" | "list" | "none";
export type Layout = "list" | "board";

/**
 * Above the store, not below it with `setShowClosed`, because the store's own
 * initialiser reads it. A `const` declared after is in its temporal dead zone
 * at that point, the `try` below swallows the ReferenceError as if storage were
 * unavailable, and the preference silently never loads.
 */
const SHOW_CLOSED_KEY = "rask.showClosed";

/**
 * The stored closed-task preference, or null when nobody has chosen one.
 *
 * The null matters as much as the boolean. It is the only record of whether the
 * reader has an opinion, and it is what lets a saved view seed the toggle from
 * ClickUp once without overriding a choice made afterwards — see `applyView` in
 * lib/clickup-views.ts. Same shape as `read` in lib/sidebar-state.ts, including
 * the swallowed throw: private mode has no localStorage, and a preference is
 * not worth a blank app.
 */
export function readShowClosed(): boolean | null {
  try {
    const raw = localStorage.getItem(SHOW_CLOSED_KEY);
    return raw == null ? null : raw === "1";
  } catch {
    return null;
  }
}

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
  /**
   * Whether closed statuses get a group, a column and rows.
   *
   * The odd one out in this store: it is read back from localStorage rather
   * than starting fresh per tab. Everything else here is a decision about the
   * moment — where the cursor is, which overlay is up — and this is a reading
   * preference. Left ephemeral it survived walking from list to list and
   * nothing else: a reload dropped it, and so did the first saved view opened
   * afterwards, which seeds it from ClickUp's own `show_closed`.
   *
   * Write it through `setShowClosed`, never `setUi` directly, or the choice
   * holds for the tab and is gone on the next reload.
   */
  showClosed: readShowClosed() ?? false,
  /**
   * Folded groups, as `<groupBy>:<groupId>` keys.
   *
   * Prefixed per grouping so "none" folded under priority does not also fold
   * "No due date", and so switching groupings away and back keeps the folds.
   * Per-tab ephemera like the rest of this store, and shared across views —
   * folding "in progress" folds it on every list, which is also what makes the
   * fold survive navigating.
   */
  collapsed: [] as string[],
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
  menu: null as null | "status" | "assignee" | "priority" | "filter" | "task",
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

export function setShowClosed(value: boolean): void {
  setUi("showClosed", value);
  try {
    localStorage.setItem(SHOW_CLOSED_KEY, value ? "1" : "0");
  } catch {
    // Private mode, or a full quota. The choice still holds for this session.
  }
}

export function closeOverlays(): void {
  setUi({ palette: false, quickAdd: false, shortcuts: false, menu: null, sidebarOpen: false });
}

export function clearFilters(): void {
  setUi("filters", []);
}

/** Folds or unfolds one group of the current grouping. */
export function toggleGroup(groupId: string): void {
  const key = `${ui.groupBy}:${groupId}`;
  setUi(
    "collapsed",
    ui.collapsed.includes(key)
      ? ui.collapsed.filter((entry) => entry !== key)
      : [...ui.collapsed, key],
  );
}

/**
 * Unfolds every group of the current grouping.
 *
 * This is the keyboard's way back: the cursor can only ever sit in an unfolded
 * group, so `z` can fold one but has nowhere to stand to unfold it again.
 */
export function expandGroups(): void {
  const prefix = `${ui.groupBy}:`;
  setUi(
    "collapsed",
    ui.collapsed.filter((entry) => !entry.startsWith(prefix)),
  );
}
