import { type JSX, onCleanup, onMount, Show } from "solid-js";
import { resolvedTheme } from "../lib/theme.ts";

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
  const retry = () => (props.reset ? props.reset() : window.location.reload());

  return (
    <Show when={resolvedTheme() === "xp"} fallback={<Plain message={message()} onRetry={retry} />}>
      <BlueScreen message={message()} onRetry={retry} />
    </Show>
  );
}

function Plain(props: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div class="text-md text-ink">Something broke on the way to this view</div>
      <div class="max-w-[420px] break-words text-sm text-ink-3">{props.message}</div>
      <div class="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={props.onRetry}
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

/**
 * Presses that are not "any key". Tab is among them because focus still has to
 * reach the two real controls below — without that the hint is the only way
 * out, for exactly the people it does not serve.
 */
const NOT_A_KEY = new Set(["Tab", "Shift", "Control", "Alt", "Meta", "CapsLock", "ContextMenu"]);

/**
 * The same page under the XP theme: a stop error.
 *
 * The joke only works if the page still does its job, so nothing it did is
 * lost. The real message is where the technical information goes, "press any
 * key" is wired to the same reset the button calls, and the button and the
 * link are both still there — a line of prose telling you to press a key is
 * not a control that anything but a keyboard can use.
 *
 * It is fixed and above everything rather than laid out in the shell, because
 * the shell under this theme has a title bar and a menu bar drawn across the
 * top and a blue screen politely inside a window is not a blue screen.
 */
function BlueScreen(props: { message: string; onRetry: () => void }): JSX.Element {
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (NOT_A_KEY.has(event.key)) return;
      event.preventDefault();
      props.onRetry();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="xp-bsod" role="alert">
      <div class="xp-bsod-page selectable">
        <p>
          A problem has been detected and Rask has been shut down to prevent damage to your
          workspace.
        </p>
        <p>ROUTE_RENDER_FAILED</p>
        <p>
          If this is the first time you've seen this stop error screen, try again. If this screen
          appears again, follow these steps:
        </p>
        <p>
          Check that you are still signed in and that the API is answering. A request that failed
          while the page was drawing usually succeeds on the next attempt.
        </p>
        <p>Technical information:</p>
        <p class="break-words">*** STOP: 0x0000RA5C ({props.message})</p>
        <p>
          <button type="button" class="xp-bsod-link" onClick={props.onRetry}>
            Press any key to try again
          </button>
          <span class="xp-caret" aria-hidden="true">
            {" _"}
          </span>
        </p>
        <p>
          <a class="xp-bsod-link" href="/">
            Or return to My Tasks
          </a>
        </p>
      </div>
    </div>
  );
}
