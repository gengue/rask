import {
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/solid-router";
import { createEffect, createMemo, type JSX } from "solid-js";
import { AppShell } from "./App.tsx";
import { TaskList } from "./components/TaskList.tsx";
import type { Task } from "./lib/api.ts";
import { useLiveTasks } from "./lib/live.ts";
import { listName, me } from "./lib/session.ts";
import { load } from "./lib/store.ts";
import { ui } from "./lib/ui.ts";
import { setStatusRequest, setViewListId, setViewTasks, setViewTitle } from "./lib/view.ts";

/**
 * Three routes. Which task is open is a search param rather than a path, so the
 * detail panel can overlay any view and the URL still deep-links to it.
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

function MyTasksView(): JSX.Element {
  createEffect(() => {
    setViewTitle("My Tasks");
    setViewListId(null);
    void load({ assignee: "me", closed: ui.showClosed });
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
    void load({ list: listId, closed: ui.showClosed });
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

const routeTree = rootRoute.addChildren([myTasksRoute, listRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
