import { Outlet, useNavigate, useSearch } from "@tanstack/solid-router";
import { createEffect, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import {
  buildNavigationCommands,
  type Command,
  CommandPalette,
} from "./components/CommandPalette.tsx";
import { FilterBar } from "./components/FilterBar.tsx";
import { Menu, type MenuItem } from "./components/Menu.tsx";
import { QuickAdd } from "./components/QuickAdd.tsx";
import { Shortcuts } from "./components/Shortcuts.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusIcon } from "./components/StatusIcon.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { api, type StatusDef, type Task } from "./lib/api.ts";
import { PRIORITY_LABELS } from "./lib/format.ts";
import { loadSession, me, reloadHierarchy, spaces } from "./lib/session.ts";
import { connect } from "./lib/sse.ts";
import { tasks } from "./lib/store.ts";
import { clearFilters, closeOverlays, setUi, ui } from "./lib/ui.ts";
import {
  cursorTask,
  rowTasks,
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
      if (ui.palette || ui.quickAdd || ui.shortcuts || menu()) {
        closeOverlays();
        closeMenu();
      } else if (searching()) {
        setSearching(false);
        setUi("search", "");
      } else if (openTaskId()) {
        closeTask();
      } else {
        clearFilters();
      }
      return;
    }

    // Everything below is a bare key. Typing in a field always wins.
    if (typing || ui.palette || ui.quickAdd || ui.shortcuts || menu()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key;
    const task = cursorTask();
    const max = Math.max(0, rowTasks().length - 1);

    switch (key) {
      case "j":
      case "ArrowDown":
        event.preventDefault();
        setUi("cursor", Math.min(max, ui.cursor + 1));
        break;
      case "k":
      case "ArrowUp":
        event.preventDefault();
        setUi("cursor", Math.max(0, ui.cursor - 1));
        break;
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
      case "?":
        event.preventDefault();
        setUi("shortcuts", true);
        break;
    }

    lastKey = key;
  };

  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  // Reset the cursor when the view changes; row 4 of the old list means nothing
  // in the new one.
  createEffect(() => {
    viewTitle();
    setUi("cursor", 0);
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
    ...(["status", "due", "assignee", "list", "none"] as const).map((groupBy) => ({
      id: `group:${groupBy}`,
      label: `Group by ${groupBy === "none" ? "nothing" : groupBy}`,
      section: "View",
      run: () => setUi("groupBy", groupBy),
    })),
    {
      id: "view:filter",
      label: "Filter this view",
      section: "View",
      hint: "/",
      run: () => {
        setSearching(true);
        queueMicrotask(() => searchInput?.focus());
      },
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
    <div class="flex h-full overflow-hidden">
      <Sidebar
        me={me()}
        spaces={spaces()}
        onSearch={() => {
          setSearching(true);
          queueMicrotask(() => searchInput?.focus());
        }}
        onQuickAdd={() => setUi("quickAdd", true)}
      />

      <main class="mt-2 mr-2 mb-2 flex min-w-0 flex-1 overflow-hidden rounded-[10px] border border-line bg-panel">
        <div class="flex min-w-0 flex-1 flex-col">
          <header class="flex h-12 shrink-0 items-center gap-3 border-line/70 border-b px-5">
            <Show
              when={searching()}
              fallback={
                <>
                  <h1 class="truncate font-medium text-[13.5px] text-ink tracking-[-0.005em]">
                    {viewTitle()}
                  </h1>
                  <span
                    class="rounded bg-white/[0.05] px-1.5 text-[11px] text-ink-3 tabular-nums"
                    title={viewTruncated() ? "More tasks exist than were loaded" : undefined}
                  >
                    {rowTasks().length}
                    {viewTruncated() ? "+" : ""}
                  </span>
                  <div class="flex-1" />
                  <FilterBar />
                  <span class="h-3.5 w-px bg-line-strong" />
                  <GroupPicker />
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
                placeholder="Filter tasks…"
                class="h-full flex-1 text-[13px]"
              />
              <button
                type="button"
                onClick={() => {
                  setSearching(false);
                  setUi("search", "");
                }}
                class="text-ink-4 text-xs hover:text-ink-2"
              >
                esc
              </button>
            </Show>
          </header>

          <Outlet />
        </div>

        <Show when={openTaskId()}>
          {(taskId) => (
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
          )}
        </Show>
      </main>

      <Show when={ui.palette}>
        <CommandPalette commands={commands()} onClose={() => setUi("palette", false)} />
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

      <Show when={menu()}>
        {(current) => (
          <Menu
            items={menuItems()}
            anchor={current().anchor}
            placeholder={current().kind === "status" ? "Change status…" : "Set priority…"}
            onSelect={(id) => {
              if (current().kind === "priority") {
                applyPriority(current().task, id === "none" ? null : Number(id));
                return;
              }
              const status = current().statuses.find((s) => s.status === id);
              if (status) applyStatus(current().task, status);
            }}
            onClose={closeMenu}
          />
        )}
      </Show>
    </div>
  );
}

/** One button, one menu. Four always-visible chips said "Status" twice next to
 *  the status filter, which is the kind of thing that reads as clutter. */
function GroupPicker(): JSX.Element {
  const [anchor, setAnchor] = createSignal<{ x: number; y: number } | null>(null);
  const options = ["status", "due", "assignee", "list", "none"] as const;

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.right - 180, y: rect.bottom + 6 });
        }}
        class="flex h-[22px] items-center gap-1 rounded-[5px] px-1.5 text-[11.5px] text-ink-4 transition-colors hover:bg-white/[0.04] hover:text-ink-2"
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
        {(at) => (
          <Menu
            anchor={at()}
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
        )}
      </Show>
    </>
  );
}
