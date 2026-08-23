import { For, type JSX } from "solid-js";

/**
 * The shortcut sheet, on `?`.
 *
 * Twelve shortcuts existed and two were discoverable, which is a strange thing
 * for a keyboard-first client: most people would have used the mouse forever
 * because nothing ever told them `s` changes status.
 */
const GROUPS: Array<{ title: string; items: Array<[keys: string[], label: string]> }> = [
  {
    title: "Move",
    items: [
      [["j"], "Next task"],
      [["k"], "Previous task"],
      [["g", "g"], "Jump to top"],
      [["G"], "Jump to bottom"],
      [["↵"], "Open task"],
      [["esc"], "Close, or clear filters"],
    ],
  },
  {
    title: "Act",
    items: [
      [["c"], "New task"],
      [["s"], "Change status"],
      [["p"], "Set priority"],
      [["/"], "Search this view"],
      [["F"], "Add a filter"],
      [["f"], "Expand the open task"],
    ],
  },
  {
    title: "In the filter menu",
    items: [
      [["↵"], "Add or remove a value"],
      [["Tab"], '"is" or "is not"'],
      [["⌫"], "Back to the field list"],
    ],
  },
  {
    title: "Board",
    items: [
      [["b"], "List or board"],
      [["h", "l"], "Previous, next column"],
      [["H"], "Move card left"],
      [["L"], "Move card right"],
    ],
  },
  {
    title: "Anywhere",
    items: [
      [["⌘", "K"], "Command palette"],
      [[":"], "Command palette"],
      [["?"], "This sheet"],
    ],
  },
];

export function Shortcuts(props: { onClose: () => void }): JSX.Element {
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close"
        class="absolute inset-0 bg-scrim"
        onClick={props.onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        class="floating relative w-[560px] rounded-xl px-6 py-5"
      >
        <h2 class="pb-4 font-medium text-base text-ink">Keyboard shortcuts</h2>

        <div class="grid grid-cols-2 gap-x-8 gap-y-5">
          <For each={GROUPS}>
            {(group) => (
              <section>
                <h3 class="pb-2 font-medium text-xs text-ink-3 uppercase tracking-[0.04em]">
                  {group.title}
                </h3>
                <ul class="space-y-1.5">
                  <For each={group.items}>
                    {([keys, label]) => (
                      <li class="flex items-center justify-between gap-4">
                        <span class="text-sm text-ink-2">{label}</span>
                        <span class="flex shrink-0 items-center gap-1">
                          <For each={keys}>
                            {(key) => (
                              <kbd class="rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-xs text-ink-2">
                                {key}
                              </kbd>
                            )}
                          </For>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
        </div>

        <p class="pt-5 text-xs text-ink-3">esc to close</p>
      </div>
    </div>
  );
}
