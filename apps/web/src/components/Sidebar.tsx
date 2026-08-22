import { createSignal, For, type JSX, Show } from "solid-js";
import type { Me, Space } from "../lib/api.ts";
import { A, useMatchRoute } from "../lib/nav.tsx";
import { connected } from "../lib/sse.ts";
import { Avatar } from "./Avatar.tsx";

/**
 * The sidebar.
 *
 * Two zones, like every macOS source list: fixed destinations at the top, the
 * workspace tree below. Rows are 28px because the tree gets deep and 32 would
 * push a third of it below the fold on a laptop.
 */
export function Sidebar(props: {
  me: Me | null;
  spaces: Space[];
  onSearch: () => void;
  onQuickAdd: () => void;
}): JSX.Element {
  return (
    <aside class="flex w-[236px] shrink-0 flex-col">
      <header class="flex h-12 items-center gap-1.5 px-3">
        <Avatar user={props.me} size={20} />
        <span class="flex-1 truncate font-medium text-base text-ink">Rask</span>
        <IconButton label="Search  /" onClick={props.onSearch}>
          <path d="M11.5 11.5 14 14M13 7.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z" />
        </IconButton>
        <IconButton label="New task  c" onClick={props.onQuickAdd}>
          <path d="M8 3.5v9M3.5 8h9" />
        </IconButton>
      </header>

      <nav class="flex flex-col gap-px px-2">
        <NavItem to="/" label="My Tasks">
          <path d="M5.5 8.5 7 10l3.5-4M13.5 8A5.5 5.5 0 1 1 2.5 8a5.5 5.5 0 0 1 11 0Z" />
        </NavItem>
      </nav>

      <div class="mt-5 flex-1 overflow-y-auto px-2 pb-3">
        <div class="px-2 pb-1 font-medium text-xs text-ink-4 uppercase tracking-[0.04em]">
          Workspace
        </div>
        <For each={props.spaces}>{(space) => <SpaceNode space={space} />}</For>
      </div>

      <Show when={props.me}>
        {(me) => (
          <footer class="flex h-11 items-center gap-2 border-line/70 border-t px-3">
            <Avatar user={me()} size={20} />
            <span class="flex-1 truncate text-ink-2 text-xs">
              {me().username ?? me().email ?? "Signed in"}
            </span>
            <span
              class="size-1.5 shrink-0 rounded-full transition-colors"
              classList={{ "bg-ok": connected(), "bg-high": !connected() }}
              title={
                connected()
                  ? "Live: changes from ClickUp arrive as they land"
                  : "Disconnected: you are reading a snapshot"
              }
            />
          </footer>
        )}
      </Show>
    </aside>
  );
}

function SpaceNode(props: { space: Space }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const empty = () => props.space.folders.length === 0 && props.space.lists.length === 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        class="flex h-7 w-full items-center gap-1.5 rounded-[5px] px-2 text-ink-2 hover:bg-hover hover:text-ink"
      >
        <Chevron open={open()} muted={empty()} />
        <span class="truncate text-base">{props.space.name}</span>
      </button>

      <Show when={open()}>
        <div class="ml-[13px] border-line/60 border-l pl-1.5">
          <For each={props.space.folders}>{(folder) => <FolderNode folder={folder} />}</For>
          <For each={props.space.lists}>{(list) => <ListItem id={list.id} name={list.name} />}</For>
        </div>
      </Show>
    </div>
  );
}

function FolderNode(props: {
  folder: { id: string; name: string; lists: Array<{ id: string; name: string }> };
}): JSX.Element {
  const [open, setOpen] = createSignal(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        class="flex h-7 w-full items-center gap-1.5 rounded-[5px] px-2 text-ink-2 hover:bg-hover hover:text-ink"
      >
        <Chevron open={open()} muted={props.folder.lists.length === 0} />
        <span class="truncate text-base">{props.folder.name}</span>
      </button>
      <Show when={open()}>
        <div class="ml-[13px] border-line/60 border-l pl-1.5">
          <For each={props.folder.lists}>
            {(list) => <ListItem id={list.id} name={list.name} />}
          </For>
        </div>
      </Show>
    </div>
  );
}

function ListItem(props: { id: string; name: string }): JSX.Element {
  const matchRoute = useMatchRoute();
  const active = () => Boolean(matchRoute({ to: "/list/$listId", params: { listId: props.id } }));

  return (
    <A
      to="/list/$listId"
      params={{ listId: props.id }}
      class="flex h-7 items-center gap-2 rounded-[5px] px-2 text-base"
      classList={{
        "row-selected text-ink": active(),
        "text-ink-2 hover:bg-hover hover:text-ink": !active(),
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        class="shrink-0 text-ink-4"
        aria-hidden="true"
      >
        <path
          d="M3 4.5h10M3 8h10M3 11.5h6"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
      <span class="truncate">{props.name}</span>
    </A>
  );
}

function NavItem(props: { to: string; label: string; children: JSX.Element }): JSX.Element {
  const matchRoute = useMatchRoute();
  const active = () => Boolean(matchRoute({ to: props.to, fuzzy: false }));

  return (
    <A
      to={props.to}
      class="flex h-7 items-center gap-2 rounded-[5px] px-2 text-base"
      classList={{
        "row-selected text-ink": active(),
        "text-ink-2 hover:bg-hover hover:text-ink": !active(),
      }}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        class="shrink-0"
        aria-hidden="true"
      >
        <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          {props.children}
        </g>
      </svg>
      {props.label}
    </A>
  );
}

function IconButton(props: {
  label: string;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      class="flex size-6 items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover hover:text-ink"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          {props.children}
        </g>
      </svg>
    </button>
  );
}

function Chevron(props: { open: boolean; muted: boolean }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      class="shrink-0 transition-transform duration-100"
      classList={{ "rotate-90": props.open, "opacity-35": props.muted }}
      aria-hidden="true"
    >
      <path
        d="M6.5 4.5 10 8l-3.5 3.5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
