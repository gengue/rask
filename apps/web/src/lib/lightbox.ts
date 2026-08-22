import { createSignal } from "solid-js";

/**
 * The one image viewer, shared by everything that shows an image.
 *
 * State lives here rather than in the component so a thumbnail deep inside the
 * detail panel can open it without threading a callback up through four
 * parents, and so the shell's keyboard handler can ask whether it is up without
 * importing the view.
 */
export interface LightboxImage {
  src: string;
  alt: string;
  /**
   * Where "Open original" points. ClickUp's plain URL comes back as a download;
   * the `?view=open` variant renders in the tab, so callers pass that when they
   * have it.
   */
  href?: string;
}

interface Gallery {
  images: LightboxImage[];
  index: number;
}

const [gallery, setGallery] = createSignal<Gallery | null>(null);

export { gallery };

/** True while the viewer is up. The shell reads this to stand down. */
export function lightboxOpen(): boolean {
  return gallery() !== null;
}

export function openLightbox(images: LightboxImage[], index = 0): void {
  if (images.length === 0) return;
  setGallery({ images, index: clamp(index, images.length) });
}

export function closeLightbox(): void {
  setGallery(null);
}

/** Wraps at both ends: at the last image, → goes back to the first. */
export function stepLightbox(delta: number): void {
  setGallery((current) => {
    if (!current) return current;
    const count = current.images.length;
    return { ...current, index: (current.index + delta + count) % count };
  });
}

export function showLightboxIndex(index: number): void {
  setGallery((current) =>
    current ? { ...current, index: clamp(index, current.images.length) } : current,
  );
}

function clamp(index: number, count: number): number {
  return Math.min(Math.max(index, 0), count - 1);
}

/**
 * Makes every image inside rendered markdown open the viewer.
 *
 * Delegated from the document rather than wired per call site: descriptions and
 * comments are set with innerHTML, so there are no elements to attach handlers
 * to, and the alternative is a wrapper component threaded through every place
 * that renders prose.
 *
 * Capture phase, and it stops the event. The description is a button that opens
 * the editor when clicked, and clicking a screenshot inside it should show the
 * screenshot, not put the markdown into an editor.
 */
export function installMarkdownImageZoom(): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const image = target.closest("img");
    const prose = image?.closest(".prose-rask");
    if (!image || !prose) return;

    // The whole block is the gallery, so ← and → walk the screenshots in one
    // description the same way they walk the ones attached to the task.
    const images = [...prose.querySelectorAll("img")];
    const index = images.indexOf(image);
    if (index < 0) return;

    event.preventDefault();
    event.stopPropagation();
    openLightbox(
      images.map((el) => ({ src: el.currentSrc || el.src, alt: el.alt || "" })),
      index,
    );
  };

  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
