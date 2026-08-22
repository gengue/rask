import { For, type JSX, Show } from "solid-js";
import { dismissToast, toasts } from "../lib/toast.ts";

/** Bottom-left, out of the way of the detail panel and the command palette. */
export function Toasts(): JSX.Element {
  return (
    <div class="pointer-events-none fixed bottom-4 left-4 z-[60] flex w-[340px] flex-col gap-2">
      <For each={toasts()}>
        {(toast) => (
          <div class="floating pointer-events-auto flex items-start gap-2.5 rounded-lg px-3 py-2.5">
            <span
              class="mt-[5px] size-1.5 shrink-0 rounded-full"
              classList={{
                "bg-urgent": toast.tone === "error",
                "bg-accent": toast.tone === "info",
              }}
            />
            <div class="min-w-0 flex-1">
              <div class="text-base text-ink">{toast.title}</div>
              <Show when={toast.detail}>
                <div class="truncate text-xs text-ink-3">{toast.detail}</div>
              </Show>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismissToast(toast.id)}
              class="shrink-0 text-ink-4 hover:text-ink-2"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="m4 4 8 8M12 4l-8 8"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
