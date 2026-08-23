import { createStore } from "solid-js/store";

export type GroupBy = "status" | "due" | "assignee" | "list" | "none";
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
  /** Task detail fills the main area instead of sitting in a 420px rail. */
  taskExpanded: false,
  /**
   * The sidebar drawer, below the `dock` breakpoint only.
   *
   * Above `dock` the sidebar is a column and this flag does nothing, which is
   * why it is not persisted: a window that grows past `dock` should not
   * remember that a drawer was once open at 900.
   */
  sidebarOpen: false,
  /** Set while a keystroke-driven menu is open, so j/k stop moving the cursor. */
  menu: null as null | "status" | "assignee" | "priority",
  /**
   * Facet filters, applied client-side over the tasks already loaded.
   *
   * ponytail: no round trip. A view holds at most a few hundred rows in memory
   * and filtering them is a single pass, so narrowing by status is instant and
   * cannot show a stale server answer. Push these into the query the day a view
   * needs more rows than one request returns.
   */
  filters: {
    status: null as string | null,
    assignee: null as string | null,
    tag: null as string | null,
  },
});

export function closeOverlays(): void {
  setUi({ palette: false, quickAdd: false, shortcuts: false, menu: null, sidebarOpen: false });
}

export function clearFilters(): void {
  setUi("filters", { status: null, assignee: null, tag: null });
}

export function activeFilterCount(): number {
  return Object.values(ui.filters).filter(Boolean).length;
}
