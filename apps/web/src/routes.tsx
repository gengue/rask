import {
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/solid-router";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { AppShell } from "./App.tsx";
import { Board } from "./components/Board.tsx";
import { RouteError } from "./components/RouteError.tsx";
import { TaskList } from "./components/TaskList.tsx";
import { TimesheetTable } from "./components/TimesheetTable.tsx";
import { ListPicker, NotFound } from "./components/Unresolved.tsx";
import { UnsupportedView, ViewTabs } from "./components/ViewTabs.tsx";
import { api, type ResolvedRef, type Task, type View } from "./lib/api.ts";
import { parseClickUpPath } from "./lib/clickup-url.ts";
import {
  applyView,
  clearListViews,
  isRenderable,
  listViews,
  listViewsOf,
  loadListViews,
} from "./lib/clickup-views.ts";
import {
  inboxCutoff,
  inboxPredicate,
  inboxScope,
  inboxSeenAt,
  inFeedOrder,
  loadInbox,
  resetFeedOrder,
} from "./lib/inbox.ts";
import { useLiveTasks } from "./lib/live.ts";
import { listName, me } from "./lib/session.ts";
import { viewRefresh } from "./lib/sse.ts";
import { load, loadViewTasks, type TaskPageResult } from "./lib/store.ts";
import {
  boardLayout,
  filterFieldIds,
  includeClosed,
  serverFilter,
  setSearchScope,
  setStatusRequest,
  setViewIsFeed,
  setViewIsMine,
  setViewListId,
  setViewLoading,
  setViewMembership,
  setViewTasks,
  setViewTitle,
  setViewTruncated,
} from "./lib/view.ts";

/**
 * Three routes plus a catch-all. Which task is open is a search param rather
 * than a path, so the detail panel can overlay any view and the URL still
 * deep-links to it.
 *
 * The catch-all exists so a ClickUp URL works with only the domain swapped:
 * anything Rask does not own is handed to the ClickUp resolver.
 */

interface AppSearch {
  task?: string;
  /**
   * Whether the open task fills the panel rather than sitting in its rail.
   *
   * Here and not in `lib/ui.ts` with the rest of the per-tab state because it
   * is part of what a shared link says. See `useExpanded` in `lib/nav.tsx`.
   */
  expanded?: boolean;
  /** Why the OAuth callback refused, when it did. See `components/Login.tsx`. */
  signin?: string;
}

/** What `?expanded=` may say for the answer to be yes. */
const TRUTHY = new Set<unknown>([true, 1, "1", "true"]);

const rootRoute = createRootRoute({
  component: AppShell,
  // A throw during render otherwise unmounts the entire tree and leaves a white
  // window until someone reloads. The adapter implements this with Solid's own
  // <ErrorBoundary> around the root match, so every child route lands here too —
  // a second boundary inside the shell would only shadow this one.
  errorComponent: (props) => <RouteError error={props.error} reset={props.reset} />,
  // The boundary swallows what it catches: without this, a production crash
  // leaves the fallback on screen and nothing in the console to debug it by.
  onCatch: (error) => console.error(error),
  validateSearch: (search: Record<string, unknown>): AppSearch => ({
    task: typeof search.task === "string" ? search.task : undefined,
    // `1` as readily as `true`, because this one gets typed by hand into a URL
    // somebody is about to paste into chat. The router JSON-parses values, so
    // both arrive already coerced and the string forms are for what it cannot.
    expanded: TRUTHY.has(search.expanded) ? true : undefined,
    signin: typeof search.signin === "string" ? search.signin : undefined,
  }),
});

const myTasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: MyTasksView,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxView,
});

const timesheetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/timesheet",
  component: TimesheetView,
});

const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/list/$listId",
  component: ListView,
});

/**
 * One of the list's ClickUp views.
 *
 * A sibling of the list route rather than a child of it, because the two load
 * different things: the list reads the mirror, a view reads ClickUp through it.
 * The view id is in the path so a filtered view is a link somebody can send.
 */
const savedViewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/list/$listId/view/$viewId",
  component: SavedView,
});

/**
 * A view that hangs off something bigger than a List.
 *
 * ClickUp lets a view live on a Workspace, a Space or a Folder, and draws all
 * four levels at the same `/{team}/v/l/{id}`. The rows then come from every
 * list under that container rather than one, so there is no list to put in the
 * path here and no tab bar to sit above it — the view id is the whole address.
 */
const viewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/view/$viewId",
  component: ContainerView,
});

const clickUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  component: ClickUpView,
});

