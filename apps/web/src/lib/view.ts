import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";
import { api, type FilterField, type StatusDef, type Tag, type Task } from "./api.ts";
import {
  assignedToMe,
  type Clause,
  isCustomField,
  namedStatuses,
  needsClosed,
  selectRows,
  statusVisible,
  toggleAssignedToMe,
  toWire,
} from "./filters.ts";
import { globalMemo } from "./global-memo.ts";
import { type FlatItem, groupTasks, reuseItems } from "./grouping.ts";
import { me, members, spaces } from "./session.ts";
import { setUi, ui } from "./ui.ts";

/**
 * What the main panel is currently showing.
 *
 * The route owns the query; this owns the result. Keeping it in one place is
 * what lets the keyboard layer act on "the task under the cursor" without the
 * shell knowing which route rendered it.
 */
export const [viewTasks, setViewTasks] = createSignal<Task[]>([]);
export const [viewTitle, setViewTitle] = createSignal("Tasks");
export const [viewListId, setViewListId] = createSignal<string | null>(null);
/** True when the server had more rows than it was willing to send. */
export const [viewTruncated, setViewTruncated] = createSignal(false);
/**
 * True while a view is fetching.
 *
 * Starts true: before the first load there is nothing to show and "Nothing
 * here / Press c to create a task" would be a lie on a list with 400 tasks.
 */
export const [viewLoading, setViewLoading] = createSignal(true);

// --- the filter -------------------------------------------------------------

/**
 * The filter as the browser evaluates it: the clauses plus the search box.
 *
 * `/` is a clause here rather than a second mechanism. It used to be a
 * substring match over the rows already loaded while ⌘K searched the whole
 * workspace, which meant the same keystrokes answered two different questions
 * depending on which one you happened to press. They are still two entry
 * points, because "narrow what I am looking at" and "find that thing anywhere"
 * are different intents, but they are now the same search: one matcher on the
 * server over name, custom id and description, scoped to this view for `/` and
 * to the workspace for ⌘K.
 */
export const activeClauses = globalMemo<Clause[]>(() => withSearch(ui.filters, ui.search.trim()));

/**
 * The filter clauses plus the search term, which is itself a clause.
 *
 * Written out twice before, once here and once in `serverFilter`, differing
 * only in which copy of the search text they read. Two spellings of one clause
 * is how the two ends of the same search start meaning different things.
 */
function withSearch(filters: readonly Clause[], text: string): Clause[] {
  if (!text) return [...filters];
  return [...filters, { field: "search", op: "EQ", values: [text] }];
}

/**
 * The search box, one keystroke behind.
 *
 * The clauses go to the server, and a request per character typed is what a
 * debounce is for. 140ms is the interval the command palette already uses for
 * the same reason, and matching it means both searches feel the same.
 *
 * The undebounced text still narrows the rows already on screen through
 * `activeClauses`, so typing looks immediate and the server's wider answer
 * arrives underneath it.
 */
const SEARCH_DEBOUNCE_MS = 140;

const [settledSearch, setSettledSearch] = createSignal("");

createRoot(() => {
  createEffect(() => {
    const text = ui.search.trim();
    if (text === settledSearch()) return;
    const timer = setTimeout(() => setSettledSearch(text), SEARCH_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(timer));
  });
});

/**
 * The filter as the API wants it, or an empty string when there is none.
 *
 * Routes read this and refetch when it changes. Date buckets are resolved to
 * instants here, against this browser's clock, because "due this week" is a
 * question about the calendar on the wall behind the person asking and the
 * server has no way to see it.
 */
export const serverFilter = globalMemo(() => {
  const clauses = withSearch(ui.filters, settledSearch());
  if (clauses.length === 0) return "";
  return JSON.stringify(toWire(clauses, new Date()));
});

/**
 * The Custom Field ids the filter names, as a stable key.
 *
 * A saved view re-reads its rows when this changes and at no other time; see
 * the effect in `routes.tsx`.
 */
export const filterFieldIds = globalMemo(() =>
  ui.filters
    .filter((clause) => isCustomField(clause.field))
    .map((clause) => clause.field)
    .sort()
    .join(","),
);

/**
 * Whether the view is already narrowed to the signed-in user.
 *
 * Only My Tasks sets it, and it asks the server for `assignee=me` rather than
 * carrying a clause — so the quick filter there would be a button reading "off"
 * about a view that is already on. Set by the route that does the narrowing and
 * cleared on its unmount, like `viewIsFeed`.
 */
