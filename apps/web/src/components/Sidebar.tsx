import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { DocRef, ListRef, Me, Space } from "../lib/api.ts";
import { celebrate } from "../lib/celebration.tsx";
import { inboxPredicate, inboxSeenAt, inboxTruncated } from "../lib/inbox.ts";
import { useLiveTasks } from "../lib/live.ts";
import { A, useParams, useRouterState } from "../lib/nav.tsx";
import {
  isOpen,
  isPinned,
  pinned,
  revealPath,
  toggleOpen,
  togglePinned,
} from "../lib/sidebar-state.ts";
import { signOut } from "../lib/signed-out.ts";
import { connected } from "../lib/sse.ts";
import { setTheme, THEMES, themeChoice, themeLabel } from "../lib/theme.ts";
import { pathToDoc, pathToList } from "../lib/tree-path.ts";
import { Avatar } from "./Avatar.tsx";
import { LogoCompact } from "./Logo.tsx";
import { Menu } from "./Menu.tsx";

/**
 * The sidebar.
 *
 * Two zones, like every macOS source list: fixed destinations at the top, the
 * workspace tree below. Rows are 28px because the tree gets deep and 32 would
 * push a third of it below the fold on a laptop.
 *
 * Below the `dock` breakpoint it stops being a column and becomes a drawer
 * over the main panel, closed by default. 236px is a fifth of a 1100px window
 * spent on a tree that gets used a few times an hour, and the same 236px is
 * what pushes the row past its first shed (see --breakpoint-dock). It is
 * hidden rather than reduced to icons because a tree of spaces and folders has
 * no icons to reduce to — the second level down is five words of name and
 * nothing else — and because ⌘K already navigates to any list by typing it.
 * The drawer is what a mouse gets instead.
 *
 * The narrow layout is spelled with `max-dock:` rather than by rewriting the
 * base classes mobile-first, so the wide layout below is byte-for-byte the one
 * that was here before and the exceptions are the only thing to review.
 */
