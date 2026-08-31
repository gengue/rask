import { createEffect, createSignal, For, type JSX, onCleanup, onMount } from "solid-js";
import type { DocRef, Space } from "../lib/api.ts";
import { rankCommands } from "../lib/rank.ts";

export interface Command {
  id: string;
  label: string;
  section: string;
  hint?: string;
  run: () => void;
}

/**
 * ⌘K. Navigation and every keyboard action in one place.
 *
 * The list is scored, not just filtered: a subsequence match ranks by how early
 * and how contiguously the query appears, so "eng" finds "Engineering" above
 * "Marketing Team Tasks".
 */
export function CommandPalette(props: {
  commands: Command[];
  /** Optional async source, queried as you type. Backs task search. */
  search?: (query: string) => Promise<Command[]>;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;

  onMount(() => input.focus());

  const [found, setFound] = createSignal<Command[]>([]);

  /*
   * Debounced, because this one goes to the server.
   *
   * Two characters is where a substring match stops returning half the
   * workspace. 140ms is about one keystroke at a normal typing speed, so a word
   * typed straight through costs one request rather than seven.
   */
  createEffect(() => {
    const q = query().trim();
    const search = props.search;
    if (!search || q.length < 2) {
      setFound([]);
      return;
    }

    let live = true;
    const timer = setTimeout(() => {
      void search(q)
        .then((hits: Command[]) => live && setFound(hits))
        .catch(() => live && setFound([]));
    }, 140);

    onCleanup(() => {
      live = false;
      clearTimeout(timer);
    });
  });

  // Local commands are already ranked against the query; task hits arrive
  // ranked by the server, so they append rather than re-sort.
  const results = () => [...rankCommands(props.commands, query()), ...found()];

  createEffect(() => {
    query();
    setActive(0);
  });

  createEffect(() => {
    const element = list?.querySelector<HTMLElement>(`[data-index="${active()}"]`);
    element?.scrollIntoView({ block: "nearest" });
  });

  const onKeyDown = (event: KeyboardEvent) => {
    const items = results();
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      setActive((i) => (i + 1) % Math.max(1, items.length));
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      setActive((i) => (i - 1 + items.length) % Math.max(1, items.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      items[active()]?.run();
      props.onClose();
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
    event.stopPropagation();
  };

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]">
      <button
        type="button"
        aria-label="Close"
        class="absolute inset-0 bg-scrim"
        onClick={props.onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        class="floating relative w-[620px] overflow-hidden rounded-xl"
      >
        <div class="border-line/80 border-b px-4">
          <input
            ref={input}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            placeholder="Search lists and commands…"
            class="h-12 w-full text-md text-ink"
          />
        </div>

        <div ref={list} class="max-h-[380px] overflow-y-auto p-1.5">
          <For
            each={results()}
            fallback={<div class="px-3 py-8 text-center text-ink-4 text-xs">No results</div>}
          >
            {(command, index) => (
              <button
                type="button"
                data-index={index()}
                onMouseEnter={() => setActive(index())}
                onClick={() => {
                  command.run();
                  props.onClose();
                }}
                class="flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-md"
                classList={{
                  "row-selected text-ink": active() === index(),
                  "text-ink-2": active() !== index(),
                }}
              >
                <span class="w-[92px] shrink-0 truncate text-left text-xs text-ink-4">
                  {command.section}
                </span>
                <span class="flex-1 truncate text-left">{command.label}</span>
                <span class="font-mono text-xs text-ink-4">{command.hint}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

/**
 * Everything in the workspace tree, as one typeable list.
 *
 * Docs are in here for the same reason Lists are: the sidebar's own argument
 * for hiding below `dock` is that ⌘K reaches anything by typing it, and a row
 * you can see but cannot search makes that false. A Doc and a List can share a
 * name, so the ids are prefixed by kind rather than by parent.
 */
export function buildNavigationCommands(
  tree: { spaces: Space[]; docs: DocRef[] },
  go: { list: (listId: string) => void; doc: (docId: string) => void },
): Command[] {
  const docCommands = (docs: DocRef[], section: string, prefix = "") =>
    docs.map((doc) => ({
      id: `doc:${doc.id}`,
      label: `${prefix}${doc.name}`,
      section,
      run: () => go.doc(doc.id),
    }));

  return [
    ...tree.spaces.flatMap((space) => [
      ...space.lists.map((list) => ({
        id: `list:${list.id}`,
        label: list.name,
        section: space.name,
        run: () => go.list(list.id),
      })),
      ...space.lists.flatMap((list) => docCommands(list.docs, space.name, `${list.name} / `)),
      ...docCommands(space.docs, space.name),
      ...space.folders.flatMap((folder) => [
        ...folder.lists.map((list) => ({
          id: `list:${list.id}`,
          label: `${folder.name} / ${list.name}`,
          section: space.name,
          run: () => go.list(list.id),
        })),
        ...folder.lists.flatMap((list) =>
          docCommands(list.docs, space.name, `${folder.name} / ${list.name} / `),
        ),
        ...docCommands(folder.docs, space.name, `${folder.name} / `),
      ]),
    ]),
    // The ones ClickUp files at the Workspace, which have no Space to name.
    ...docCommands(tree.docs, "Docs"),
  ];
}
