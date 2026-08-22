import {
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/solid-router";
import { createEffect, createMemo, createResource, type JSX, Match, Switch } from "solid-js";
import { AppShell } from "./App.tsx";
import { TaskList } from "./components/TaskList.tsx";
import { ListPicker, NotFound } from "./components/Unresolved.tsx";
import { api, type ResolvedRef, type Task } from "./lib/api.ts";
import { parseClickUpPath } from "./lib/clickup-url.ts";
import { useLiveTasks } from "./lib/live.ts";
import { listName, me } from "./lib/session.ts";
import { load } from "./lib/store.ts";
import { ui } from "./lib/ui.ts";
import {
  setStatusRequest,
  setViewListId,
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

const clickUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  component: ClickUpView,
});

function MyTasksView(): JSX.Element {
  createEffect(() => {
    setViewTitle("My Tasks");
    setViewListId(null);
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

  return <ListBody />;
}

function ListView(): JSX.Element {
  const params = useParams({ from: listRoute.id });

  createEffect(() => {
    const listId = params().listId;
    setViewListId(listId);
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

  return <ListBody />;
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

function ListBody(): JSX.Element {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });

  return (
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
  );
}

const routeTree = rootRoute.addChildren([myTasksRoute, listRoute, clickUpRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
