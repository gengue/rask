import { createStore } from "solid-js/store";

export type GroupBy = "status" | "due" | "assignee" | "list" | "none";

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
  showClosed: false,
  search: "",
  palette: false,
  quickAdd: false,
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
  setUi({ palette: false, quickAdd: false, menu: null });
}

export function clearFilters(): void {
  setUi("filters", { status: null, assignee: null, tag: null });
}

export function activeFilterCount(): number {
  return Object.values(ui.filters).filter(Boolean).length;
}