export function Sidebar(props: {
  me: Me | null;
  spaces: Space[];
  /** Docs that hang off the Workspace rather than any Space. Their own section. */
  docs: DocRef[];
  /** Drawer state. Ignored above `dock`, where the sidebar is always in flow. */
  open: boolean;
  onSearch: () => void;
  onQuickAdd: () => void;
}): JSX.Element {
  useRevealActiveList(() => props.spaces);

  /*
   * Counted from the shared collection rather than from a count endpoint.
   *
   * It is live for free — SSE folds every changed task into the same rows this
   * reads — and it is only correct because the shell loads the inbox window at
   * boot. Without that load this would be a count of whatever the open view
   * happened to have fetched, which is a number that looks authoritative and
   * is not.
   */
  const unreadRows = useLiveTasks(createMemo(() => inboxPredicate(props.me?.id, inboxSeenAt())));
  const unread = () => unreadRows().length;

  /*
   * Inbox zero, celebrated. Only the moment it *empties* counts: mounting with
   * nothing unread is a quiet morning, not a victory, so the first reading
   * only arms the comparison. `celebrate` is a no-op outside the Ember theme.
   *
   * Unlike the task banner, this one is deliberately not limited to local
   * actions: the count is the badge's own live number, and if a teammate's
   * change is what emptied it, the inbox is clean either way. In that rare
   * remote case there is no user gesture, so the chime is refused by autoplay
   * policy and only the banner shows — which is the right degradation.
   */
  let lastUnread: number | undefined;
  createEffect(() => {
    const count = unread();
    if (lastUnread !== undefined && lastUnread > 0 && count === 0) celebrate("inboxCleared");
    lastUnread = count;
  });

  return (
    <aside
      aria-label="Workspace"
      class="flex w-[236px] shrink-0 flex-col max-dock:absolute max-dock:inset-y-0 max-dock:left-0 max-dock:z-40 max-dock:border-line max-dock:border-r max-dock:bg-app"
      classList={{ "max-dock:hidden": !props.open }}
    >
      <header class="flex h-12 items-center gap-1.5 px-3">
        <LogoCompact size={20} />
        <span class="flex-1 truncate font-medium text-md text-ink">Rask</span>
        <IconButton label="New task  c" onClick={props.onQuickAdd}>
          <path d="M8 3.5v9M3.5 8h9" />
        </IconButton>
      </header>

      <div class="px-3 pb-1">
        {/* The workspace-wide palette, same as ⌘K — not the view filter, which
            lives in the list header where its results are. Styled as a dormant
            input: the affordance says "type here" and the kbd chip says how. */}
        <button
          type="button"
          onClick={props.onSearch}
          class="flex h-7 w-full items-center gap-2 rounded-[5px] bg-hover px-2 text-left text-sm text-ink-4 hover:bg-hover/70"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            class="shrink-0"
            aria-hidden="true"
          >
            <path
              d="M11.5 11.5 14 14M13 7.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
          <span class="flex-1 truncate">Search</span>
          <span class="shrink-0 rounded-[4px] border border-line-strong px-1 text-xs leading-4">
            ⌘K
          </span>
        </button>
      </div>

      <nav class="flex flex-col gap-px px-2">
        <NavItem to="/" label="My Tasks">
          <path d="M5.5 8.5 7 10l3.5-4M13.5 8A5.5 5.5 0 1 1 2.5 8a5.5 5.5 0 0 1 11 0Z" />
        </NavItem>
        <NavItem to="/inbox" label="Inbox" badge={unread()} more={inboxTruncated()}>
          {/* A bell. */}
          <path d="M6.4 12.5a1.6 1.6 0 0 0 3.2 0M4 7a4 4 0 0 1 8 0c0 2.4.9 3.4 1.3 3.8a.4.4 0 0 1-.3.7H3a.4.4 0 0 1-.3-.7C3.1 10.4 4 9.4 4 7Z" />
        </NavItem>
        <NavItem to="/timesheet" label="My Timesheet">
          {/* A clock face: the same glyph the property rail uses for time. */}
          <circle cx="8" cy="8" r="5.6" />
          <path d="M8 5.2V8l2 1.3" />
        </NavItem>
      </nav>

      <div class="mt-5 flex-1 overflow-y-auto px-2 pb-3">
        <PinnedLists spaces={props.spaces} />
        <div class="px-2 pb-1 font-medium text-ink-4 text-xs uppercase tracking-[0.04em]">
          Workspace
        </div>
        <For each={props.spaces}>{(space) => <SpaceNode space={space} />}</For>

        {/*
          Below the tree, not inside it. These Docs have no Space to sit under —
          ClickUp files them at the Workspace — and in the workspace this was
          built against there are more of them than every Space-level Doc put
          together. A section of their own is the only place they fit.
        */}
        <Show when={props.docs.length > 0}>
          <div class="mt-4 px-2 pb-1 font-medium text-ink-4 text-xs uppercase tracking-[0.04em]">
            Docs
          </div>
          <For each={props.docs}>{(doc) => <DocItem doc={doc} />}</For>
        </Show>
      </div>

      <Show when={props.me}>
        {(me) => (
          <footer class="flex h-11 items-center gap-2 border-line/70 border-t px-3">
            <Avatar user={me()} size={20} />
            <span class="flex-1 truncate text-ink-2 text-xs">
              {me().username ?? me().email ?? "Signed in"}
            </span>
            <ThemeButton />
            <SignOutButton />
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
  const empty = () =>
    props.space.folders.length === 0 &&
    props.space.lists.length === 0 &&
    props.space.docs.length === 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => toggleOpen(props.space.id)}
        class="flex h-7 w-full items-center gap-1.5 rounded-[5px] px-2 text-ink-2 hover:bg-hover hover:text-ink"
      >
        <Chevron open={isOpen(props.space.id)} muted={empty()} />
        <span class="truncate text-md">{props.space.name}</span>
      </button>

      <Show when={isOpen(props.space.id)}>
        <div class="ml-[13px] border-line/60 border-l pl-1.5">
          <For each={props.space.folders}>{(folder) => <FolderNode folder={folder} />}</For>
          <For each={props.space.lists}>{(list) => <ListItem list={list} />}</For>
          <For each={props.space.docs}>{(doc) => <DocItem doc={doc} />}</For>
        </div>
      </Show>
    </div>
  );
}

function FolderNode(props: {
  folder: { id: string; name: string; lists: ListRef[]; docs: DocRef[] };
}): JSX.Element {
  const empty = () => props.folder.lists.length === 0 && props.folder.docs.length === 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => toggleOpen(props.folder.id)}
        class="flex h-7 w-full items-center gap-1.5 rounded-[5px] px-2 text-ink-2 hover:bg-hover hover:text-ink"
      >
        <Chevron open={isOpen(props.folder.id)} muted={empty()} />
        <span class="truncate text-md">{props.folder.name}</span>
      </button>
      <Show when={isOpen(props.folder.id)}>
        <div class="ml-[13px] border-line/60 border-l pl-1.5">
          <For each={props.folder.lists}>{(list) => <ListItem list={list} />}</For>
          <For each={props.folder.docs}>{(doc) => <DocItem doc={doc} />}</For>
        </div>
      </Show>
    </div>
  );
}

