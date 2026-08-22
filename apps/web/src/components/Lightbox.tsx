import { type JSX, onCleanup, Show } from "solid-js";
import { closeLightbox, lightboxImage, openLightbox } from "../lib/lightbox.ts";

/**
 * Full-size view of an image inside a description or a comment.
 *
 * Mounted once in the shell and wired by delegation, so nothing that renders
 * markdown has to know this exists. Both listeners are on the capture phase:
 * the description sits inside a button that starts editing on click, and the
 * shell owns a single Escape handler that closes the task — this has to take
 * the event before either of them sees it.
 */
export function Lightbox(): JSX.Element {
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    if (!target.closest(".prose-rask")) return;

    event.preventDefault();
    event.stopPropagation();
    openLightbox({ src: target.currentSrc || target.src, alt: target.alt });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !lightboxImage()) return;
    event.preventDefault();
    event.stopPropagation();
    closeLightbox();
  };

  document.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
  onCleanup(() => {
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKeyDown, true);
  });

  return (
    <Show when={lightboxImage()}>
      {(image) => (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={image().alt || "Image"}
          class="fixed inset-0 z-60 flex flex-col"
        >
          <button
            type="button"
            aria-label="Close"
            class="absolute inset-0 cursor-zoom-out bg-black/85"
            onClick={closeLightbox}
          />

          <header class="relative flex h-11 shrink-0 items-center gap-3 px-4">
            <span class="min-w-0 truncate text-[12px] text-ink-2">{image().alt}</span>
            <div class="flex-1" />
            <a
              href={image().src}
              target="_blank"
              rel="noreferrer"
              class="rounded-[4px] px-2 py-1 text-[11px] text-ink-3 hover:bg-white/[0.06] hover:text-ink"
            >
              Open original
            </a>
            <button
              type="button"
              onClick={closeLightbox}
              class="rounded-[4px] px-2 py-1 text-[11px] text-ink-3 hover:bg-white/[0.06] hover:text-ink"
            >
              esc
            </button>
          </header>

          {/* The scrim behind takes the click; this element only centres. */}
          <div class="pointer-events-none relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
            <img
              src={image().src}
              alt={image().alt}
              class="max-h-full max-w-full rounded-[6px] object-contain"
            />
          </div>
        </div>
      )}
    </Show>
  );
}
