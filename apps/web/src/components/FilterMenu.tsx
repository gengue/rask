import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import type { Choice, FieldDef } from "../lib/filter-menu.ts";
import type { Clause } from "../lib/filters.ts";
import { StatusIcon } from "./StatusIcon.tsx";

/**
 * The filter builder: pick a field, then pick as many of its values as you like.
 *
 * Two steps in one popover rather than a dialog, because a filter is built one
 * clause at a time and the row of chips behind it is the rest of the answer.
 *
 * Keyboard-first, which for a multi-select means Enter cannot also mean "done":
 * it toggles the value under the cursor and the menu stays open, so "Open,
 * In review, Blocked" is three keystrokes and not three trips through a menu.
 * Escape closes, Backspace on an empty box goes back to the field list, and
 * Tab flips the whole clause between "any of these" and "none of these" —
 * negation is a property of the clause, not a fourth thing to pick.
 */
export function FilterMenu(props: {
  anchor: { x: number; y: number };
  /** Null while the field is still being chosen. */
  field: string | null;
  fields: FieldDef[];
  choices: Choice[];
  clause: Clause | undefined;
  /** True when the choices came from the rows on screen, not from a definition. */
  partial: boolean;
  chosen: (value: string) => boolean;
  onPickField: (field: string) => void;
  onToggle: (value: string) => void;
  onNegate: () => void;
  onBack: () => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;

  const items = (): Array<{ id: string; label: string; choice?: Choice }> => {
    const q = query().trim().toLowerCase();
    const rows = props.field
      ? props.choices.map((choice) => ({ id: choice.value, label: choice.label, choice }))
      : props.fields.map((def) => ({ id: def.field, label: def.label }));
    return q ? rows.filter((row) => row.label.toLowerCase().includes(q)) : rows;
  };

  /*
   * A new step is a new list; row 7 of the field list is not row 7 of the
   * values, and "sever" typed to find the Severity field matches none of that
   * field's options.
   *
   * `on` rather than reading `props.field` as a bare statement inside the
   * effect. That form only tracks if the transform keeps an expression whose
   * value nothing uses, which is exactly the kind of line a bundler is entitled
   * to drop — and when it does, the box keeps the field name you typed and the
   * value list shows "No matches".
   */
  createEffect(
    on(
      () => props.field,
      () => {
        setQuery("");
        setActive(0);
        queueMicrotask(() => input?.focus());
      },
    ),
  );

  createEffect(() => {
    query();
    setActive(0);
  });

  createEffect(() => {
    list?.querySelector<HTMLElement>(`[data-index="${active()}"]`)?.scrollIntoView({
      block: "nearest",
    });
  });

  const commit = (id: string) => {
    if (props.field) props.onToggle(id);
    else props.onPickField(id);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const rows = items();
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      setActive((index) => Math.min(rows.length - 1, index + 1));
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active()];
      if (row) commit(row.id);
    } else if (event.key === "Tab" && props.field) {
      event.preventDefault();
      props.onNegate();
    } else if (event.key === "Backspace" && query() === "" && props.field) {
      event.preventDefault();
      props.onBack();
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

  const WIDTH = 262;
  const left = () => Math.min(props.anchor.x, window.innerWidth - WIDTH - 12);
  const top = () => Math.min(props.anchor.y, window.innerHeight - 340);

  const negated = () => props.clause?.op === "NOT ANY" || props.clause?.op === "IS SET";

  return (
    <div
      data-menu
      class="floating fixed z-50 overflow-hidden rounded-lg"
      style={{ left: `${left()}px`, top: `${top()}px`, width: `${WIDTH}px` }}
    >
      <div class="flex items-center gap-1.5 border-line/80 border-b px-3">
        <Show when={props.field}>
          <button
            type="button"
            aria-label="Back to fields"
            onClick={props.onBack}
            class="-ml-1 shrink-0 rounded-[4px] px-1 py-0.5 text-ink-3 text-xs hover:bg-hover hover:text-ink"
          >
            ‹
          </button>
        </Show>
        <input
          ref={input}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={props.field ? "Value…" : "Filter by…"}
          class="h-9 min-w-0 flex-1 text-md text-ink"
        />
        <Show when={props.field}>
          {/* The one control that is not a value. It says what it will do, not
              what it is, because "NOT ANY" is a wire format and "is not" is a
              sentence. */}
          <button
            type="button"
            onClick={props.onNegate}
            title="Tab"
            aria-pressed={negated()}
            class="shrink-0 rounded-[4px] px-1.5 py-0.5 font-medium text-xs transition-colors"
            classList={{
              "bg-accent-soft text-ink": negated(),
              "text-ink-4 hover:bg-hover hover:text-ink-2": !negated(),
            }}
          >
            is not
          </button>
        </Show>
      </div>

      <div ref={list} role="listbox" class="max-h-[264px] overflow-y-auto p-1">
        <For
          each={items()}
          fallback={<div class="px-3 py-4 text-center text-ink-4 text-xs">No matches</div>}
        >
          {(row, index) => (
            <button
              type="button"
              role="option"
              data-index={index()}
              aria-selected={active() === index()}
              onMouseEnter={() => setActive(index())}
              onClick={() => commit(row.id)}
              class="flex h-8 w-full items-center gap-2.5 rounded-[5px] px-2 text-md"
              classList={{
                "row-selected text-ink": active() === index(),
                "text-ink-2": active() !== index(),
              }}
            >
              <Show when={row.choice?.statusType !== undefined}>
                <StatusIcon
                  type={row.choice?.statusType ?? null}
                  color={row.choice?.color ?? null}
                  size={13}
                />
              </Show>
              <span class="flex-1 truncate text-left">{row.label}</span>
              <Show
                when={props.field && props.chosen(row.id)}
                fallback={
                  <Show when={!props.field}>
                    <span class="text-ink-4 text-xs">›</span>
                  </Show>
                }
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="m3.5 8.5 3 3 6-7"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </Show>
            </button>
          )}
        </For>
      </div>

      {/*
        Says where the choices came from when they came from the rows on screen.
        A list of 5,696 tasks loads 500, and a status menu built from those 500
        cannot name a status nobody in them is in — which is exactly the kind of
        thing that has to be on screen rather than in a comment.
      */}
      <Show when={props.field && props.partial}>
        <p class="border-line/80 border-t px-3 py-1.5 text-[11px] text-ink-4 leading-snug">
          From the tasks loaded here, not the whole workspace.
        </p>
      </Show>
    </div>
  );
}