export const [viewIsMine, setViewIsMine] = createSignal(false);

/** Whether the "assigned to me" quick filter is on. */
export const mineOnly = globalMemo(() => {
  const userId = me()?.id;
  return userId ? assignedToMe(ui.filters, userId) : false;
});

/**
 * The quick filter, from the chip and from `a`.
 *
 * Here rather than in either caller so the two cannot drift: the header button
 * and the keystroke are one control with two ways in, the way `toggleTimer` is.
 * A no-op before `/api/me` lands, which is the only moment there is no "me".
 */
export function toggleMine(): void {
  const userId = me()?.id;
  if (userId) setUi("filters", toggleAssignedToMe(ui.filters, userId));
}

/** Whether the query has to ask for closed rows. See `needsClosed`. */
export const includeClosed = globalMemo(() => needsClosed(ui.filters, ui.showClosed));

/** `statusVisible` against the filter on screen. The rule itself is in filters.ts. */
export function statusShown(status: string | null, statusType: string | null | undefined): boolean {
  return statusVisible(status, statusType, ui.showClosed, namedStatuses(ui.filters));
}

/**
 * The rows the last filtered fetch returned, or null when there was no filter.
 *
 * The task collection is additive: it keeps every row any view has ever loaded.
 * That is what makes navigating back instant, and it is also why a filter
 * cannot be evaluated over it alone. On the Bugs list, 500 unfiltered rows plus
 * 500 filtered ones made the header count go *up* when a filter was added —
 * honest about what was on screen and a lie about what filtering does.
 *
 * So a filtered view shows what the server answered, narrowed further by the
 * clauses evaluated here. The narrowing is what keeps an edit immediate: change
 * a status under the cursor and the row leaves before the write is even sent,
 * without the set widening to rows the server excluded.
 *
 * Null with no filter, which is exactly the behaviour that was there before:
 * everything loaded for this view, including rows SSE brought in since.
 */
export const [viewMembership, setViewMembership] = createSignal<ReadonlySet<string> | null>(null);

/**
 * Where `/` can look.
 *
 * `server` on a list and on My Tasks: the clauses go into the query, so the
 * text is matched against name, custom id and description over every row in the
 * list rather than the page of it that happens to be loaded.
 *
 * `loaded` on a saved ClickUp view, where the rows are a set ClickUp computed
 * and re-asking it costs 1.8s a page. There the text narrows what is already in
 * hand, by name and custom id, because a row does not carry its description.
 * The placeholder in the header says which of the two you are getting.
 */
export const [searchScope, setSearchScope] = createSignal<"server" | "loaded">("server");

/**
 * Whether the panel is showing activity rather than a list of work.
 *
 * Only the inbox sets it, and it is one flag rather than three because the
 * three things it turns off are one idea. A feed is chronological, so grouping
 * would shuffle it back into buckets and lose the only order it has; it is
 * about what happened, so "somebody finished your task" — a closed task — is
 * the entry it most needs and the one the closed-tasks toggle drops; and it is
 * a sequence, so there are no columns for a board to draw.
 *
 * None of those are the user's preferences to lose. `ui.groupBy` and
 * `ui.layout` keep whatever they held and take effect again the moment you
 * leave, which is why this overrides them rather than writing to them.
 *
 * Cleared by the route on unmount rather than reset by every other route, so a
 * route added later cannot forget to turn it off.
 */
export const [viewIsFeed, setViewIsFeed] = createSignal(false);

/**
 * Whether a board is on screen — not whether the user prefers one.
 *
 * The distinction has to live somewhere shared, because the answer is read by
 * the thing that renders the panel and by the keyboard that moves the cursor
 * through it. Split across those two, a view that suppresses the board gets
 * rows on screen and h/l walking columns that are not there.
 */
export function boardLayout(): boolean {
  return ui.layout === "board" && !viewIsFeed();
}

/**
 * The clauses the browser evaluates, which is not always all of them.
 *
 * The text clause is the exception, and it is the one that has to be got right:
 * a row carries no description, so matching text here can only ever look at its
 * name. Where the server applied the same text — over the description too —
 * re-applying the name-only half would hide exactly the rows the search was
 * for. Every other clause is answerable from the row and stays local, which is
 * what makes a status change under the cursor take effect without a round trip.
 */