/**
 * What a finished fetch tells the view.
 *
 * Two things: whether more rows matched than were sent, and — only when a
 * filter was asked for — which rows those were. Without a filter the view keeps
 * showing everything loaded for it, including rows SSE brought in afterwards,
 * which is what it has always done. With one, the set is the server's answer;
 * see `viewMembership`.
 */
function applyPage(filter: string) {
  return (page: TaskPageResult | null) => {
    if (!page) return;
    setViewTruncated(page.truncated);
    setViewMembership(filter ? page.ids : null);
  };
}

function MyTasksView(): JSX.Element {
  createEffect(() => {
    setViewTitle("My Tasks");
    setViewListId(null);
    setSearchScope("server");
    // Already assignee=me below, so the quick filter has nothing left to narrow.
    setViewIsMine(true);
    clearListViews();
    // Reading `serverFilter()` here is what makes a filter change refetch: the
    // clauses are applied over the whole set, not over the page already loaded.
    void load({ assignee: "me", closed: includeClosed(), filter: serverFilter() }).then(
      applyPage(serverFilter()),
    );
  });

  const rows = useLiveTasks(
    createMemo(() => {
      const userId = me()?.id;
      // Until /api/me lands, show what the server sent rather than nothing.
      return (task: Task) => !userId || task.assignees.some((a) => a.id === userId);
    }),
  );

  createEffect(() => setViewTasks(rows()));

  onCleanup(() => setViewIsMine(false));

  return <ListBody listId={null} activeViewId={null} />;
}

/**
 * What changed on your tasks while you were away.
 *
 * Not a mirror of ClickUp's inbox — there is no endpoint for that one, in
 * either direction — but a query over the mirror we already keep. `lib/inbox.ts`
 * has the reasoning and the ceiling.
 *
 * Arriving is what marks it read, the way opening any inbox is. The instant it
 * was read up to is captured first and held for as long as the page is on
 * screen, so the dots stay where they were while you are still looking at them.
 */
function InboxView(): JSX.Element {
  /*
   * The window is captured once, when we first know who is asking.
   *
   * Marking the inbox read moves `inboxSeenAt` to now, which would narrow
   * `inboxCutoff` to the plain seven-day window under somebody who had been
   * away a fortnight — the rows they came here for, disappearing as they
   * cleared them. Frozen, the page they are looking at stays the page they
   * opened.
   */
  const [cutoff, setCutoff] = createSignal<number | null>(null);
  let captured = false;

  createEffect(() => {
    // Deep-linking to /inbox mounts this before the session has landed, and a
    // window measured from "now" is the wrong thing to freeze.
    if (captured || !me()) return;
    captured = true;
    setCutoff(inboxCutoff());
  });

  createEffect(() => {
    setViewTitle("Inbox");
    setViewListId(null);
    setSearchScope("server");
    // Chronological, closed tasks included, no board. See `viewIsFeed`.
    setViewIsFeed(true);
    clearListViews();

    const since = cutoff();
    // The skeleton covers the gap before the session lands, the same way it
    // covers the fetch after. Left alone, a deep link to /inbox draws "nothing
    // here" for as long as `/api/me` takes.
    if (since === null) setViewLoading(true);
    else void loadInbox(since).then(applyPage(""));
  });

  onCleanup(() => {
    setViewIsFeed(false);
    resetFeedOrder();
  });

  const rows = useLiveTasks(
    createMemo(() => {
      const since = cutoff();
      // Nothing rather than everything until the window is known: the rows are
      // in the shared collection already, and an unfiltered flash of every task
      // the session has loaded is not what this page is.
      if (since === null) return () => false;

      /*
       * Two scopes over one loaded set.
       *
       * Both read the same rows and differ only in where they measure from, so
       * switching is free and Mark all read empties the unread one on the spot
       * — which is the only thing on screen that says the button worked.
       */
      return inboxPredicate(me()?.id, inboxScope() === "unread" ? inboxSeenAt() : since);
    }),
  );

  /*
   * Sorted here rather than in the predicate, because `useLiveTasks` filters an
   * unordered map — and sorted into the order the feed is *holding* rather than
   * by recency, which is what stops a row sliding out from under the pointer
   * every time somebody touches its task. `inFeedOrder` has the reasoning.
   */
  createEffect(() => setViewTasks(inFeedOrder(rows())));

  return <ListBody listId={null} activeViewId={null} />;
}

/**
 * The week you tracked, laid out as a grid.
 *
 * Not one of the mirror-backed views: rows are this person's time entries,
 * fetched live and grouped server-side, so there is nothing to register for
 * polling and nothing SSE brings while the page is open. The shell's header
 * still claims a title and an empty set — this route owns both honestly.
 */
