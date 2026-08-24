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
export function Attachments(props: {
  items: Attachment[];
  /** Names of files still going up. They have no URL to link to yet. */
  pending: string[];
  /** Opens the file picker. */
  onPick: () => void;
}): JSX.Element {
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
    <section class="border-line/70 border-t px-5 py-4">
      <h3 class="flex items-baseline gap-1.5 pb-3 font-medium text-xs text-ink-4 uppercase tracking-[0.04em]">
        Attachments
        <Show when={props.items.length > 0}>
          <span class="tabular-nums lowercase">{props.items.length}</span>
        </Show>
        <div class="flex-1" />
        <button
          type="button"
          onClick={() => props.onPick()}
          class="rounded-[4px] px-1.5 py-0.5 font-medium text-ink-3 text-xs normal-case tracking-normal hover:bg-hover hover:text-ink"
        >
          Add file
        </button>
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
                  class="-mx-1.5 flex h-8 items-center gap-2.5 rounded-[5px] px-1.5 hover:bg-hover"
                >
                  <span class="shrink-0 rounded bg-chip px-1.5 py-px font-medium text-xs text-ink-3 uppercase tracking-[0.04em]">
                    {file.extension || "file"}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-base text-ink-2">{nameOf(file)}</span>
                  <span class="shrink-0 text-xs text-ink-4 tabular-nums">
                    {formatBytes(file.size)}
                  </span>
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
      {/* Below the files rather than above: a screenshot that lands mid-list
            is harder to notice than one that appears where it will stay. */}
      <Show when={props.pending.length > 0}>
        <ul classList={{ "pt-2": props.items.length > 0 }}>
          <For each={props.pending}>
            {(name) => (
              <li class="flex h-8 items-center gap-2.5 px-1.5 text-base text-ink-3">
                <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-ink-4" />
                <span class="min-w-0 flex-1 truncate">{name}</span>
                <span class="shrink-0 text-ink-4 text-xs">Uploading…</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
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
