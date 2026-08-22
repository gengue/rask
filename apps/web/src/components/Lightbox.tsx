import { type JSX, onCleanup, onMount, Show } from "solid-js";
import { closeLightbox, gallery, installMarkdownImageZoom, stepLightbox } from "../lib/lightbox.ts";

/**
 * Full-screen image viewer.
 *
 * Mounted once by the shell and empty until something opens it. That is also
 * what installs the click handler that turns every image inside a rendered
 * description or comment into a way in.
 *
 * A real dialog, not a div that looks like one: focus moves in on open and back
 * to whatever opened it on close, Tab cannot leave, and `aria-modal` tells a
 * screen reader that the rest of the page is not there for now.
 */
export function Lightbox(): JSX.Element {
  onMount(() => onCleanup(installMarkdownImageZoom()));

  return (
    <Show when={gallery()}>
      <Viewer />
    </Show>
  );
}

function Viewer(): JSX.Element {
  let dialog!: HTMLDivElement;

  const images = () => gallery()?.images ?? [];
  const index = () => gallery()?.index ?? 0;
  const current = () => images()[index()];
  const many = () => images().length > 1;

  onMount(() => {
    /*
     * Everything below uses preventScroll.
     *
     * The task panel is the scroll container, not the window, and focusing an
     * element inside a `position: fixed` overlay is enough to make the browser
     * scroll that container to where it thinks the element is. Opening a
     * screenshot and finding the conversation behind it jumped is the exact
     * thing this is here to stop.
     */
    const restore = document.activeElement;
    dialog.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          closeLightbox();
          return;
        case "ArrowRight":
        case "ArrowDown":
          if (many()) {
            event.preventDefault();
            stepLightbox(1);
          }
          return;
        case "ArrowLeft":
        case "ArrowUp":
          if (many()) {
            event.preventDefault();
            stepLightbox(-1);
          }
          return;
        case "Tab":
          trapTab(event, dialog);
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      if (restore instanceof HTMLElement) restore.focus({ preventScroll: true });
    });
  });

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      {/* Clicking the backdrop closes, which for an image viewer means clicking
          almost anywhere. The image sits above it and does not. */}
      <button
        type="button"
        aria-label="Close"
        tabindex="-1"
        class="absolute inset-0 bg-black/90"
        onClick={closeLightbox}
      />

      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={current()?.alt || "Image"}
        tabindex="-1"
        class="relative flex h-full w-full flex-col items-center justify-center gap-3 p-8 outline-none"
      >
        <img
          src={current()?.src}
          alt={current()?.alt ?? ""}
          class="min-h-0 max-w-full flex-1 rounded-[6px] object-contain"
        />

        {/* A markdown image has no name and a gallery of one has no count, so
            the whole strip goes rather than reserving space for nothing. */}
        <Show when={current()?.alt || many() || current()?.href}>
          <div class="flex h-5 shrink-0 items-center gap-3 text-[11px] text-ink-3">
            <Show when={current()?.alt}>
              <span class="max-w-[420px] truncate">{current()?.alt}</span>
            </Show>
            <Show when={many()}>
              <span class="tabular-nums">
                {index() + 1} / {images().length}
              </span>
            </Show>
            <Show when={current()?.href}>
              {(href) => (
                <a
                  href={href()}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-accent hover:underline"
                >
                  Open original
                </a>
              )}
            </Show>
          </div>
        </Show>

        <Show when={many()}>
          <Arrow side="left" onClick={() => stepLightbox(-1)} />
          <Arrow side="right" onClick={() => stepLightbox(1)} />
        </Show>

        <button
          type="button"
          onClick={closeLightbox}
          title="Close  Esc"
          aria-label="Close"
          class="absolute top-4 right-4 flex size-7 items-center justify-center rounded-[5px] text-ink-3 hover:bg-white/[0.08] hover:text-ink"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function Arrow(props: { side: "left" | "right"; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props.side === "left" ? "Previous image" : "Next image"}
      class="-translate-y-1/2 absolute top-1/2 flex size-9 items-center justify-center rounded-full border border-line-strong bg-overlay text-ink-2 hover:bg-elevated hover:text-ink"
      classList={{ "left-5": props.side === "left", "right-5": props.side === "right" }}
    >
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d={props.side === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"}
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  );
}

/** Keeps Tab inside the dialog by wrapping at either end. */
function trapTab(event: KeyboardEvent, dialog: HTMLElement): void {
  const focusable = [
    ...dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
  ].filter((el) => el.tabIndex >= 0);

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
    return;
  }

  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}
