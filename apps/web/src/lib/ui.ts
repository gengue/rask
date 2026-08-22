import { createStore } from "solid-js/store";

export type GroupBy = "status" | "due" | "assignee" | "none";

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
});

export function closeOverlays(): void {
  setUi({ palette: false, quickAdd: false, menu: null });
}
