import { createMemo, createResource, createSignal, For, type JSX, Show } from "solid-js";
import { type Assignee, api, type DocPage } from "../lib/api.ts";
import { formatRelative } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { heldValue } from "../lib/resource.ts";
import { members } from "../lib/session.ts";
import { AvatarStack } from "./Avatar.tsx";

/**
 * One ClickUp Doc, read live.
 *
 * A Doc arrives whole — every page with its body, in one request — so paging
 * between them costs nothing once it lands. That is why the page list here is a
 * signal rather than a route parameter: there is no fetch behind a click, and a
 * URL per page would mean a round trip per page for a Doc already in hand.
 *
 * One page at a time rather than all of them stacked, because these get long:
 * the release-notes Doc this was built against is 25 pages and 154 000
 * characters, which as one column is a scrollbar nobody can aim.
 */
export function DocReader(props: { docId: string }): JSX.Element {
  const [doc] = createResource(
    () => props.docId,
    (id) => api.doc(id).then((r) => r.doc),
  );

  /*
   * The page the reader picked, by id, and null for "whichever is first".
   *
   * By id rather than by index so that a refetch which reorders or drops pages
   * cannot silently move somebody onto a different page than the one they were
   * reading. Null resolves to the first page every time it is read, which is
   * also what makes switching Docs land at the top without an effect to reset.
   */
  const [picked, setPicked] = createSignal<string | null>(null);

  // `heldValue`, never `doc()`: this resource talks to ClickUp, so a plain read
  // would throw a 502 up to the router's boundary and blank the app.
  const loaded = () => heldValue(doc);
  const pages = () => loaded()?.pages ?? [];
  const current = () => pages().find((page) => page.id === picked()) ?? pages()[0];

  return (
    <div class="flex h-full min-h-0 flex-col">
      {/* Which Doc this is, kept above the split. The page title below says
          which page; on a child page — "November 7 - 2025" — nothing else on
          screen says what it is a page of. */}
      <header class="flex h-11 shrink-0 items-center gap-2 border-line/70 border-b px-6">
        <span class="min-w-0 truncate font-medium text-ink-2 text-md">{loaded()?.name ?? "…"}</span>
        <Show when={loaded()?.updated}>
          {(updated) => (
            <span class="shrink-0 text-ink-4 text-xs">{formatRelative(updated())}</span>
          )}
        </Show>
      </header>

      <div class="flex min-h-0 flex-1">
        {/*
        The page index, and only when there is more than one page: a one-page
        Doc names its page after itself, so the column would be a single row
        repeating the title beside it.
      */}
        <Show when={pages().length > 1}>
          <nav class="w-60 shrink-0 overflow-y-auto border-line/70 border-r px-2 py-3">
            <For each={pages()}>
              {(page) => (
                <button
                  type="button"
                  onClick={() => setPicked(page.id)}
                  /*
                   * Indented by depth, which is how the Doc is actually shaped:
                   * these 24 dated pages are children of one root page, and a
                   * flat list of 25 siblings says the opposite. 12px a level,
                   * matching the tree in the app sidebar.
                   */
                  style={{ "padding-left": `${8 + page.depth * 12}px` }}
                  class={`flex h-7 w-full items-center gap-1.5 rounded-[5px] pr-2 text-left text-md ${
                    current()?.id === page.id
                      ? "row-selected text-ink"
                      : "text-ink-2 hover:bg-hover hover:text-ink"
                  }`}
                >
                  <PageIcon page={page} />
                  <span class="truncate">{page.name}</span>
                </button>
              )}
            </For>
          </nav>
        </Show>

        <div class="min-w-0 flex-1 overflow-y-auto">
          <Show
            when={loaded() && current()}
            fallback={
              <p class="px-6 py-4 text-ink-4 text-md">
                {doc.state === "errored" ? "Could not read this Doc from ClickUp." : "Loading…"}
              </p>
            }
          >
            {(page) => <Page page={page()} />}
          </Show>
        </div>
      </div>
    </div>
  );
}

/**
 * The emoji ClickUp puts on a page, or the generic page glyph.
 *
 * Both occupy the same 14px box so the index does not go ragged where four
 * pages in twenty-five have one.
 */
function PageIcon(props: { page: DocPage }): JSX.Element {
  return (
    <Show
      when={props.page.icon}
      fallback={
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          class="shrink-0 text-ink-4"
          aria-hidden="true"
        >
          <path
            d="M4 2.5h5L12 5.5v8h-8z"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
          />
          <path
            d="M8.6 2.6v3h3.2"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
          />
        </svg>
      }
    >
      {(icon) => (
        <span class="w-[14px] shrink-0 text-center text-[13px] leading-none">{icon()}</span>
      )}
    </Show>
  );
}

/**
 * One page: cover, title, who touched it, body.
 *
 * The measure is capped rather than filling the panel. ClickUp stores a
 * `page_width` per page and defaults these to a narrow column for the same
 * reason — a 1200px line of prose is one your eye loses the start of on the way
 * back. Tables and images still take the full width inside it.
 */
function Page(props: { page: DocPage }): JSX.Element {
  const directory = createMemo(() => new Map(members().map((user) => [user.id, user])));
  const faces = createMemo((): Assignee[] =>
    [...props.page.authors, ...props.page.contributors]
      .map((id) => directory().get(id))
      .filter((user): user is Assignee => user !== undefined),
  );

  return (
    <article>
      {/* ClickUp calls this the cover and puts it above everything, bleeding to
          both edges. Lazy, because most pages have none and the ones that do
          are full-width screenshots. */}
      <Show when={props.page.cover}>
        {(cover) => (
          <img
            src={cover()}
            alt=""
            loading="lazy"
            class="h-40 w-full object-cover"
            // A cover that 404s upstream should leave the page, not a broken
            // image icon across the top of it.
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        )}
      </Show>

      {/*
        Left-aligned with a capped measure, not centred. Centring inside a wide
        panel leaves a gutter on the left that nothing lines up with — the
        header above it starts at the edge — while the cap is what keeps a line
        of prose readable. ClickUp does the same with its own `page_width`.
      */}
      <div class="max-w-[46rem] px-8 py-6">
        <h1 class="flex items-start gap-2 font-semibold text-2xl text-ink">
          <Show when={props.page.icon}>
            {(icon) => <span class="text-2xl leading-tight">{icon()}</span>}
          </Show>
          <span class="min-w-0">{props.page.name}</span>
        </h1>

        {/* The line ClickUp draws under a title: who wrote it, and when it last
            moved. Faces come from the workspace directory already in memory, so
            an id nobody mirrored simply drops out rather than costing a fetch. */}
        <div class="flex items-center gap-2 pt-2 pb-5 text-ink-4 text-xs">
          <Show when={faces().length > 0}>
            <AvatarStack users={faces()} max={4} />
          </Show>
          <Show when={props.page.updated}>
            {(updated) => <span>Last updated {formatRelative(updated())}</span>}
          </Show>
        </div>

        <Show
          when={props.page.content}
          fallback={<p class="text-ink-4 text-md">This page is empty.</p>}
        >
          {/* Sanitized in renderMarkdown. A Doc is other people's input and
              never reaches the DOM raw. */}
          <div
            class="prose-rask selectable text-base"
            innerHTML={renderMarkdown(props.page.content)}
          />
        </Show>
      </div>
    </article>
  );
}
