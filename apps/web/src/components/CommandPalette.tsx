import { createEffect, createSignal, For, type JSX, onMount } from "solid-js";
import type { Space } from "../lib/api.ts";

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
export function CommandPalette(props: { commands: Command[]; onClose: () => void }): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;

  onMount(() => input.focus());

  const results = () => rank(props.commands, query());

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
        class="absolute inset-0 bg-black/45"
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
            class="h-12 w-full text-[15px] text-ink"
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
                class="flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-[13px]"
                classList={{
                  "bg-white/[0.08] text-ink": active() === index(),
                  "text-ink-2": active() !== index(),
                }}
              >
                <span class="w-[92px] shrink-0 truncate text-left text-[11px] text-ink-4">
                  {command.section}
                </span>
                <span class="flex-1 truncate text-left">{command.label}</span>
                <span class="font-mono text-[11px] text-ink-4">{command.hint}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

/** Subsequence match, scored by contiguity and how early the match starts. */
function rank(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;

  const scored: Array<{ command: Command; score: number }> = [];

  for (const command of commands) {
    const haystack = `${command.label} ${command.section}`.toLowerCase();
    let index = 0;
    let score = 0;
    let previous = -1;

    for (const char of q) {
      const found = haystack.indexOf(char, index);
      if (found === -1) {
        score = -1;
        break;
      }
      score += found === previous + 1 ? 3 : 1;
      if (found === 0 || haystack[found - 1] === " ") score += 2;
      previous = found;
      index = found + 1;
    }

    if (score > 0) scored.push({ command, score: score - haystack.length * 0.01 });
  }

  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.command);
}

export function buildNavigationCommands(spaces: Space[], go: (listId: string) => void): Command[] {
  return spaces.flatMap((space) => [
    ...space.lists.map((list) => ({
      id: `list:${list.id}`,
      label: list.name,
      section: space.name,
      run: () => go(list.id),
    })),
    ...space.folders.flatMap((folder) =>
      folder.lists.map((list) => ({
        id: `list:${list.id}`,
        label: `${folder.name} / ${list.name}`,
        section: space.name,
        run: () => go(list.id),
      })),
    ),
  ]);
}
