import { beforeEach, describe, expect, test } from "bun:test";
import {
  closeLightbox,
  gallery,
  type LightboxImage,
  lightboxOpen,
  openLightbox,
  showLightboxIndex,
  stepLightbox,
} from "../src/lib/lightbox.ts";

const images: LightboxImage[] = [
  { src: "a.png", alt: "a" },
  { src: "b.png", alt: "b" },
  { src: "c.png", alt: "c" },
];

beforeEach(() => closeLightbox());

describe("openLightbox", () => {
  test("opens on the image that was clicked", () => {
    openLightbox(images, 1);
    expect(lightboxOpen()).toBe(true);
    expect(gallery()?.index).toBe(1);
  });

  /* findIndex returns -1 when the caller cannot place the image, and an index
     out of range would render a blank viewer rather than an obvious mistake. */
  test("clamps an index that is not in the gallery", () => {
    openLightbox(images, -1);
    expect(gallery()?.index).toBe(0);

    openLightbox(images, 99);
    expect(gallery()?.index).toBe(2);
  });

  test("stays closed when there is nothing to show", () => {
    openLightbox([], 0);
    expect(lightboxOpen()).toBe(false);
  });
});

describe("stepLightbox", () => {
  test("wraps at both ends, so the arrows never dead-end", () => {
    openLightbox(images, 2);
    stepLightbox(1);
    expect(gallery()?.index).toBe(0);

    stepLightbox(-1);
    expect(gallery()?.index).toBe(2);
  });

  test("does nothing when the viewer is closed", () => {
    stepLightbox(1);
    expect(gallery()).toBeNull();
  });

  test("holds still on a gallery of one", () => {
    openLightbox([images[0] as LightboxImage], 0);
    stepLightbox(1);
    expect(gallery()?.index).toBe(0);
  });
});

describe("showLightboxIndex", () => {
  test("clamps rather than pointing past the end", () => {
    openLightbox(images, 0);
    showLightboxIndex(7);
    expect(gallery()?.index).toBe(2);
  });
});