const localClauses = globalMemo(() =>
  searchScope() === "loaded"
    ? activeClauses()
    : activeClauses().filter((clause) => clause.field !== "search"),
);

/**
 * Search, filter clauses and grouping, shared by the list, the board and the
 * keyboard. Wrapped in `reuseItems` so an unchanged position keeps its wrapper
 * object — the windowed `<Index>` in the list keys on exactly that identity.
 */
export const flatItems = globalMemo((prev: FlatItem[] = []) =>
  reuseItems(
    prev,
    groupTasks(
      // The collection is additive on purpose, so a filter loosened and tightened
      // again has to be re-applied here: rows load once and never leave.
      selectRows(viewTasks(), {
        clauses: localClauses(),
        member: viewMembership(),
        showClosed: ui.showClosed || viewIsFeed(),
        named: namedStatuses(ui.filters),
        now: new Date(),
      }),
      viewIsFeed() ? "none" : ui.groupBy,
    ),
  ),
);

// --- what a filter can be built out of --------------------------------------

/**
 * The statuses of the list on screen, from its definition rather than its rows.
 *
 * This is the difference between a status menu that offers what the workspace
 * has and one that offers what happened to load. On the 5,696-task Bugs list a
 * view holds 500 rows, and a facet built from those 500 is a menu that silently
 * cannot name a status nobody in the first page is in.
 *
 * Empty for My Tasks and for any view spanning several lists, where there is no
 * single status set to be authoritative about — `filterOptions` falls back to
 * the rows there and says so.
 */
export const [viewStatuses, setViewStatuses] = createSignal<StatusDef[]>([]);

/**
 * Every Space the current view draws from, for the tag vocabulary.
 *
 * A set, not the first row's Space: My Tasks spans all of them, and answering
 * with whichever Space the top row happened to be in offered a menu that could
 * not name a tag on 118 of the rows below it while happily offering one used
 * once. A single list resolves to one Space and costs one request, as before.
 */
const viewSpaceIds = globalMemo(() => {
  const ids = new Set<string>();
  for (const task of viewTasks()) if (task.spaceId) ids.add(task.spaceId);
  return [...ids].sort();
});

const [spaceTags, setSpaceTags] = createSignal<Tag[]>([]);

/** One request per Space per session. A Space that fails contributes nothing. */
const spaceTagCache = new Map<string, Promise<Tag[]>>();

function tagsForSpace(spaceId: string): Promise<Tag[]> {
  const cached = spaceTagCache.get(spaceId);
  if (cached) return cached;
  const pending = api.spaceTags(spaceId).catch(() => {
    spaceTagCache.delete(spaceId);
    return [] as Tag[];
  });
  spaceTagCache.set(spaceId, pending);
  return pending;
}

