import { For, type JSX, Show } from "solid-js";
import { A } from "../lib/nav.tsx";
import { spaces } from "../lib/session.ts";

/**
 * Where a ClickUp URL lands when Rask cannot open it directly.
 *
 * Same visual language as the rest of the app: no illustration, no card, just
 * text on the panel and one accent-coloured way out.
 */
function Screen(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-1 items-start justify-center overflow-y-auto px-6 pt-[18vh] pb-8">
      <div class="w-full max-w-[380px]">
        <h2 class="font-medium text-base text-ink tracking-[-0.005em]">{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

function BackLink(): JSX.Element {
  return (
    <A to="/" class="mt-4 inline-block text-sm text-accent hover:underline">
      Go to My Tasks
    </A>
  );
}

export function NotFound(props: { path: string }): JSX.Element {
  return (
    <Screen title="Not found in this workspace">
      <p class="mt-1.5 text-sm text-ink-3 leading-relaxed">
        Nothing in the mirror matches this address. If it is a ClickUp link, the task or list may
        live in a workspace Rask is not signed in to.
      </p>
      <p class="selectable mt-3 truncate font-mono text-xs text-ink-4">{props.path}</p>
      <BackLink />
    </Screen>
  );
}

/**
 * Folders and Spaces resolve, but Rask has no view for either: it shows tasks,
 * and a Space is not a set of tasks so much as a place lists live. Inventing a
 * Space view to satisfy a URL shape would be a whole feature arriving sideways.
 * Naming what the id is and offering its lists is the honest middle: the link
 * still gets the user where they were going, in one more click.
 */
export function ListPicker(props: {
  kind: "folder" | "space";
  id: string;
  name: string;
}): JSX.Element {
  const lists = () => listsIn(props.kind, props.id);

  return (
    <Screen title={props.name}>
      <p class="mt-1.5 text-sm text-ink-3 leading-relaxed">
        That is a {props.kind}, and Rask only shows lists. Pick one:
      </p>

      <Show
        when={lists().length > 0}
        fallback={<p class="mt-3 text-sm text-ink-4">No lists in it yet.</p>}
      >
        <div class="mt-3 flex flex-col gap-px">
          <For each={lists()}>
            {(list) => (
              <A
                to="/list/$listId"
                params={{ listId: list.id }}
                class="flex h-7 items-center gap-2 rounded-[5px] px-2 text-base text-ink-2 hover:bg-hover hover:text-ink"
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
                <span class="truncate">{list.name}</span>
              </A>
            )}
          </For>
        </div>
      </Show>

      <BackLink />
    </Screen>
  );
}

/** The sidebar tree is already loaded, so this costs no round trip. */
function listsIn(kind: "folder" | "space", id: string): Array<{ id: string; name: string }> {
  for (const space of spaces()) {
    if (kind === "space" && space.id === id) {
      return [...space.lists, ...space.folders.flatMap((folder) => folder.lists)];
    }
    if (kind === "folder") {
      const folder = space.folders.find((candidate) => candidate.id === id);
      if (folder) return folder.lists;
    }
  }
  return [];
}
