import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  icon?: JSX.Element;
}

/**
 * A single popover pattern, reused by the status, assignee, priority and
 * command menus.
 *
 * It is keyboard-first on purpose: arrow keys and typing filter, Enter commits,
 * Escape backs out, and the mouse is optional everywhere. Anchoring is
 * deliberately simple, clamped to the viewport rather than computed with a
 * positioning engine.
 */
export function Menu(props: {
  items: MenuItem[];
  anchor: { x: number; y: number } | null;
  placeholder?: string;
  width?: number;
  onSelect: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let input!: HTMLInputElement;

  const filtered = () => {
    const q = query().trim().toLowerCase();
    return q ? props.items.filter((item) => item.label.toLowerCase().includes(q)) : props.items;
  };

  createEffect(() => {
    query();
    setActive(0);
  });

  createEffect(() => {
    if (props.anchor) queueMicrotask(() => input?.focus());
  });

  /**
   * Selects, and puts the caret back in the box.
   *
   * A click leaves focus on the item, and a menu that stays open after a
   * selection rebuilds its rows — so the focused element is removed and focus
   * falls back to the body. Every key after that reaches the shell instead of
   * this popover, and the shell reads a stray Escape as "close the task": in
   * the subtask column picker, ticking a column and then backing out took the
   * whole detail panel with it.
   */
  const select = (id: string) => {
    props.onSelect(id);
    queueMicrotask(() => {
      if (input?.isConnected) input.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const items = filtered();
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[active()];
      if (item) select(item.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
    event.stopPropagation();
  };

  const dismiss = (event: MouseEvent) => {
    if (!(event.target as HTMLElement).closest("[data-menu]")) props.onClose();
  };
  document.addEventListener("mousedown", dismiss);
  onCleanup(() => document.removeEventListener("mousedown", dismiss));

  const width = () => props.width ?? 240;
  // Clamp so a menu opened near the right or bottom edge stays fully visible.
  const left = () => Math.min(props.anchor?.x ?? 0, window.innerWidth - width() - 12);
  const top = () => Math.min(props.anchor?.y ?? 0, window.innerHeight - 320);

  return (
    <Show when={props.anchor}>
      <div
        data-menu
        class="floating fixed z-50 overflow-hidden rounded-lg"
        style={{ left: `${left()}px`, top: `${top()}px`, width: `${width()}px` }}
      >
        <div class="border-line/80 border-b px-3">
          <input
            ref={input}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            placeholder={props.placeholder ?? "Search..."}
            class="h-9 w-full text-md text-ink"
          />
        </div>

        <div role="listbox" class="max-h-[280px] overflow-y-auto p-1">
          <For
            each={filtered()}
            fallback={<div class="px-3 py-4 text-center text-ink-4 text-xs">No matches</div>}
          >
            {(item, index) => (
              <button
                type="button"
                role="option"
                aria-selected={active() === index()}
                onMouseEnter={() => setActive(index())}
                onClick={() => select(item.id)}
                class="flex h-8 w-full items-center gap-2.5 rounded-[5px] px-2 text-md"
                classList={{
                  "row-selected text-ink": active() === index(),
                  "text-ink-2": active() !== index(),
                }}
              >
                <Show when={item.icon}>{item.icon}</Show>
                <span class="flex-1 truncate text-left">{item.label}</span>
                <Show when={item.hint}>
                  <span class="font-mono text-xs text-ink-4">{item.hint}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