function TimesheetView(): JSX.Element {
  createEffect(() => {
    setViewTitle("My Timesheet");
    setViewListId(null);
    setSearchScope("loaded");
    setViewTasks([]);
    setViewTruncated(false);
    setViewMembership(null);
    clearListViews();
  });

  return <TimesheetTable />;
}

function ListView(): JSX.Element {
  const params = useParams({ from: listRoute.id });

  createEffect(() => {
    const listId = params().listId;
    setViewListId(listId);
    setSearchScope("server");
    // The tabs are loaded here too, so they are already on screen when somebody
    // arrives from the sidebar rather than appearing a round trip later.
    void loadListViews(listId);
    void load({ list: listId, closed: includeClosed(), filter: serverFilter() }).then(
      applyPage(serverFilter()),
    );
  });

  const rows = useLiveTasks(
    createMemo(() => {
      const listId = params().listId;
      return (task: Task) => task.listId === listId;
    }),
  );

  createEffect(() => {
    setViewTasks(rows());
    setViewTitle(listName(params().listId) ?? rows()[0]?.listName ?? "List");
  });

  // No tab is current: this is the whole list, which is not one of ClickUp's
  // views. The sidebar entry is what points here.
  return <ListBody listId={params().listId} activeViewId={null} />;
}

/**
 * The rows of one ClickUp view, and the bookkeeping that keeps them honest.
 *
 * Shared by the two routes that show a view — a tab on a List, and a view
 * opened at its own address — because the difference between them is chrome.
 * A tab bar, a title, whether there is a list in the path: none of that is
 * here. What is here is the part that would rot if it were written twice.
 *
 * The argument is three-valued on purpose. `undefined` means the view has not
 * arrived yet, `null` means it arrived and there is no such view, and without
 * the distinction a slow fetch renders "not found" for a view that exists.
 *
 * Returns the view when it is one Rask draws nothing for, and null otherwise,
 * which is the one thing the caller still has to render differently.
 */
function viewRows(view: () => View | null | undefined): () => View | null {
  const [ids, setIds] = createSignal<ReadonlySet<string>>(new Set<string>());

  // Once, not per view: nothing else writes either of these while a view route
  // is mounted, and switching tabs within one does not remount it.
  createEffect(() => {
    // A view's rows are ClickUp's answer to its filters, so `/` narrows what is
    // in hand rather than going back for more.
    setSearchScope("loaded");
    // A view already has a membership set of its own — the ids ClickUp
    // returned — and the filter is evaluated over those rows here rather than
    // pushed down, so the shared one must not also be in force.
    setViewMembership(null);
  });

  /**
   * One fetch per view, and one more when the filter names a Custom Field.
   *
   * The tabs signal is replaced wholesale every time a list is opened, so the
   * effect below re-runs on an array that says the same thing. Without the
   * guard that is another round trip to ClickUp per navigation.
   *
   * The key carries the Custom Field ids rather than the whole filter, because
   * a view's rows have to be re-read to carry values for a field nobody asked
   * about before — and re-reading means asking ClickUp, at 1.8s a page. Every
   * other clause is answered from the rows already here, so typing in `/` costs
   * nothing on a saved view.
   */
  let loadedKey: string | null = null;

  createEffect(() => {
    const current = view();
    if (current === undefined) {
      // The definition is still in flight, and the rows cannot be asked for
      // until it lands. Skeleton, not "Nothing here": this gap sat unnoticed
      // for as long as the rows themselves took seconds — the walk's skeleton
      // swallowed it — and became the whole wait once a remembered view
      // started answering in milliseconds.
      setViewLoading(true);
      return;
    }

    if (!current || !isRenderable(current.type)) {
      loadedKey = null;
      setIds(new Set<string>());
      setViewTasks([]);
      setViewTruncated(false);
      setViewLoading(false);
      return;
    }

    const key = `${current.id}|${filterFieldIds()}`;
    if (loadedKey === key) return;
    const first = loadedKey === null || !loadedKey.startsWith(`${current.id}|`);
    loadedKey = key;
    if (first) applyView(current);

    void loadViewTasks(current.id, serverFilter()).then((page) => {
      // A second view was picked while this one was in flight. `null` is the
      // store saying the same thing; either answer means these rows are stale.
      if (!page || loadedKey !== key) return;
      setIds(page.ids);
      setViewTruncated(page.truncated);
    });
  });

  /*
   * The server's repair, landing after its answer. A view route paints from
   * the last walk; the fresh one arrives here over SSE, addressed by view id
   * so a push that outlives a navigation is ignored rather than applied to
   * whatever view happens to be mounted. No skeleton: the rows on screen are
   * already the view, this only moves the edges.
   */
  createEffect(() => {
    const refresh = viewRefresh();
    const current = view();
    if (!refresh || !current || refresh.viewId !== current.id) return;
    setIds(refresh.ids);
    setViewTruncated(refresh.truncated);
  });

  const rows = useLiveTasks(
    createMemo(() => {
      const member = ids();
      return (task: Task) => member.has(task.id);
    }),
  );

  createEffect(() => setViewTasks(rows()));

  /** A view of a type Rask draws nothing for. Null for the ones it does. */
  return () => {
    const current = view();
    return current && !isRenderable(current.type) ? current : null;
  };
}