/**
 * A Doc in the tree.
 *
 * No pin and no chevron: a Doc is one thing to open, and the pinned strip is
 * about lists somebody works out of. The icon is a page rather than the list
 * glyph so the two kinds of row are told apart without reading them.
 */
function DocItem(props: { doc: DocRef }): JSX.Element {
  const params = useParams({ strict: false });
  const active = () => (params() as { docId?: string }).docId === props.doc.id;

  return (
    <A
      to="/doc/$docId"
      params={{ docId: props.doc.id }}
      class={`flex h-7 items-center gap-2 rounded-[5px] py-2 pr-2 pl-2 text-md ${
        active() ? "row-selected text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
      }`}
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
          d="M4 2.5h5L12 5.5v8h-8z"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
        />
        <path d="M8.6 2.6v3h3.2" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
      </svg>
      <span class="truncate">{props.doc.name}</span>
    </A>
  );
}

function ListItem(props: { list: ListRef }): JSX.Element {
  /*
   * The route's own `listId`, not `matchRoute`.
   *
   * `matchRoute({ to: "/list/$listId", params: { listId }, fuzzy: true })`
   * looks like it asks "is this list the open one" and does not: under a fuzzy
   * match the params are ignored and only the pattern is compared, so every
   * list in the tree came back true and the sidebar drew nine of them selected
   * at once. It reads as multi-select, and in light mode you cannot miss it.
   *
   * Reading the parameter also keeps what the fuzzy match was there for — the
   * list stays marked while one of its views is open — because `listId` is the
   * same on `/list/$listId` and `/list/$listId/view/$viewId`.
   */
  const params = useParams({ strict: false });
  const active = () => (params() as { listId?: string }).listId === props.list.id;

  return (
    <>
      <div class="group/list relative">
        <A
          to="/list/$listId"
          params={{ listId: props.list.id }}
          // One string, not classList: `A` is a component, so Solid hands it
          // `classList` as an inert prop and nothing ever applies it. Every list
          // link rendered at full-brightness ink with no hover, active or not.
          class={`flex h-7 items-center gap-2 rounded-[5px] py-2 pr-7 pl-2 text-md ${
            active() ? "row-selected text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
          }`}
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
          <span class="truncate">{props.list.name}</span>
        </A>

        {/*
        Outside the link, not inside it: a button nested in an anchor is invalid
        and the click would navigate before the star ever fired.

        Hidden until hover, except when it is on — an off star on every row is
        forty pieces of chrome saying nothing, while an on one is the answer to
        "is this pinned".
      */}
        <PinButton id={props.list.id} name={props.list.name} />
      </div>

      {/*
      A List's Docs, indented under it and always shown rather than behind a
      chevron of their own. Almost no List has any — 27 across the workspace
      against 833 tasks in one List alone — so a collapsed row would be a
      toggle that is empty nearly everywhere it appears, and the whole subtree
      is already hidden behind the Space's.
    */}
      <Show when={props.list.docs.length > 0}>
        <div class="ml-[13px] border-line/60 border-l pl-1.5">
          <For each={props.list.docs}>{(doc) => <DocItem doc={doc} />}</For>
        </div>
      </Show>
    </>
  );
}

function PinButton(props: { id: string; name: string }): JSX.Element {
  const on = () => isPinned(props.id);

  return (
    <button
      type="button"
      aria-label={on() ? `Unpin ${props.name}` : `Pin ${props.name}`}
      aria-pressed={on()}
      title={on() ? "Unpin" : "Pin to the top"}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePinned(props.id);
      }}
      class={`-translate-y-1/2 absolute top-1/2 right-1 grid size-5 place-items-center rounded transition-opacity hover:bg-hover ${
        on()
          ? "text-accent opacity-100"
          : "text-ink-4 opacity-0 hover:text-ink-2 focus-visible:opacity-100 group-hover/list:opacity-100"
      }`}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.8Z"
          fill={on() ? "currentColor" : "none"}
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * Pinned lists, above the tree.
 *
 * ClickUp's own Favorites are not in the public API — there is no endpoint for
 * them in the v2 spec, only `/team/{id}/shared`, which is a different thing —
 * so these are Rask's, kept in this browser. They are ids resolved against the
 * tree, so a pin survives a rename and disappears with the list itself.
 */
