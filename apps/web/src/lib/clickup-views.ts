import { createSignal } from "solid-js";
import { api, type ListView, type View } from "./api.ts";
import { pushToast } from "./toast.ts";
import { type GroupBy, readShowClosed, setUi } from "./ui.ts";

/**
 * The tabs above a list, and what Rask can do with each of them.
 *
 * ClickUp has fourteen view types and Rask draws two of them. The rest are not
 * hidden and not stubbed: they keep their tab and it opens ClickUp, because a
 * calendar tab that silently shows a list is worse than one that admits it is
 * somewhere else.
 */

/** Tabs for the list currently on screen, in ClickUp's own order. */
export const [listViews, setListViews] = createSignal<ListView[]>([]);
/**
 * Which list the tabs above belong to.
 *
 * Null while a fetch is in flight, which is what lets a route tell "this list
 * has no such view" from "the tabs have not arrived yet" without a second
 * loading flag.
 */
export const [listViewsOf, setListViewsOf] = createSignal<string | null>(null);

/**
 * Loads a list's tabs, once per list.
 *
 * Two guards, for two different mistakes. The early return is because every
 * route effect that touches a list calls this, and the tab bar does not change
 * while somebody reads one list — the API re-reads it from ClickUp behind the
 * response anyway, so the next visit picks up an added view. The ticket is
 * against out-of-order answers: clicking through three lists faster than the
 * network resolves must leave the third list's tabs on screen, not whichever
 * request happened to finish last.
 */
let inFlight = 0;

export async function loadListViews(listId: string): Promise<void> {
  if (listViewsOf() === listId) return;

  const ticket = ++inFlight;
  setListViews([]);
  setListViewsOf(null);

  try {
    const views = await api.views(listId);
    if (ticket !== inFlight) return;
    setListViews(views);
    setListViewsOf(listId);
  } catch (error) {
    if (ticket !== inFlight) return;
    // A missing tab bar is survivable — the list itself still renders — so this
    // is a toast rather than an error screen.
    pushToast({
      tone: "error",
      title: "Could not load views",
      detail: error instanceof Error ? error.message : String(error),
    });
    setListViewsOf(listId);
  }
}

/** Forgets the current tabs. Called when a route leaves lists behind entirely. */
export function clearListViews(): void {
  inFlight++;
  setListViews([]);
  setListViewsOf(null);
}

/**
 * View types Rask renders itself.
 *
 * `list` and `board`, each rendered as itself: `applyView` reads the type and
 * picks the layout. Everything else — calendar, gantt, form, conversation —
 * gets a tab that opens it in ClickUp, because rendering it here as something
 * it is not is worse than not rendering it.
 */
export function isRenderable(type: string): boolean {
  return type === "list" || type === "board";
}

/**
 * ClickUp's grouping vocabulary, mapped to Rask's.
 *
 * Grouping is the one part of a view Rask applies itself: `GET /view/{id}/task`
 * hands back the rows that survived the filters, already ordered, but grouping
 * is a rendering decision and stays here.
 *
 * ClickUp groups by things Rask has no column for — a Custom Field, a date the
 * list does not show, a location. Those fall back to status, which is what
 * every other view in Rask already groups by, and the grouping control in the
 * header keeps saying "Status" so the fallback is on screen rather than hidden.
 * `ignore` is ClickUp's own "no grouping", and it does mean none.
 */
export function groupByForField(field: string | null | undefined): GroupBy {
  switch (field) {
    case "assignee":
      return "assignee";
    case "priority":
      return "priority";
    case "dueDate":
      return "due";
    case "list":
      return "list";
    default:
      return "status";
  }
}

/**
 * Puts a view's grouping and its closed-task setting on screen.
 *
 * `showClosed` is a default, not an instruction. It was read as one — the
 * view's `show_closed` written straight over the toggle — on the theory that
 * ClickUp had already decided which rows it sent. It has not: `show_closed` is
 * a display setting, and `GET /view/{id}/task` returns the closed tasks either
 * way. So the value only decided whether Rask drew the Done column, and it
 * decided it again on every view opened, which is how a reader who turned the
 * column on lost it by clicking the next tab.
 *
 * Now it seeds the toggle only while nobody has an opinion. Once the reader
 * picks, `readShowClosed` answers with their choice and the view stops arguing.
 */
export function applyView(view: View): void {
  setUi({
    groupBy: groupByForField(view.groupField),
    showClosed: readShowClosed() ?? view.showClosed,
    /*
     * A board tab draws a board.
     *
     * The rows are the same either way — `GET /view/{id}/task` has already
     * applied the view's filters — so the type only decides how they are laid
     * out. Rendering ClickUp's Kanban as a flat list was the tab lying about
     * what it was: the name said board, the columns were headings.
     *
     * Set on every view, not only boards, so switching from a board tab back to
     * a list tab returns to a list instead of leaving the board behind.
     */
    layout: view.type === "board" ? "board" : "list",
    // Row 12 of the previous tab is a different task in this one. The shell
    // resets the cursor when the title changes, and switching tabs within a
    // list does not change the title.
    cursor: 0,
  });
}

/**
 * Where a view lives in ClickUp.
 *
 * A form is published at its own address on forms.clickup.com and that is the
 * only place it can be filled in. Everything else is `/{team}/v/l/{view_id}`,
 * which is the shape `lib/clickup-url.ts` already reads in the other direction.
 *
 * Null before the session has loaded, since the workspace id is half the
 * address. The tab renders as plain text until it can point somewhere real,
 * which is a fraction of a second at boot and never again.
 */
export function clickUpViewUrl(view: View, teamId: string | null): string | null {
  if (view.publicUrl) return view.publicUrl;
  return teamId ? `https://app.clickup.com/${teamId}/v/l/${view.id}` : null;
}

/**
 * What to call a view type in a sentence.
 *
 * Only the types Rask refuses to draw need one, and only in prose — the tab
 * itself shows the view's name. Anything ClickUp adds later falls through to
 * its own wire name with the underscores taken out, which reads well enough
 * for a type nobody has seen yet.
 */
const TYPE_LABELS: Record<string, string> = {
  activity: "activity",
  box: "box",
  calendar: "calendar",
  conversation: "chat",
  dashboard: "dashboard",
  doc: "doc",
  form: "form",
  gantt: "Gantt",
  gantt_type: "Gantt",
  map: "map",
  mind_map: "mind map",
  table: "table",
  timeline: "timeline",
  workload: "workload",
};

export function viewTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}
