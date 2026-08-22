import type { JSX } from "solid-js";

/**
 * What the app shows when a route throws.
 *
 * Without this a single failed fetch during render — the API restarting, a
 * dropped connection — throws out of the route and the router unmounts the
 * whole tree. The window goes white and stays white until someone reloads,
 * which is a harsh punishment for a request that would have succeeded a second
 * later.
 */
export function RouteError(props: { error: unknown; reset?: () => void }): JSX.Element {
  const message = () =>
    props.error instanceof Error ? props.error.message : String(props.error ?? "Unknown error");

  return (
    <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div class="text-base text-ink">Something broke on the way to this view</div>
      <div class="max-w-[420px] break-words text-sm text-ink-3">{message()}</div>
      <div class="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => (props.reset ? props.reset() : window.location.reload())}
          class="rounded-[5px] bg-accent px-2.5 py-1 font-medium text-sm text-on-accent"
        >
          Try again
        </button>
        <a href="/" class="rounded-[5px] px-2.5 py-1 text-sm text-ink-3 hover:text-ink-2">
          My Tasks
        </a>
      </div>
    </div>
  );
}