/**
 * One ClickUp view of a list.
 *
 * The tasks come from `GET /view/{id}/task` through the API, already filtered
 * by ClickUp, and arrive as an explicit set of ids rather than as a predicate:
 * a view is a subset the browser has no way to recompute. The grouping is the
 * one part Rask applies itself.
 */
function SavedView(): JSX.Element {
  const params = useParams({ from: savedViewRoute.id });

  /**
   * The view this route is showing.
   *
   * `undefined` while the list's tabs are in flight, `null` once they have
   * arrived without it. Without the distinction a slow tab fetch would render
   * "not found" for a view that exists.
   */
  const view = createMemo(() => {
    const { listId, viewId } = params();
    if (listViewsOf() !== listId) return undefined;
    return listViews().find((candidate) => candidate.id === viewId) ?? null;
  });

  createEffect(() => {
    const listId = params().listId;
    setViewListId(listId);
    setViewTitle(listName(listId) ?? "List");
    void loadListViews(listId);
  });

  const unsupported = viewRows(view);

  // The tabs stay above every outcome, including the ones that render no
  // tasks: a view Rask cannot draw is still a place in the list, and the way
  // out of it is the tab next to it.
  return (
    <>
      <ViewTabs activeViewId={view() === null ? null : params().viewId} />
      <Switch
        fallback={
          /* `list` renders as the list, and so does `board` until the board
             component lands — the view's `type` is already here, so switching
             it on is one branch and no further plumbing. */
          <ListBody listId={null} activeViewId={null} />
        }
      >
        <Match when={view() === null}>
          <NotFound path={`/list/${params().listId}/view/${params().viewId}`} />
        </Match>
        <Match when={unsupported()}>{(current) => <UnsupportedView view={current()} />}</Match>
      </Switch>
    </>
  );
}

/**
 * One ClickUp view with no List behind it.
 *
 * The same rows as a tab, fetched the same way, minus everything that needed a
 * list: no tab bar, no list in the path, and no list registered for polling.
 * `ListBody` already draws a set of tasks spanning many lists — My Tasks is
 * one — so the difference from `SavedView` is only where the view comes from.
 *
 * It comes from the API a view at a time, because there is no tab bar above
 * this route to have carried it down. `createResource` reports `undefined`
 * while that is in flight, which is the same "not yet" the tab route spells
 * with `listViewsOf`, and `null` for a view ClickUp does not know either.
 */
function ContainerView(): JSX.Element {
  const params = useParams({ from: viewRoute.id });

  const [view] = createResource(
    () => params().viewId,
    (viewId) => api.view(viewId).catch(() => null),
  );

  createEffect(() => {
    // Nothing here belongs to one list, so the shell must not claim one: the
    // header's list name, the tab bar, and Quick Add's target all read this.
    params().viewId;
    setViewListId(null);
    clearListViews();
    // And nothing on screen belongs to this view yet. Whatever route came
    // before left its rows in the store, and without this the header counts
    // them under this view's name until the first page lands.
    setViewTasks([]);
    setViewTruncated(false);
  });

  createEffect(() => {
    const current = view();
    // Three states, three titles: in flight, no such view, and the view's own
    // name. Without the middle one the header says "Opening…" over a screen
    // that has already given up.
    setViewTitle(current === undefined ? "Opening…" : (current?.name ?? "Not found"));
  });

  const unsupported = viewRows(view);

  return (
    <Switch fallback={<ListBody listId={null} activeViewId={null} />}>
      <Match when={view() === null}>
        <NotFound path={`/view/${params().viewId}`} />
      </Match>
      <Match when={unsupported()}>{(current) => <UnsupportedView view={current()} />}</Match>
    </Switch>
  );
}

type Target = ResolvedRef | { kind: "my-work" };

