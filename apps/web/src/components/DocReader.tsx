import {
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  lazy,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { ApiError, type Assignee, api, type DocPage } from "../lib/api.ts";
import { formatRelative } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { heldValue } from "../lib/resource.ts";
import { members } from "../lib/session.ts";
import { pushToast } from "../lib/toast.ts";
import { AvatarStack } from "./Avatar.tsx";

/**
 * Lazy, for the reason `TaskDetail` loads it lazily: CodeMirror and its lezer
 * grammars are about 1.1MB of the source that went into the bundle, the largest
 * thing in it by a distance, and none of it is needed to *read* a Doc.
 *
 * This was a static import for one commit, which quietly undid the split for
 * the whole app — `routes.tsx` imports this file eagerly, so the editor rode
 * along on first paint of every page. What caught it was
 * `render-stability.spec.ts`, which holds the module's request to prove the
 * page stays mounted while the chunk downloads; with the import static, the
 * held request was the initial page load and `goto` timed out instead.
 */
const MarkdownEditor = lazy(() =>
  import("./MarkdownEditor.tsx").then((m) => ({ default: m.MarkdownEditor })),
);

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
  const [doc, { refetch }] = createResource(
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

  /*
   * Where a new page is about to go: `undefined` for "not adding", `null` for
   * the Doc's root, a page id for inside that page.
   *
   * Asked rather than inferred, and that is not a nicety. `parent_page_id` is
   * write-once — `editPagePublic` takes `name`, `sub_title`, `content`,
   * `content_edit_mode` and `content_format`, and there is no move endpoint and
   * no delete endpoint anywhere in v3 — so a page created in the wrong place
   * cannot be put right from Rask at all. The earlier version guessed "sibling
   * of whatever you are reading", which on the Doc's own first page means the
   * root, and quietly filed pages outside the tree they belonged to.
   */
  const [addingUnder, setAddingUnder] = createSignal<string | null | undefined>(undefined);

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
        {/*
          "At the root", said in the label rather than inferred from wherever
          the reader happens to be standing. The per-page "+" in the index is
          the other half; between them there is no rule to guess.

          It stays in the header because the index hides on a one-page Doc, and
          a control that only appears once you have two pages cannot be the one
          that gets you the second. Opening it is also what makes the index
          appear, so you can see where the page is about to go.
        */}
        <Show when={loaded()}>
          <button
            type="button"
            onClick={() => setAddingUnder(null)}
            class="ml-auto h-7 shrink-0 rounded-[5px] px-2 text-ink-3 text-md hover:bg-hover hover:text-ink"
          >
            New page
          </button>
        </Show>
      </header>

      <div class="flex min-h-0 flex-1">
        {/*
        The page index, hidden on a one-page Doc because it names its page
        after itself and the column would repeat the title beside it — but
        shown while a page is being added, whatever the count, so you can see
        where it is about to land before you commit to a parent you cannot
        change afterwards.
      */}
        <Show when={pages().length > 1 || addingUnder() !== undefined}>
          <nav class="w-60 shrink-0 overflow-y-auto border-line/70 border-r px-2 py-3">
            <For each={pages()}>
              {(page) => (
                <>
                  <div class="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPicked(page.id)}
                      /*
                       * Indented by depth, which is how the Doc is actually
                       * shaped: these 24 dated pages are children of one root
                       * page, and a flat list of 25 siblings says the opposite.
                       * 12px a level, matching the tree in the app sidebar.
                       */
                      style={{ "padding-left": `${8 + page.depth * 12}px` }}
                      class={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[5px] pr-1 text-left text-md ${
                        current()?.id === page.id
                          ? "row-selected text-ink"
                          : "text-ink-2 hover:bg-hover hover:text-ink"
                      }`}
                    >
                      <PageIcon page={page} />
                      <span class="truncate">{page.name}</span>
                    </button>
                    {/* Reveals on hover like the rest of the row controls in
                        the app, but stays put once its box is open — otherwise
                        moving the pointer to type dismisses the affordance you
                        are typing under. */}
                    <button
                      type="button"
                      onClick={() => setAddingUnder(page.id)}
                      title={`Add a page inside "${page.name}"`}
                      aria-label={`Add a page inside ${page.name}`}
                      class={`h-6 w-6 shrink-0 rounded-[5px] text-ink-4 leading-none hover:bg-hover hover:text-ink ${
                        addingUnder() === page.id ? "" : "opacity-0 group-hover:opacity-100"
                      }`}
                    >
                      +
                    </button>
                  </div>
                  <Show when={addingUnder() === page.id}>
                    <NewPageBox
                      docId={props.docId}
                      parentId={page.id}
                      depth={page.depth + 1}
                      onClose={() => setAddingUnder(undefined)}
                      onCreated={async (id) => {
                        await refetch();
                        setPicked(id);
                      }}
                    />
                  </Show>
                </>
              )}
            </For>

            {/* Root-level, at the bottom where a new top-level page would land. */}
            <Show when={addingUnder() === null}>
              <NewPageBox
                docId={props.docId}
                parentId={null}
                depth={0}
                onClose={() => setAddingUnder(undefined)}
                onCreated={async (id) => {
                  await refetch();
                  setPicked(id);
                }}
              />
            </Show>
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
            {(page) => <Page page={page()} docId={props.docId} onAppended={refetch} />}
          </Show>
        </div>
      </div>
    </div>
  );
}

/**
 * The name box for a page about to be created, sitting where the page will go.
 *
 * In the index at the parent's own indent rather than in a dialog, because the
 * one thing this control has to communicate is *where* — `parent_page_id` is
 * write-once (`editPagePublic` accepts `name`, `sub_title`, `content`,
 * `content_edit_mode`, `content_format`, and v3 has no move endpoint and no
 * delete endpoint), so a page filed in the wrong place cannot be moved or
 * removed from Rask afterwards. Showing the slot it will occupy is cheaper
 * than any amount of labelling.
 *
 * A name and nothing else; the page is born empty. Writing into it is
 * `Append`'s job, which is the same rule the API keeps — one endpoint per
 * shape of change, so a page cannot be created and overwritten in one breath.
 */
function NewPageBox(props: {
  docId: string;
  parentId: string | null;
  depth: number;
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
}): JSX.Element {
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let input!: HTMLInputElement;

  onMount(() => input.focus());

  const submit = async (): Promise<void> => {
    const value = name().trim();
    if (!value || busy()) return;

    setBusy(true);
    try {
      const { id } = await api.createDocPage(props.docId, {
        name: value,
        ...(props.parentId ? { parentId: props.parentId } : {}),
      });
      props.onClose();
      await props.onCreated(id);
    } catch (error) {
      // A toast, as every other write-through failure in the app does it,
      // carrying ClickUp's own refusal. The box stays open with the name in it.
      pushToast({
        tone: "error",
        title: "Could not add that page",
        detail: error instanceof ApiError ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ "padding-left": `${8 + props.depth * 12}px` }} class="py-0.5">
      <input
        ref={input}
        value={name()}
        disabled={busy()}
        placeholder={busy() ? "Adding…" : "Page name"}
        onInput={(event) => setName(event.currentTarget.value)}
        /* Stopped here for the reason MarkdownEditor stops its own: the shell
           reads a bare Escape as "close what is open" and would take the Doc
           down instead of the box. */
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") void submit();
          if (event.key === "Escape") props.onClose();
        }}
        /* Clicking away is "never mind". Nothing has been written yet, so there
           is nothing to lose by closing — unlike the entry composer below,
           where blur is what commits. */
        onBlur={() => !busy() && props.onClose()}
        class="h-7 w-full rounded-[5px] border border-line-strong bg-elevated px-2 text-ink text-md placeholder:text-ink-4 focus:outline-none"
      />
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
function Page(props: { page: DocPage; docId: string; onAppended: () => void }): JSX.Element {
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

        <Append docId={props.docId} pageId={props.page.id} onAppended={props.onAppended} />
      </div>
    </article>
  );
}

/**
 * Adding an entry to the end of a page.
 *
 * Append and nothing else. The API has no route that replaces a page and this
 * is why: a request carrying only the new block cannot overwrite what somebody
 * else wrote in ClickUp's own editor while this page sat open, and there is no
 * webhook for a Doc that would let Rask notice if it had. Editing what is
 * already there stays in ClickUp until that is answered — `docs/doc-editing.md`
 * has the argument.
 *
 * No optimistic paint. The Doc is refetched instead, which is one ClickUp
 * request either way and shows ClickUp's own rendering of what it stored rather
 * than the browser's guess at it. A Doc body is never mirrored, so a guess here
 * would be the only copy of the text anybody sees and there would be nothing to
 * correct it.
 */
function Append(props: { docId: string; pageId: string; onAppended: () => void }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [sending, setSending] = createSignal(false);

  /*
   * The text of the attempt in flight, or the one that just failed.
   *
   * MarkdownEditor commits on blur *and* on Cmd-Enter, and Cmd-Enter does both:
   * it calls `onCommit` and then blurs, which calls it again. A description
   * PATCH does not care — the same value written twice is the same value. The
   * same paragraph appended twice to somebody's Doc is somebody's Doc with the
   * paragraph in it twice, and there is no delete-page endpoint to tidy up
   * with. So the send is keyed on the text: one post per distinct draft,
   * whatever fires it.
   *
   * It doubles as the guard against re-sending on the way out of a failure.
   * Click away from a composer that just failed and blur commits the same text
   * again; that is a retry nobody asked for, and if the failure was a 502 that
   * ClickUp had already applied it is a duplicate. Retrying is the button's
   * job, and the button is what clears this.
   */
  let attempted: string | null = null;

  const send = async (text: string): Promise<void> => {
    const content = text.trim();
    if (!content || sending() || content === attempted) return;

    attempted = content;
    setSending(true);
    try {
      await api.appendDocPage(props.docId, props.pageId, content);
      attempted = null;
      setOpen(false);
      props.onAppended();
    } catch (error) {
      // A toast rather than a line under the editor, as every other
      // write-through failure in the app does it — the detail is ClickUp's own
      // words, and "you do not have edit access to this Doc" is the one people
      // will hit. The composer stays open with the text still in it.
      pushToast({
        tone: "error",
        title: "Could not add that entry",
        detail: error instanceof ApiError ? error.message : undefined,
      });
    } finally {
      setSending(false);
    }
  };

  /*
   * Clicking this blurs the editor first, which commits and sends on its own;
   * by the time the click lands the send is either in flight or deduped. What
   * is left for the handler is the case blur cannot cover: the same text
   * failing and the person wanting it tried again without editing it.
   */
  const add = (): void => {
    const text = attempted;
    if (!text || sending()) return;
    attempted = null;
    void send(text);
  };

  return (
    <div class="pt-6">
      <Show
        when={open()}
        fallback={
          <button
            type="button"
            onClick={() => setOpen(true)}
            class="h-7 rounded-[5px] px-2 text-ink-3 text-md hover:bg-hover hover:text-ink"
          >
            Add an entry
          </button>
        }
      >
        <div class="rounded-[5px] border border-line/70 px-3 py-2">
          {/* Its own boundary. A lazy component suspends to the nearest one,
              and without this that is the router's, wrapped around the whole
              route — opening the composer would blank the Doc for the length
              of the chunk download. */}
          <Suspense fallback={<div class="py-1 text-ink-4 text-base">Loading editor…</div>}>
            <MarkdownEditor
              value=""
              placeholder="Add to the end of this page…"
              autofocus
              onCommit={(value) => void send(value)}
              /* Escape restores the empty document and closes, which is the same
               "never mind" the task panel's editors mean by it. */
              onCancel={() => setOpen(false)}
            />
          </Suspense>
          <div class="flex items-baseline justify-end gap-3 pt-2 text-ink-4 text-xs">
            <span>{sending() ? "Adding…" : "⌘↵ to add"}</span>
            <button
              type="button"
              onClick={add}
              disabled={sending()}
              class="h-6 rounded-[5px] px-2 text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