/** Two Spaces can hold the same tag name; the menu should offer it once. */
export function uniqueTags(tags: Tag[]): Tag[] {
  const byName = new Map<string, Tag>();
  for (const tag of tags) if (!byName.has(tag.name)) byName.set(tag.name, tag);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
const [filterFields, setFilterFields] = createSignal<FilterField[]>([]);

export { filterFields };

createRoot(() => {
  createEffect(() => {
    const listId = viewListId();
    setFilterFields([]);
    if (!listId) {
      setViewStatuses([]);
      return;
    }
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    void api
      .statuses(listId)
      .then((defs) => !stale && setViewStatuses(defs))
      .catch(() => !stale && setViewStatuses([]));
  });

  /*
   * The Spaces' tags, which is every tag somebody could filter by rather than
   * every tag that turned up in the rows. Straight from ClickUp through the
   * API, like the tag picker on a task, because a tag nobody has used yet still
   * exists and one request per Space beats another table to keep in sync.
   *
   * Cached per Space for the session: the set changes as rows load, and a view
   * that spans six Spaces should not re-ask for all six each time it grows.
   */
  createEffect(() => {
    const spaceIds = viewSpaceIds();
    if (spaceIds.length === 0) {
      setSpaceTags([]);
      return;
    }
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    void Promise.all(spaceIds.map(tagsForSpace)).then((results) => {
      if (stale) return;
      setSpaceTags(uniqueTags(results.flat()));
    });
  });
});

/**
 * Reads the list's Custom Fields, once per list, when something asks.
 *
 * Not loaded with the list: it costs 28.7ms on the Bugs list and only the
 * filter menu wants it, which most people never open.
 */
let fieldsFor: string | null = null;

export function loadFilterFields(): void {
  const listId = viewListId();
  if (!listId || fieldsFor === listId) return;
  fieldsFor = listId;
  void api
    .filterFields(listId)
    .then((fields) => viewListId() === listId && setFilterFields(fields))
    .catch(() => setFilterFields([]));
}

export interface FacetOption {
  value: string;
  label: string;
  color?: string | null;
  statusType?: string | null;
}

/**
 * What each facet can be filtered by, and whether that answer is complete.
 *
 * `partial` is the honest bit. Every source here is authoritative — the list's
 * own status set, the Space's tags, the workspace directory, the sidebar tree —
 * except when there is no single list to be authoritative about, and then the
 * options come from the rows that happen to be loaded and the menu says so
 * rather than presenting a truncated vocabulary as the whole one.
 */
export const filterOptions = globalMemo(() => {
  const rows = viewTasks();

  const defs = viewStatuses();
  const statusesFromRows = defs.length === 0;
  const statuses: FacetOption[] = statusesFromRows
    ? uniqueBy(
        rows.flatMap((task) =>
          task.status
            ? [
                {
                  value: task.status,
                  label: task.status,
                  color: task.statusColor,
                  statusType: task.statusType,
                },
              ]
            : [],
        ),
      )
    : defs.map((def) => ({
        value: def.status,
        label: def.status,
        color: def.color ?? null,
        statusType: def.type ?? null,
      }));

  const known = spaceTags();
  const tagsFromRows = known.length === 0;
  const tags: FacetOption[] = tagsFromRows
    ? uniqueBy(
        rows.flatMap((task) =>
          task.tags.map((tag) => ({ value: tag.name, label: tag.name, color: tag.bg ?? null })),
        ),
      )
    : known.map((tag) => ({ value: tag.name, label: tag.name, color: tag.bg ?? null }));

  const directory = members();
  const assigneesFromRows = directory.length === 0;
  const assignees: FacetOption[] = assigneesFromRows
    ? uniqueBy(
        rows.flatMap((task) =>
          task.assignees.map((user) => ({ value: user.id, label: user.username ?? user.id })),
        ),
      )
    : directory.map((user) => ({ value: user.id, label: user.username ?? user.id }));

  const lists: FacetOption[] = spaces().flatMap((space) => [
    ...space.lists.map((list) => ({ value: list.id, label: list.name })),
    ...space.folders.flatMap((folder) =>
      folder.lists.map((list) => ({ value: list.id, label: `${folder.name} / ${list.name}` })),
    ),
  ]);

  return {
    statuses: statuses.sort(byLabel),
    tags: tags.sort(byLabel),
    assignees: assignees.sort(byLabel),
    lists: lists.sort(byLabel),
    partial: {
      status: statusesFromRows,
      tag: tagsFromRows,
      assignee: assigneesFromRows,
    },
  };
});

function byLabel(a: FacetOption, b: FacetOption): number {
  return a.label.localeCompare(b.label);
}

function uniqueBy(options: FacetOption[]): FacetOption[] {
  const seen = new Map<string, FacetOption>();
  for (const option of options) if (!seen.has(option.value)) seen.set(option.value, option);
  return [...seen.values()];
}

/** Tasks in display order, headers removed. The cursor indexes into this. */
export const rowTasks = globalMemo(() =>
  flatItems().flatMap((item: FlatItem) => (item.kind === "row" ? [item.task] : [])),
);

export function cursorTask(): Task | null {
  return rowTasks()[ui.cursor] ?? null;
}

/**
 * A keystroke asking the filter bar to open its builder.
 *
 * A counter rather than a boolean: pressing `F` twice in a row is two requests
 * and the second has to reopen the menu the first one left. The bar owns where
 * the popover goes, because the popover hangs off a button only the bar knows
 * the position of.
 */
export const [filterRequest, setFilterRequest] = createSignal(0);

/**
 * A row asking the shell to open the status menu for it.
 *
 * The shell owns every popover so there is only ever one open, but the click
 * originates deep inside a virtualized row. A signal beats threading a callback
 * through the list and the row.
 */
export const [statusRequest, setStatusRequest] = createSignal<{
  task: Task;
  anchor: { x: number; y: number };
} | null>(null);
