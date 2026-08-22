import { createSignal } from "solid-js";

/**
 * The image the lightbox is showing, if any.
 *
 * A module-level signal rather than a prop, because nothing that opens the
 * lightbox knows about it: images arrive inside rendered markdown, as HTML, in
 * a description or a comment. The `<Lightbox />` mounted once in the shell
 * picks the click up by delegation and there is nothing to thread through.
 */
export interface LightboxImage {
  src: string;
  alt: string;
}

const [image, setImage] = createSignal<LightboxImage | null>(null);

export { image as lightboxImage };

export function openLightbox(next: LightboxImage): void {
  setImage(next);
}

export function closeLightbox(): void {
  setImage(null);
}
