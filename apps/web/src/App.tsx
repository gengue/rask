import { Outlet, useNavigate, useSearch } from "@tanstack/solid-router";
import { createEffect, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import {
  buildNavigationCommands,
  type Command,
  CommandPalette,
} from "./components/CommandPalette.tsx";
import { FilterBar } from "./components/FilterBar.tsx";
import { Lightbox } from "./components/Lightbox.tsx";
import { Menu, type MenuItem } from "./components/Menu.tsx";
import { QuickAdd } from "./components/QuickAdd.tsx";
import { Shortcuts } from "./components/Shortcuts.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusIcon } from "./components/StatusIcon.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { api, type StatusDef, type Task } from "./lib/api.ts";
import { boardColumns, nextCursor, shiftColumn } from "./lib/board.ts";
import { PRIORITY_LABELS } from "./lib/format.ts";
import { lightboxOpen } from "./lib/lightbox.ts";
import { loadSession, me, reloadHierarchy, spaces } from "./lib/session.ts";
import { connect } from "./lib/sse.ts";
import { tasks } from "./lib/store.ts";
import { setTheme, THEMES, themeChoice } from "./lib/theme.ts";
import { clearFilters, closeOverlays, setUi, ui } from "./lib/ui.ts";
import {
  cursorTask,
  rowTasks,
  searchScope,
  setFilterRequest,
  setStatusRequest,
  statusRequest,
  viewListId,
  viewTitle,
  viewTruncated,
} from "./lib/view.ts";

/**
 * The shell: sidebar, main panel, detail panel, and the one keyboard listener
 * the whole app shares.
 *
 * Keeping shortcuts in a single place is what makes them predictable. Each
 * handler acts on "the task under the cursor" via the view module, so no
 * component has to thread selection state down to a button.
 */
export function AppShell(): JSX.Element {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });

  onMount(() => void loadSession());

  const [menu, setMenu] = createSignal<{
    kind: "status" | "priority";
    task: Task;
    anchor: { x: number; y: number };
    statuses: StatusDef[];
  } | null>(null);

  let searchInput: HTMLInputElement | undefined;
  const [searching, setSearching] = createSignal(false);
  const openTaskId = () => (search() as { task?: string }).task ?? null;

  onCleanup(connect());

  const openTask = (task: Task) =>
    navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, task: task.id }) });

  const closeTask = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, task: undefined }),
    });

  const openStatusMenu = async (task: Task, anchor: { x: number; y: number }) => {
    const statuses = await api.statuses(task.listId).catch(() => []);
    setMenu({ kind: "status", task, statuses, anchor });
    setUi("menu", "status");
  };

  // Rows and the detail panel ask for the menu; the shell is the only thing
  // that opens one, so two can never be up at once.
  createEffect(() => {
    const request = statusRequest();
    if (!request) return;
    setStatusRequest(null);
    void openStatusMenu(request.task, request.anchor);
  });

  /**
   * Where a menu opened by keystroke should appear.
   *
   * Anchoring at the middle of the screen put the menu 800px from the row you
   * were looking at. The row carries its own id, so use it; every mouse path
   * already anchors this way.
   */
  const anchorForCursor = (): { x: number; y: number } => {
    const task = cursorTask();
    const rect = task ? document.getElementById(`task-${task.id}`)?.getBoundingClientRect() : null;
    if (!rect) return { x: window.innerWidth / 2 - 120, y: 180 };
    return { x: rect.left + 44, y: rect.bottom + 4 };
  };

  const closeMenu = () => {
    setMenu(null);
    setUi("menu", null);
  };

  const applyStatus = (task: Task, status: StatusDef) => {
    tasks.update(task.id, (draft) => {
      draft.status = status.status;
      draft.statusColor = status.color ?? null;
      draft.statusType = status.type ?? null;
    });
    closeMenu();
  };

  const applyPriority = (task: Task, priority: number | null) => {
    tasks.update(task.id, (draft) => {
      draft.priority = priority;
    });
    closeMenu();
  };

  // --- keyboard ----------------------------------------------------------

  let lastKey = "";
  const onKeyDown = (event: KeyboardEvent) => {
    // The lightbox is modal and owns every key while it is up, Escape and the
    // arrows included. Without this, closing it also collapsed the panel behind
    // it and the arrow keys moved the cursor in the list nobody could see.
    if (lightboxOpen()) return;

    const target = event.target as HTMLElement;
    const typing =
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      closeOverlays();
      setUi("palette", true);
      return;
    }

    if (event.key === "Escape") {
      // `ui.menu` and not just `menu()`: the second is the shell's own status
      // and priority popovers, the first is any keystroke-driven menu including
      // the filter builder, which lives in the header. Without it, Escape out
      // of a half-built clause fell through to the last branch and threw away
      // every filter on screen.
      if (ui.palette || ui.quickAdd || ui.shortcuts || ui.menu || menu()) {
        closeOverlays();
        closeMenu();
      } else if (ui.sidebarOpen) {
        // The drawer is the topmost thing on screen when it is up, so it backs
        // out before the detail sheet underneath it.
        setUi("sidebarOpen", false);
      } else if (searching()) {
        setSearching(false);
        setUi("search", "");
      } else if (ui.taskExpanded) {
        // Collapse before closing: Escape should undo one step, not two.
        setUi("taskExpanded", false);
      } else if (openTaskId()) {
        closeTask();
      } else {
        clearFilters();
      }
      return;
    }

    // Everything below is a bare key. Typing in a field always wins.
    if (typing || ui.palette || ui.quickAdd || ui.shortcuts || ui.menu || menu()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key;
    const task = cursorTask();
    const max = Math.max(0, rowTasks().length - 1);

    switch (key) {
      case "g":
        // gg jumps to the top, vim style.
        if (lastKey === "g") {
          event.preventDefault();
          setUi("cursor", 0);
          lastKey = "";
          return;
        }
        break;
      case "G":
        event.preventDefault();
        setUi("cursor", max);
        break;
      case "Enter":
      case "o":
        if (task) {
          event.preventDefault();
          openTask(task);
        }
        break;
      case "/":
        event.preventDefault();
        setSearching(true);
        queueMicrotask(() => searchInput?.focus());
        break;
      case ":":
        event.preventDefault();
        setUi("palette", true);
        break;
      case "c":
        event.preventDefault();
        setUi("quickAdd", true);
        break;
      case "s":
        if (task) {
          event.preventDefault();
          void openStatusMenu(task, anchorForCursor());
        }
        break;
      case "p":
        if (task) {
          event.preventDefault();
          setMenu({ kind: "priority", task, statuses: [], anchor: anchorForCursor() });
          setUi("menu", "priority");
        }
        break;
      case "f":
        if (openTaskId()) {
          event.preventDefault();
          setUi("taskExpanded", !ui.taskExpanded);
        }
        break;
      case "F":
        // Shifted because `f` already expands the open task. Both are "f for
        // …" and only one of them can have the bare key.
        event.preventDefault();
        setFilterRequest((count) => count + 1);
        break;
      case "?":
        event.preventDefault();
        setUi("shortcuts", true);
        break;
      case "b":
        event.preventDefault();
        setUi("layout", ui.layout === "board" ? "list" : "board");
        break;
      case "H":
      case "L":
        // The keyboard's drag: the same write, one column over.
        if (task && ui.layout === "board") {
          event.preventDefault();
          shiftColumn(task, key === "L" ? 1 : -1);
        }
        break;
      default: {
        /*
         * One cursor, two readings. In the list it is a position in a single
         * flat run and only j/k move it; on the board the same index is a
         * column plus a depth, so h/l cross to the neighbour at the same depth.
         * Null means the key moves nothing here and belongs to the browser.
         */
        const next = nextCursor(
          key,
          ui.cursor,
          rowTasks().length,
          ui.layout === "board" ? boardColumns() : null,
        );
        if (next !== null) {
          event.preventDefault();
          setUi("cursor", next);
        }
      }
    }

    lastKey = key;
  };

  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  // Reset per-view state when the view changes; row 4 of the old list means
  // nothing in the new one, and picking a list is the drawer's whole job.
  createEffect(() => {
    viewTitle();
    setUi({ cursor: 0, sidebarOpen: false });
  });

  const commands = (): Command[] => [
    ...buildNavigationCommands(spaces(), (listId) =>
      navigate({ to: "/list/$listId", params: { listId } }),
    ),
    {
      id: "nav:my-tasks",
      label: "My Tasks",
      section: "Go to",
      hint: "",
      run: () => navigate({ to: "/" }),
    },
    {
      id: "view:layout",
      label: ui.layout === "board" ? "List view" : "Board view",
      section: "View",
      hint: "b",
      run: () => setUi("layout", ui.layout === "board" ? "list" : "board"),
    },
    ...(["status", "due", "assignee", "priority", "list", "none"] as const).map((groupBy) => ({
      id: `group:${groupBy}`,
      label: `Group by ${groupBy === "none" ? "nothing" : groupBy}`,
      section: "View",
      run: () => setUi("groupBy", groupBy),
    })),
    {
      id: "view:search",
      label: "Search this view",
      section: "View",
      hint: "/",
      run: () => {
        setSearching(true);
        queueMicrotask(() => searchInput?.focus());
      },
    },
    {
      id: "view:filter",
      label: "Add a filter",
      section: "View",
      hint: "F",
      run: () => setFilterRequest((count) => count + 1),
    },
    {
      id: "view:clear-filters",
      label: "Clear all filters",
      section: "View",
      hint: "esc",
      run: clearFilters,
    },
    {
      id: "view:closed",
      label: ui.showClosed ? "Hide closed tasks" : "Show closed tasks",
      section: "View",
      run: () => setUi("showClosed", !ui.showClosed),
    },
    /*
     * The theme lives here rather than behind a settings page, because there
     * is no settings page and one switch does not justify inventing one. The
     * palette is where every other action in the app already is.
     */
    ...THEMES.map(([value, label]) => ({
      id: `theme:${value}`,
      label: `Theme: ${label}`,
      section: "Appearance",
      hint: themeChoice() === value ? "on" : "",
      run: () => setTheme(value),
    })),
    {
      id: "task:new",
      label: "New task",
      section: "Task",
      hint: "c",
      run: () => setUi("quickAdd", true),
    },
    {
      id: "task:status",
      label: "Change status",
      section: "Task",
      hint: "s",
      run: () => {
        const target = cursorTask();
        if (target) void openStatusMenu(target, anchorForCursor());
      },
    },
    {
      id: "task:priority",
      label: "Set priority",
      section: "Task",
      hint: "p",
      run: () => {
        const target = cursorTask();
        if (!target) return;
        setMenu({ kind: "priority", task: target, statuses: [], anchor: anchorForCursor() });
        setUi("menu", "priority");
      },
    },
    {
      id: "help:shortcuts",
      label: "Keyboard shortcuts",
      section: "Help",
      hint: "?",
      run: () => setUi("shortcuts", true),
    },
    ...(viewListId()
      ? [
          {
            id: "list:resync",
            label: "Resync this list from ClickUp",
            section: "List",
            run: () => {
              void api.resync(viewListId() ?? "");
              void reloadHierarchy();
            },
          },
        ]
      : []),
  ];

  /** Workspace-wide task search, folded into the palette. */
  const searchTasks = async (query: string): Promise<Command[]> => {
    const hits = await api.search(query);
    return hits.map((hit) => ({
      id: `task:${hit.id}`,
      label: hit.name,
      section: hit.listName ?? "Task",
      hint: hit.customId ?? "",
      run: () =>
        navigate({
          to: "/list/$listId",
          params: { listId: hit.listId },
          search: { task: hit.id },
        }),
    }));
  };

  const menuItems = (): MenuItem[] => {
    const current = menu();
    if (!current) return [];
    if (current.kind === "priority") {
      return [
        ...[1, 2, 3, 4].map((priority) => ({
          id: String(priority),
          label: PRIORITY_LABELS[priority] ?? String(priority),
        })),
        { id: "none", label: "No priority" },
      ];
    }
    return current.statuses.map((status) => ({
      id: status.status,
      label: status.status,
      icon: <StatusIcon type={status.type ?? null} color={status.color ?? null} size={13} />,
    }));
  };

  return (
    // `relative` is what the two narrow-window overlays are positioned
    // against: the sidebar drawer below `dock` and its scrim.
    <div class="relative flex h-full overflow-hidden">
      <Sidebar
        me={me()}
        spaces={spaces()}
        open={ui.sidebarOpen}
        onSearch={() => {
          setSearching(true);
          queueMicrotask(() => searchInput?.focus());
        }}
        onQuickAdd={() => setUi("quickAdd", true)}
      />

      <Show when={ui.sidebarOpen}>
        <button
          type="button"
          aria-label="Close"
          class="absolute inset-0 z-30 bg-scrim dock:hidden"
          onClick={() => setUi("sidebarOpen", false)}
        />
      </Show>

      {/* `relative` for the detail sheet below `split`; `ml-2` because below
          `dock` the sidebar is no longer providing the left gutter. */}
      <main class="relative mt-2 mr-2 mb-2 flex min-w-0 flex-1 overflow-hidden rounded-[10px] border border-line bg-panel max-dock:ml-2">
        {/* The expanded task takes the whole panel; the list is still there,
            one Escape away. */}
        <div class="flex min-w-0 flex-1 flex-col" classList={{ hidden: ui.taskExpanded }}>
          <header class="flex h-12 shrink-0 items-center gap-3 border-line/70 border-b px-5">
            {/* The only way back to the workspace tree for a mouse below
                `dock`, where the sidebar is a drawer. */}
            <button
              type="button"
              title="Navigation"
              aria-label="Show navigation"
              aria-expanded={ui.sidebarOpen}
              onClick={() => setUi("sidebarOpen", true)}
              class="-ml-1 flex size-6 shrink-0 items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover hover:text-ink dock:hidden"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <g stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
                  <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.8" />
                  <path d="M6.4 3.2v9.6" />
                </g>
              </svg>
            </button>

            {/* The chips stay on screen while the box is open. A filter you
                cannot see is a filter you forget you set, and typing in `/` is
                exactly when the row of clauses above the results matters. */}
            <Show
              when={searching()}
              fallback={
                <>
                  <h1 class="truncate font-medium text-base text-ink tracking-[-0.005em]">
                    {viewTitle()}
                  </h1>
                  <span
                    class="shrink-0 rounded bg-chip px-1.5 text-xs text-ink-3 tabular-nums"
                    title={
                      viewTruncated()
                        ? "More tasks match than were loaded"
                        : "Tasks matching this filter"
                    }
                  >
                    {rowTasks().length}
                    {viewTruncated() ? "+" : ""}
                  </span>
                  <div class="flex-1" />
                </>
              }
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                class="shrink-0 text-ink-3"
                aria-hidden="true"
              >
                <path
                  d="M11.5 11.5 14 14M13 7.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                />
              </svg>
              <input
                ref={searchInput}
                value={ui.search}
                onInput={(event) => setUi("search", event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearching(false);
                    setUi("search", "");
                    (event.currentTarget as HTMLInputElement).blur();
                  }
                  event.stopPropagation();
                }}
                /* Says what it reads, and the two answers are different. It
                   used to match the loaded rows by name and nothing else, so a
                   word that only appears in a description found nothing and
                   looked like an answer. */
                placeholder={
                  searchScope() === "server"
                    ? "Search name, id and description…"
                    : "Search these results by name or id…"
                }
                class="h-full min-w-0 flex-1 text-base"
              />
              <button
                type="button"
                onClick={() => {
                  setSearching(false);
                  setUi("search", "");
                }}
                class="shrink-0 text-ink-4 text-xs hover:text-ink-2"
              >
                esc
              </button>
            </Show>

            <FilterBar />
            <span class="h-3.5 w-px shrink-0 bg-line-strong" />
            <GroupPicker />
          </header>

          <Outlet />
        </div>

        <Show when={openTaskId()}>
          {(taskId) => (
            <>
              {/* Below `split` the panel is a sheet over the list rather than a
                  sibling that takes 420px off it, so it needs a scrim. Not when
                  expanded: the list is display:none behind it and there is
                  nothing to dim.

                  It starts below the header — the same 48px the header is tall
                  — rather than at inset-0. The header is chrome, not content:
                  dimming it also puts the sidebar toggle under a click target
                  that closes the task, which leaves a window under `dock` with
                  a task open and no way to the workspace tree but the keyboard.
                  Covering only the list also keeps this out of the header's
                  stacking context, where the filter and grouping menus live. */}
              <Show when={!ui.taskExpanded}>
                <button
                  type="button"
                  aria-label="Close"
                  class="absolute inset-x-0 top-12 bottom-0 z-10 bg-scrim split:hidden"
                  onClick={closeTask}
                />
              </Show>

              <TaskDetail
                taskId={taskId()}
                onClose={closeTask}
                onStatusClick={(event) => {
                  const task = tasks.get(taskId());
                  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
                  if (task) {
                    void openStatusMenu(task, {
                      x: rect?.left ?? event.clientX,
                      y: (rect?.bottom ?? event.clientY) + 6,
                    });
                  }
                }}
              />
            </>
          )}
        </Show>
      </main>

      <Show when={ui.palette}>
        <CommandPalette
          commands={commands()}
          search={searchTasks}
          onClose={() => setUi("palette", false)}
        />
      </Show>

      <Show when={ui.shortcuts}>
        <Shortcuts onClose={() => setUi("shortcuts", false)} />
      </Show>

      <Show when={ui.quickAdd}>
        <QuickAdd
          listId={viewListId()}
          listName={viewListId() ? viewTitle() : null}
          onClose={() => setUi("quickAdd", false)}
        />
      </Show>

      <Toasts />

      {/*
        Not `<Show when={menu()}>{(current) => …}`: that keyed accessor throws
        once read after the menu has closed, and Solid answers a throw in the
        owner by tearing the subtree's reactivity down. This only works today
        because every read happens before `closeMenu`, which is a rule nobody
        can see. Reading `menu()` directly cannot go stale.
      */}
      <Show when={menu()}>
        <Menu
          items={menuItems()}
          anchor={menu()?.anchor ?? { x: 0, y: 0 }}
          placeholder={menu()?.kind === "status" ? "Change status…" : "Set priority…"}
          onSelect={(id) => {
            const current = menu();
            if (!current) return;
            if (current.kind === "priority") {
              applyPriority(current.task, id === "none" ? null : Number(id));
              return;
            }
            const status = current.statuses.find((s) => s.status === id);
            if (status) applyStatus(current.task, status);
          }}
          onClose={closeMenu}
        />
      </Show>

      {/* Last, so it covers everything, and always mounted: it is what makes
          images inside descriptions and comments clickable. */}
      <Lightbox />
    </div>
  );
}

/** One button, one menu. Four always-visible chips said "Status" twice next to
 *  the status filter, which is the kind of thing that reads as clutter. */
function GroupPicker(): JSX.Element {
  const [anchor, setAnchor] = createSignal<{ x: number; y: number } | null>(null);
  const options = ["status", "due", "assignee", "priority", "list", "none"] as const;

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.right - 180, y: rect.bottom + 6 });
        }}
        class="flex h-[22px] items-center gap-1 rounded-[5px] px-1.5 text-xs text-ink-4 transition-colors hover:bg-hover hover:text-ink-2"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2.5 4h11M2.5 8h11M2.5 12h6"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        <span class="capitalize">{ui.groupBy === "none" ? "No grouping" : ui.groupBy}</span>
      </button>

      <Show when={anchor()}>
        <Menu
          anchor={anchor() ?? { x: 0, y: 0 }}
          width={180}
          placeholder="Group by…"
          items={options.map((option) => ({
            id: option,
            label: option === "none" ? "No grouping" : `By ${option}`,
          }))}
          onSelect={(id) => {
            setUi("groupBy", id as (typeof options)[number]);
            setAnchor(null);
          }}
          onClose={() => setAnchor(null)}
        />
      </Show>
    </>
  );
}