/**
 * Any path Rask does not own, read as a ClickUp URL with the domain swapped.
 *
 * The ids come out of the path here, the mirror says what they are, and the
 * route is chosen from that. A task redirects to its own list with the detail
 * panel open, so the panel keeps its list context and the list loads behind it.
 */
function ClickUpView(): JSX.Element {
  const params = useParams({ from: clickUpRoute.id });
  const navigate = useNavigate();
  // Null while the router is between locations, which is when the splat is
  // briefly empty. Resolving that would be resolving "/".
  const path = (): string | null => {
    const splat = (params() as { _splat?: string })._splat;
    return splat ? `/${splat}` : null;
  };

  const [target] = createResource<Target, string>(path, async (input) => {
    const parsed = parseClickUpPath(input);
    if (parsed.kind !== "lookup") return parsed;
    return api.resolve(parsed.ids, parsed.remote).catch(() => ({ kind: "unknown" }) as const);
  });

  createEffect(() => {
    // This route renders no list, so the header must stop claiming the previous
    // view's title and row count while the lookup is in flight.
    path();
    setViewTitle("Opening…");
    setViewTasks([]);
    setViewListId(null);
    setViewTruncated(false);
    setViewMembership(null);
    clearListViews();
  });

  /**
   * One redirect per address. Committing a location writes router signals, this
   * effect reads them through the params, and without the guard the second run
   * navigates again on top of the first until the stack gives out.
   */
  let redirectedFrom: string | null = null;

  createEffect(() => {
    const from = path();
    const found = target();
    if (!from || !found || redirectedFrom === from) return;
    redirectedFrom = from;

    switch (found.kind) {
      case "my-work":
        void navigate({ to: "/", replace: true });
        break;
      case "task":
        // A ClickUp task URL names the task, not the list behind it: whoever
        // followed it came for the task, so open it expanded rather than as a
        // rail beside rows they did not ask for.
        void navigate({
          to: "/list/$listId",
          params: { listId: found.listId },
          search: { task: found.taskId, expanded: true },
          replace: true,
        });
        break;
      case "view":
        // A view with no list has no list route to land on, and no better
        // address than its own id — which is all ClickUp's URL carried either.
        void navigate(
          found.listId
            ? {
                to: "/list/$listId/view/$viewId",
                params: { listId: found.listId, viewId: found.viewId },
                replace: true,
              }
            : { to: "/view/$viewId", params: { viewId: found.viewId }, replace: true },
        );
        break;
      case "list":
        void navigate({ to: "/list/$listId", params: { listId: found.listId }, replace: true });
        break;
      default:
        setViewTitle(found.kind === "unknown" ? "Not found" : found.name);
    }
  });

  /** Folders and Spaces have no Rask view; they get a list to pick from. */
  const picker = () => {
    const found = target();
    if (found?.kind === "folder") return { kind: found.kind, id: found.folderId, name: found.name };
    if (found?.kind === "space") return { kind: found.kind, id: found.spaceId, name: found.name };
    return null;
  };

  return (
    <Switch fallback={<div class="flex-1 px-6 pt-[18vh] text-sm text-ink-4">Opening…</div>}>
      <Match when={picker()}>
        {(chosen) => <ListPicker kind={chosen().kind} id={chosen().id} name={chosen().name} />}
      </Match>
      <Match when={target()?.kind === "unknown"}>
        <NotFound path={path() ?? "/"} />
      </Match>
    </Switch>
  );
}

function ListBody(props: { listId: string | null; activeViewId: string | null }): JSX.Element {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });

  // Rows or columns over the same tasks, the same cursor and the same writes.
  // Nothing else here changes, which is the point of the two taking identical
  // props: this stays one line the day a view decides which layout it wants.
  return (
    <>
      <Show when={props.listId}>
        <ViewTabs activeViewId={props.activeViewId} />
      </Show>
      <Dynamic
        component={boardLayout() ? Board : TaskList}
        openTaskId={(search() as { task?: string }).task ?? null}
        onOpen={(task) =>
          navigate({
            to: ".",
            search: (prev: Record<string, unknown>) => ({ ...prev, task: task.id }),
          })
        }
        onStatusClick={(task, event) => {
          const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
          setStatusRequest({
            task,
            anchor: { x: rect?.left ?? event.clientX, y: (rect?.bottom ?? event.clientY) + 6 },
          });
        }}
      />
    </>
  );
}

const routeTree = rootRoute.addChildren([
  myTasksRoute,
  inboxRoute,
  timesheetRoute,
  listRoute,
  savedViewRoute,
  viewRoute,
  clickUpRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
