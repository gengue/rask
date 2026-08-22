import { For, type JSX, Show } from "solid-js";
import type { Attachment } from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import { openLightbox } from "../lib/lightbox.ts";

/**
 * The files on a task.
 *
 * Two shapes, because two things are being asked. An image is worth recognising
 * at a glance, so it gets a thumbnail and opens in the viewer. Anything else is
 * a name and a size you either need or you don't, so it gets one line and opens
 * in a new tab.
 *
 * Nothing here goes through the API. ClickUp's attachment CDN is public, so the
 * browser loads these URLs directly.
 */
export function Attachments(props: { items: Attachment[] }): JSX.Element {
  const images = () => props.items.filter(isImage);
  const files = () => props.items.filter((item) => !isImage(item));

  const openAt = (id: string) =>
    openLightbox(
      images().map((image) => ({
        src: image.url ?? "",
        alt: nameOf(image),
        href: image.urlWithQuery ?? image.url ?? undefined,
      })),
      images().findIndex((image) => image.id === id),
    );

  return (
    <Show when={props.items.length > 0}>
      <section class="border-line/70 border-t px-5 py-4">
        <h3 class="flex items-baseline gap-1.5 pb-3 font-medium text-[11px] text-ink-4 uppercase tracking-[0.04em]">
          Attachments
          <span class="tabular-nums lowercase">{props.items.length}</span>
        </h3>

        {/* Wrapping rather than a fixed-column grid: two screenshots should be
            two tiles, not two tiles and three gaps. */}
        <Show when={images().length > 0}>
          <ul class="flex flex-wrap gap-2">
            <For each={images()}>
              {(image) => (
                <li>
                  <button
                    type="button"
                    onClick={() => openAt(image.id)}
                    title={nameOf(image)}
                    aria-label={`Open ${nameOf(image)}`}
                    class="block h-[76px] w-[112px] overflow-hidden rounded-[6px] border border-line bg-elevated transition-colors hover:border-line-strong"
                  >
                    {/* Not thumbnail_small: ClickUp renders that at about
                        80x35, which cropped into a tile is a stripe of one
                        screenshot rather than a picture of it. */}
                    <img
                      src={image.thumbnailMedium ?? image.thumbnailSmall ?? image.url ?? ""}
                      alt={nameOf(image)}
                      loading="lazy"
                      class="size-full object-cover"
                    />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={files().length > 0}>
          <ul classList={{ "pt-2": images().length > 0 }}>
            <For each={files()}>
              {(file) => (
                <li>
                  {/* The ?view=open variant, so a PDF opens in the tab instead
                      of landing in Downloads. */}
                  <a
                    href={file.urlWithQuery ?? file.url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="-mx-1.5 flex h-8 items-center gap-2.5 rounded-[5px] px-1.5 hover:bg-white/[0.04]"
                  >
                    <span class="shrink-0 rounded bg-white/[0.05] px-1.5 py-px font-medium text-[10px] text-ink-3 uppercase tracking-[0.04em]">
                      {file.extension || "file"}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                      {nameOf(file)}
                    </span>
                    <span class="shrink-0 text-[11px] text-ink-4 tabular-nums">
                      {formatBytes(file.size)}
                    </span>
                  </a>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  );
}

/**
 * ClickUp's mimetype is only as good as whatever uploaded the file: a screen
 * recording came back as application/octet-stream. The extension is the second
 * opinion, and one of the two is usually right.
 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"]);

function isImage(attachment: Attachment): boolean {
  if (!attachment.url) return false;
  if (attachment.mimetype?.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has((attachment.extension ?? "").toLowerCase());
}

function nameOf(attachment: Attachment): string {
  return attachment.title || attachment.id;
}