function PinnedLists(props: { spaces: Space[] }): JSX.Element {
  const all = createMemo(() => {
    const byId = new Map<string, string>();
    for (const space of props.spaces) {
      for (const list of space.lists) byId.set(list.id, list.name);
      for (const folder of space.folders) {
        for (const list of folder.lists) byId.set(list.id, list.name);
      }
    }
    return [...pinned()]
      .flatMap((id) => {
        const name = byId.get(id);
        return name ? [{ id, name }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  return (
    <Show when={all().length > 0}>
      <div class="mb-4">
        <div class="px-2 pb-1 font-medium text-ink-4 text-xs uppercase tracking-[0.04em]">
          Pinned
        </div>
        {/* Docs are deliberately not carried into the pinned strip: a pin is
            about a list somebody works out of, and the Doc is one click away
            in the tree. */}
        <For each={all()}>
          {(list) => <ListItem list={{ id: list.id, name: list.name, docs: [] }} />}
        </For>
      </div>
    </Show>
  );
}

function NavItem(props: {
  to: string;
  label: string;
  /** Zero draws nothing. Undefined for the entries that never count anything. */
  badge?: number;
  /** There were more than the count could see. Draws a "+", as the header does. */
  more?: boolean;
  children: JSX.Element;
}): JSX.Element {
  /*
   * The pathname, not `matchRoute`.
   *
   * Same trap `ListItem` documents above, one level up: `matchRoute({ to, fuzzy:
   * false })` returned true here for every destination on every route, so My
   * Tasks and Inbox were both drawn selected while you were looking at a list.
   * It only became visible when there were two of them — one link that is
   * always marked reads as "you are here", two read as a bug.
   *
   * These have no parameters, so an exact pathname comparison is the whole
   * question, and it is one TanStack cannot answer differently than it looks.
   */
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = () => pathname() === props.to;

  return (
    <A
      to={props.to}
      // One string, not classList: `A` is a component, so Solid hands it
      // `classList` as an inert prop and nothing ever applies it. Every list
      // link rendered at full-brightness ink with no hover, active or not.
      class={`flex h-7 items-center gap-2 rounded-[5px] px-2 text-md ${
        active() ? "row-selected text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
      }`}
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
      <span class="flex-1 truncate">{props.label}</span>
      <Show when={(props.badge ?? 0) > 0}>
        <span class="shrink-0 rounded-full bg-accent px-1.5 font-medium text-[11px] text-on-accent tabular-nums">
          {props.badge}
          {props.more ? "+" : ""}
        </span>
      </Show>
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

export function Chevron(props: { open: boolean; muted?: boolean }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      /* `chevron` is a styling hook, not a utility: the XP skin turns this
         glyph into a treeview's +/- box and needs a name to reach it by.
         Pinned in skin-hooks.test.ts. */
      class="chevron shrink-0 transition-transform duration-100"
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

/**
 * Unfolds the branch the open list is on.
 *
 * Rask answers ClickUp's own URLs with the domain swapped, so the common way in
 * is a link from somebody else rather than a walk down the tree — and a tree
 * that shows nothing about where you are is a tree you have to search to find
 * out. Opening the ancestors is also what makes the next click, to a sibling
 * list, one click.
 *
 * Only ever opens. Collapsing what someone deliberately closed, because the
 * route happens to be inside it, is the sidebar arguing with the person using
 * it.
 */
function useRevealActiveList(spaces: () => Space[]): void {
  // `strict: false` because the sidebar renders on every route and most have no
  // listId. `matchRoute` answers whether a route matches, not what its
  // parameters are, which is the question here.
  const params = useParams({ strict: false });

  createEffect(() => {
    const { listId, docId } = params() as { listId?: string; docId?: string };
    // A Doc as readily as a List: both are rows in this tree, and a link to
    // either one lands on a sidebar that cannot show where you are without it.
    const path = listId ? pathToList(spaces(), listId) : docId ? pathToDoc(spaces(), docId) : null;
    if (path) revealPath(path);
  });
}

/**
 * The theme, as one button opening a menu.
 *
 * It was only in the command palette, which is where every other action lives
 * — and which nobody finds by looking, because there is nothing to look at.
 * Somebody wanting light mode has no reason to guess that ⌘K holds it.
 *
 * It used to cycle: three states behind one press, the tooltip naming the
 * next. Ember made it four, and four is past what a blind press can carry —
 * getting from Light back to System now meant a tour through the two dark
 * themes, a flash of near-black each. A menu names all four and costs one
 * more click only when changing, which is the rare case.
 */
function ThemeButton(): JSX.Element {
  const [anchor, setAnchor] = createSignal<{ x: number; y: number } | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.top - 8 });
        }}
        title={`Theme: ${themeLabel(themeChoice())}`}
        aria-label={`Theme: ${themeLabel(themeChoice())}. Choose a theme`}
        class="grid size-6 shrink-0 place-items-center rounded-[5px] text-ink-4 transition-colors hover:bg-hover hover:text-ink-2"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <Show when={themeChoice() === "system"}>
            {/* A display: the theme is whatever the machine says. */}
            <path
              d="M2.5 3.5h11v7h-11v-7ZM6 13h4M8 10.5V13"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </Show>
          <Show when={themeChoice() === "light"}>
            <g stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
              <circle cx="8" cy="8" r="3" />
              <path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
            </g>
          </Show>
          <Show when={themeChoice() === "dark"}>
            <path
              d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linejoin="round"
            />
          </Show>
          <Show when={themeChoice() === "ember"}>
            {/* A flame, for the theme lit by one. */}
            <path
              d="M8 1.8c2.2 2.3 4.3 4.3 4.3 6.9a4.3 4.3 0 0 1-8.6 0C3.7 6.1 5.8 4.1 8 1.8Zm0 9.7a2 2 0 0 0 2-2c0-1.1-.9-2-2-3.1-1.1 1.1-2 2-2 3.1a2 2 0 0 0 2 2Z"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linejoin="round"
            />
          </Show>
          <Show when={themeChoice() === "xp"}>
            {/* A window with a caption bar, for the theme that draws one. */}
            <g stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <path d="M2 6.4h12" />
            </g>
          </Show>
          <Show when={themeChoice() === "brutal"}>
            {/* A Memphis zigzag, for the theme drawn in marker. */}
            <path
              d="M2 10.5 5 5l3 5.5L11 5l3 5.5"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="square"
              stroke-linejoin="miter"
            />
          </Show>
          <Show when={themeChoice() === "aqua"}>
            {/* A window with its three lights, for the theme that is one. */}
            <g stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
              <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2" />
              <path d="M1.6 6.2h12.8" />
              <circle cx="4" cy="4.4" r="0.75" fill="currentColor" stroke="none" />
              <circle cx="6.2" cy="4.4" r="0.75" fill="currentColor" stroke="none" />
              <circle cx="8.4" cy="4.4" r="0.75" fill="currentColor" stroke="none" />
            </g>
          </Show>
          <Show when={themeChoice() === "cyber"}>
            {/* A chipped shard, for the theme with one in its head. */}
            <g stroke="currentColor" stroke-width="1.3" stroke-linejoin="miter">
              <path d="M2.5 4.2 4.2 2.5h9.3v9.3l-1.7 1.7H2.5V4.2Z" />
              <path d="M5.5 5.5h5v5h-5z" fill="currentColor" stroke="none" />
            </g>
          </Show>
        </svg>
      </button>
      <Menu
        items={THEMES.map(([value, label]) => ({
          id: value,
          label,
          hint: themeChoice() === value ? "on" : undefined,
        }))}
        anchor={anchor()}
        placeholder="Theme..."
        width={180}
        up
        onSelect={(id) => {
          const choice = THEMES.find(([value]) => value === id)?.[0];
          if (choice) setTheme(choice);
          setAnchor(null);
        }}
        onClose={() => setAnchor(null)}
      />
    </>
  );
}

/**
 * Signing out, which was not possible at all.
 *
 * `POST /auth/logout` existed on the API and nothing called it, so the only
 * way out of a session was clearing the cookie by hand. That is fine on your
 * own laptop and not fine on a shared one.
 *
 * Next to the name it ends rather than under a menu of one: the row already
 * says who you are, and this is the only thing you would do to it.
 */
function SignOutButton(): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Sign out"
      title="Sign out"
      onClick={() => void signOut()}
      class="grid size-6 shrink-0 place-items-center rounded-[5px] text-ink-4 transition-colors hover:bg-hover hover:text-ink-2"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6M10.5 11 13.5 8l-3-3M13 8H6"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  );
}
