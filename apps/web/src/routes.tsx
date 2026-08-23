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
  Show,
  Switch,
} from "solid-js";
import { AppShell } from "./App.tsx";
import { RouteError } from "./components/RouteError.tsx";
import { TaskList } from "./components/TaskList.tsx";
import { ListPicker, NotFound } from "./components/Unresolved.tsx";
import { UnsupportedView, ViewTabs } from "./components/ViewTabs.tsx";
import { api, type ListView as ListViewRow, type ResolvedRef, type Task } from "./lib/api.ts";
import { parseClickUpPath } from "./lib/clickup-url.ts";
import {
  applyView,
  clearListViews,
  isRenderable,
  listViews,
  listViewsOf,
  loadListViews,
} from "./lib/clickup-views.ts";
import { useLiveTasks } from "./lib/live.ts";
import { listName, me } from "./lib/session.ts";
import { load, loadViewTasks } from "./lib/store.ts";
import { ui } from "./lib/ui.ts";
import {
  setStatusRequest,
  setViewListId,
  setViewLoading,
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
}

const rootRoute = createRootRoute({
  component: AppShell,
  // A throw during render otherwise unmounts the entire tree and leaves a white
  // window until someone reloads.
  errorComponent: (props) => <RouteError error={props.error} reset={props.reset} />,
  validateSearch: (search: Record<string, unknown>): AppSearch => ({
    task: typeof search.task === "string" ? search.task : undefined,
  }),
});

const myTasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: MyTasksView,
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

const clickUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  component: ClickUpView,
});

function MyTasksView(): JSX.Element {
  createEffect(() => {
    setViewTitle("My Tasks");
    setViewListId(null);
    clearListViews();
    void load({ assignee: "me", closed: ui.showClosed }).then(setViewTruncated);
  });

  const rows = useLiveTasks(
    createMemo(() => {
      const userId = me()?.id;
      // Until /api/me lands, show what the server sent rather than nothing.
      return (task: Task) => !userId || task.assignees.some((a) => a.id === userId);
    }),
  );

  createEffect(() => setViewTasks(rows()));

  return <ListBody listId={null} activeViewId={null} />;
}

function ListView(): JSX.Element {
  const params = useParams({ from: listRoute.id });

  createEffect(() => {
    const listId = params().listId;
    setViewListId(listId);
    // The tabs are loaded here too, so they are already on screen when somebody
    // arrives from the sidebar rather than appearing a round trip later.
    void loadListViews(listId);
    void load({ list: listId, closed: ui.showClosed }).then(setViewTruncated);
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

  const [ids, setIds] = createSignal<ReadonlySet<string>>(new Set<string>());

  createEffect(() => {
    const listId = params().listId;
    setViewListId(listId);
    setViewTitle(listName(listId) ?? "List");
    void loadListViews(listId);
  });

  /**
   * One fetch per view.
   *
   * The tabs signal is replaced wholesale every time a list is opened, so the
   * effect below re-runs on an array that says the same thing. Without the
   * guard that is another round trip to ClickUp per navigation.
   */
  let loadedViewId: string | null = null;

  createEffect(() => {
    const current = view();
    if (current === undefined) return;

    if (!current || !isRenderable(current.type)) {
      loadedViewId = null;
      setIds(new Set<string>());
      setViewTasks([]);
      setViewTruncated(false);
      setViewLoading(false);
      return;
    }

    if (loadedViewId === current.id) return;
    loadedViewId = current.id;
    applyView(current);

    void loadViewTasks(current.id).then((page) => {
      // A second view was picked while this one was in flight.
      if (loadedViewId !== current.id) return;
      setIds(page.ids);
      setViewTruncated(page.truncated);
    });
  });

  const rows = useLiveTasks(
    createMemo(() => {
      const member = ids();
      return (task: Task) => member.has(task.id);
    }),
  );

  createEffect(() => setViewTasks(rows()));

  /** A view of a type Rask draws nothing for. Null for the ones it does. */
  const unsupported = (): ListViewRow | null => {
    const current = view();
    return current && !isRenderable(current.type) ? current : null;
  };

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
        void navigate({
          to: "/list/$listId",
          params: { listId: found.listId },
          search: { task: found.taskId },
          replace: true,
        });
        break;
      case "view":
        void navigate({
          to: "/list/$listId/view/$viewId",
          params: { listId: found.listId, viewId: found.viewId },
          replace: true,
        });
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

  return (
    <>
      <Show when={props.listId}>
        <ViewTabs activeViewId={props.activeViewId} />
      </Show>
      <TaskList
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

const routeTree = rootRoute.addChildren([myTasksRoute, listRoute, savedViewRoute, clickUpRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
