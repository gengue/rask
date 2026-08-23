import { For, type JSX, Show } from "solid-js";
import type { ListView } from "../lib/api.ts";
import { clickUpViewUrl, isRenderable, listViews, viewTypeLabel } from "../lib/clickup-views.ts";
import { A } from "../lib/nav.tsx";
import { me } from "../lib/session.ts";

/**
 * ClickUp's tabs, above the list.
 *
 * One row at the list's own 36px rhythm, hairline-separated from the rows
 * below, and the same five-step type scale as everything else. The active tab
 * is an accent hairline sitting on the border rather than a filled pill: the
 * app draws selection with a background everywhere it means "the cursor is
 * here", and a tab is not a cursor.
 *
 * Two kinds of tab, and the difference is visible before it is clicked. A list
 * or board view is a link into Rask. Everything else — forms, chats, calendars,
 * Gantt charts — is an external link, marked with the arrow that means so
 * everywhere else on the web, and its title says what it is and where it goes.
 * ClickUp built those views; imitating them badly would be worse than sending
 * people to the thing that works.
 *
 * There is no tab for Rask's own unfiltered list. The list is what the sidebar
 * points at, and inventing a tab ClickUp does not have would put a fifth kind
 * of thing in a row that is meant to mirror one.
 */
export function ViewTabs(props: { activeViewId: string | null }): JSX.Element {
  return (
    <Show when={listViews().length > 0}>
      <nav
        aria-label="Views"
        class="flex h-9 shrink-0 items-center gap-px overflow-x-auto overflow-y-hidden border-line/70 border-b px-3"
      >
        <For each={listViews()}>
          {(view) => <Tab view={view} active={view.id === props.activeViewId} />}
        </For>
      </nav>
    </Show>
  );
}

function Tab(props: { view: ListView; active: boolean }): JSX.Element {
  const external = () => !isRenderable(props.view.type);
  const href = () => clickUpViewUrl(props.view, me()?.teamId ?? null);

  const title = () =>
    [
      props.view.name,
      external()
        ? `Opens in ClickUp: Rask does not render ${viewTypeLabel(props.view.type)} views`
        : null,
      props.view.isDefault ? "Default view" : null,
    ]
      .filter(Boolean)
      .join(" — ");

  const label = (
    <>
      <span class="truncate">{props.view.name}</span>
      <Show when={props.view.isDefault}>
        <span class="size-1 shrink-0 rounded-full bg-ink-4" aria-hidden="true" />
      </Show>
      <Show when={external()}>
        <svg
          width="9"
          height="9"
          viewBox="0 0 16 16"
          fill="none"
          class="shrink-0"
          aria-hidden="true"
        >
          <path
            d="M6 3h7v7M13 3 4 12"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </Show>
    </>
  );

  /*
   * The marker sits inside the tab rather than on the hairline below it. The
   * nav scrolls sideways, which makes it an overflow container in both axes, so
   * anything drawn past its padding box — the border included — is clipped away.
   */
  const marker = (
    <Show when={props.active}>
      <span class="absolute inset-x-2 bottom-0 h-px bg-accent" aria-hidden="true" />
    </Show>
  );

  /*
   * One class string, not a `classList`.
   *
   * `classList` is a Solid DOM binding. On a component — and TanStack's Link is
   * one — it is an inert prop that never reaches the anchor, which is how the
   * active tab first shipped with no colour at all. The plain anchor below
   * takes the same string so the two branches cannot drift.
   */
  const classes = () =>
    [
      "relative flex h-full max-w-[180px] shrink-0 items-center gap-1.5 px-2.5 text-sm transition-colors",
      props.active ? "text-ink" : "text-ink-3 hover:text-ink",
      external() && href() === null ? "pointer-events-none text-ink-4" : "",
    ].join(" ");

  return (
    <Show
      when={external()}
      fallback={
        <A
          to="/list/$listId/view/$viewId"
          params={{ listId: props.view.listId, viewId: props.view.id }}
          title={title()}
          aria-current={props.active ? "page" : undefined}
          class={classes()}
        >
          {label}
          {marker}
        </A>
      }
    >
      {/* No href until the session has loaded, since the workspace id is half
          the address. That window is one round trip at boot. */}
      {/* Marked current too: a deep link can land on one of these, and the tab
          the route is on should say so whether or not Rask draws it. */}
      <a
        href={href() ?? undefined}
        target="_blank"
        rel="noreferrer"
        title={title()}
        aria-current={props.active ? "page" : undefined}
        class={classes()}
      >
        {label}
        {marker}
      </a>
    </Show>
  );
}

/**
 * Where a deep link to a view Rask cannot draw lands.
 *
 * The tab bar already says these open ClickUp, but a pasted URL arrives without
 * having passed a tab, so the same thing has to be said here. Naming the type
 * rather than showing a generic error is the difference between "Rask is
 * broken" and "Rask does not do this one".
 */
export function UnsupportedView(props: { view: ListView }): JSX.Element {
  const href = () => clickUpViewUrl(props.view, me()?.teamId ?? null);

  return (
    <div class="flex flex-1 items-start justify-center overflow-y-auto px-6 pt-[18vh] pb-8">
      <div class="w-full max-w-[380px]">
        <h2 class="font-medium text-base text-ink tracking-[-0.005em]">{props.view.name}</h2>
        <p class="mt-1.5 text-ink-3 text-sm leading-relaxed">
          Rask does not draw {viewTypeLabel(props.view.type)} views. It shows tasks in a list, and a{" "}
          {viewTypeLabel(props.view.type)} is a different thing wearing the same tab — an imitation
          of one would be worse than the real one.
        </p>
        <Show when={href()}>
          {(url) => (
            <a
              href={url()}
              target="_blank"
              rel="noreferrer"
              class="mt-4 inline-flex items-center gap-1.5 text-accent text-sm hover:underline"
            >
              Open in ClickUp
              <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                class="shrink-0"
                aria-hidden="true"
              >
                <path
                  d="M6 3h7v7M13 3 4 12"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </a>
          )}
        </Show>
      </div>
    </div>
  );
}
