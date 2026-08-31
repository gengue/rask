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
import { Dynamic } from "solid-js/web";
import { ApiError, type Assignee, api, type DocPage } from "../lib/api.ts";
import { draftWriter } from "../lib/doc-draft.ts";
import { isFolded, toggleFold } from "../lib/doc-fold.ts";
import { type DocSection, hiddenSections, splitSections } from "../lib/doc-sections.ts";
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
 * between them costs nothing once it lands. Which page is being read still
 * belongs in the URL: it was a signal here for a while, and the cost was that
 * every page of a Doc shared one address, so no link could name one and a
 * ClickUp `/v/dc/{doc}/{page}` had nowhere to put the page it carried. The
 * signal is `DocView`'s search param now; the click is a navigation and costs
 * no more fetches than it did.
 *
 * One page at a time rather than all of them stacked, because these get long:
 * the release-notes Doc this was built against is 25 pages and 154 000
 * characters, which as one column is a scrollbar nobody can aim.
 */
export function DocReader(props: {
  docId: string;
  /** Undefined for "whichever is first". See `current`. */
  pageId: string | undefined;
  onPick: (pageId: string) => void;
}): JSX.Element {
  const [doc, { refetch }] = createResource(
    () => props.docId,
    (id) => api.doc(id).then((r) => r.doc),
  );

  /*
   * Where a new page is about to go: `undefined` for "not adding", `null` for
   * the Doc's root, a page id for inside that page.
   *
   * Asked rather than inferred, and that is not a nicety. `parent_page_id` is
   * write-once: `editPagePublic` takes `name`, `sub_title`, `content`,
   * `content_edit_mode` and `content_format`, and v3 has no move endpoint, so
   * nothing the public API offers can reparent a page afterwards. Deleting it
   * and making it again is the only correction, and that costs the page its
   * content and its history. The earlier version guessed "sibling of whatever
   * you are reading", which on the Doc's own first page means the root, and
   * quietly filed pages outside the tree they belonged to.
   */
  const [addingUnder, setAddingUnder] = createSignal<string | null | undefined>(undefined);

  /*
   * Opening a box closes any other, and does it on pointer-down.
   *
   * The input closes itself on blur, which reorders the column — every row
   * below the old box moves up by its height. On a plain click the pointer is
   * then over a different row by the time the mouse comes up, so the click
   * never lands on the "+" that was pressed and the first press only ever
   * dismisses. Taking the pointer-down (and keeping focus off the button)
   * means the press that opens a box is the press you made.
   */
  const openBoxUnder = (parent: string | null) => (event: MouseEvent) => {
    event.preventDefault();
    setAddingUnder(parent);
  };

  const created = async (id: string): Promise<void> => {
    await refetch();
    props.onPick(id);
  };

  /** The page a delete is in flight for, so a second press cannot start one. */
  const [deleting, setDeleting] = createSignal<string | null>(null);

  /*
   * Removing a page, behind the same `window.confirm` the task menu uses.
   *
   * This is the only thing in the reader that destroys somebody's prose, and it
   * is the second confirmation in the app for the same reason as the first:
   * there is no undo Rask can reach. The dialog rather than the timesheet's
   * two-step "Sure?" because what has to be confirmed is *which* page, and the
   * index is 240px of rows that look alike — twenty-five of them on the Doc
   * this was built against, named "November 7 - 2025" and its neighbours.
   *
   * The URL needs no reset. The page is addressed by id and resolves to the
   * first page when the id is gone, which is exactly where a reader should
   * land — a stale `?page=` in the bar is what a deleted page deserves.
   */
  const remove = async (page: DocPage): Promise<void> => {
    if (deleting()) return;

    // "may take them with it" rather than a promise: ClickUp's answer for a
    // page with children has not been checked, and the safe reading is the one
    // that does not tell somebody their sub-pages are staying.
    const ok = window.confirm(
      `Delete "${page.name}"?\n\nEverything written on it goes, and a page with pages ` +
        `under it may take them with it. Rask cannot undo this.`,
    );
    if (!ok) return;

    setDeleting(page.id);
    try {
      await api.deleteDocPage(props.docId, page.id);
      await refetch();
    } catch (error) {
      // A toast carrying ClickUp's own refusal, as every other write-through
      // failure here does. "You do not have edit access" is the likely one.
      pushToast({
        tone: "error",
        title: "Could not delete that page",
        detail: error instanceof ApiError ? error.message : undefined,
      });
    } finally {
      setDeleting(null);
    }
  };

  // `heldValue`, never `doc()`: this resource talks to ClickUp, so a plain read
  // would throw a 502 up to the router's boundary and blank the app.
  const loaded = () => heldValue(doc);
  const pages = () => loaded()?.pages ?? [];
  /*
   * By id rather than by index so that a refetch which reorders or drops pages
   * cannot silently move somebody onto a different page than the one they were
   * reading. An id that matches nothing — a deleted page, a page id from a
   * ClickUp URL for a different Doc — falls back to the first page rather than
   * to an empty reader.
   */
  const current = () => pages().find((page) => page.id === props.pageId) ?? pages()[0];

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
          The root slot. The per-page "+" in the index is the other one, and
          between them there is no rule to guess — but neither button is where
          the placement is actually communicated. The box opens in the index at
          the indent the page will occupy, and that is what says where it goes.
          The label only has to distinguish this from the "+", hence "at root".

          It stays in the header because the index hides on a one-page Doc, and
          a control that only appears once you have two pages cannot be the one
          that gets you the second. Opening it is also what makes the index
          appear.
        */}
        <Show when={loaded()}>
          <button
            type="button"
            onMouseDown={openBoxUnder(null)}
            onClick={() => setAddingUnder(null)}
            title="Add a page at the root of this Doc"
            class="ml-auto h-7 shrink-0 rounded-[5px] px-2 text-ink-3 text-md hover:bg-hover hover:text-ink"
          >
            New page at root
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
                      onClick={() => props.onPick(page.id)}
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
                        the app, and on focus as well — hover alone leaves it
                        unreachable by keyboard, which for the only control that
                        files a page in the right place is not a detail. It also
                        stays put once its box is open, or moving the pointer to
                        type dismisses the affordance you are typing under. */}
                    <button
                      type="button"
                      onMouseDown={openBoxUnder(page.id)}
                      onClick={() => setAddingUnder(page.id)}
                      title={`Add a page inside "${page.name}"`}
                      aria-label={`Add a page inside ${page.name}`}
                      class={`h-6 w-6 shrink-0 rounded-[5px] text-ink-4 leading-none hover:bg-hover hover:text-ink focus-visible:opacity-100 ${
                        addingUnder() === page.id ? "" : "opacity-0 group-hover:opacity-100"
                      }`}
                    >
                      +
                    </button>
                    {/* Beside the "+", revealed the same way and reachable by
                        keyboard for the same reason. A plain click, not a
                        pointer-down: if a name box is open, the blur that
                        closes it reflows the column and the press simply does
                        not land, which for this button is the right nothing to
                        happen. */}
                    <button
                      type="button"
                      onClick={() => void remove(page)}
                      disabled={deleting() === page.id}
                      title={`Delete "${page.name}"`}
                      aria-label={`Delete ${page.name}`}
                      class="h-6 w-6 shrink-0 rounded-[5px] text-ink-4 leading-none opacity-0 hover:bg-hover hover:text-high focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                  <Show when={addingUnder() === page.id}>
                    <NewPageBox
                      docId={props.docId}
                      parentId={page.id}
                      depth={page.depth + 1}
                      onClose={() => setAddingUnder(undefined)}
                      onCreated={created}
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
                onCreated={created}
              />
            </Show>
          </nav>
        </Show>

        <div class="min-w-0 flex-1 overflow-y-auto">
          <Show
            /* Keyed, so the page being read is the page the components below
               were built from. `Page` holds whether its body is open in the
               editor, and `MarkdownEditor` takes its document once on mount;
               without this, switching page mid-edit would leave one page's
               draft sitting over another page's id. */
            keyed
            when={loaded() && current()}
            fallback={
              /* Three states, not two. A Doc that has loaded and holds no pages
                 became reachable when delete shipped — ClickUp's own answer for
                 a page with children has not been checked, so deleting one may
                 empty a Doc in a single press — and "Loading…" for a Doc that
                 has finished loading reads as a request that hung. */
              <p class="px-6 py-4 text-ink-4 text-md">
                {doc.state === "errored"
                  ? "Could not read this Doc from ClickUp."
                  : loaded()
                    ? "This Doc has no pages."
                    : "Loading…"}
              </p>
            }
          >
            {(page) => <Page page={page} docId={props.docId} onChanged={refetch} />}
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
 * `content_edit_mode`, `content_format`, and v3 has no move endpoint), so a
 * page filed in the wrong place can only be corrected by deleting it and
 * making it again. Showing the slot it will occupy is cheaper than any amount
 * of labelling.
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
function Page(props: { page: DocPage; docId: string; onChanged: () => void }): JSX.Element {
  /*
   * Whether the body is open in the editor.
   *
   * Safe as a signal on this component only because the parent's `Show` is
   * keyed: a different page is a different `Page`, so this cannot survive a
   * page switch with the old text still in the editor.
   */
  const [editing, setEditing] = createSignal(false);
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
          {/*
            Only on a page ClickUp gave an update time for. That value is the
            whole conflict check — it goes back with the write and the server
            refuses if the page has moved since — so a page without one is a
            page Rask will not overwrite, and offering the button would be
            offering a save that always fails.
          */}
          <Show when={props.page.updated && !editing()}>
            <button
              type="button"
              onClick={() => setEditing(true)}
              class="ml-auto h-6 shrink-0 rounded-[5px] px-2 text-ink-3 text-md hover:bg-hover hover:text-ink"
            >
              Edit
            </button>
          </Show>
        </div>

        {/* `editing() && updated` rather than `editing()` alone: the timestamp is
            what the write is checked against, so a page without one has no
            editable form. The "Edit" button is hidden on those for the same
            reason, and this is what makes the editor unable to exist without
            the value it has to send. */}
        <Show
          when={editing() && props.page.updated}
          fallback={
            <>
              <Show
                when={props.page.content}
                fallback={<p class="text-ink-4 text-md">This page is empty.</p>}
              >
                <Body page={props.page} />
              </Show>

              <Append docId={props.docId} pageId={props.page.id} onAppended={props.onChanged} />
            </>
          }
        >
          {(readAt) => (
            <PageEditor
              docId={props.docId}
              page={props.page}
              readAt={readAt()}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                props.onChanged();
              }}
            />
          )}
        </Show>
      </div>
    </article>
  );
}

/**
 * The page body, foldable by heading, the way ClickUp's own editor folds one.
 *
 * The index on the left stops at page granularity, and one of these pages is
 * long enough that its headings are the only structure there is to navigate by.
 *
 * The markdown is rendered exactly as it was — through `renderMarkdown`, which
 * sanitizes — and only then cut into sections, so folding adds no second route
 * to the DOM for content that came out of somebody else's Doc.
 */
function Body(props: { page: DocPage }): JSX.Element {
  const outline = createMemo(() => splitSections(renderMarkdown(props.page.content)));

  // Keyed on the page, so folding a heading re-reads this and nothing else; the
  // rendered sections themselves are untouched and their innerHTML is not
  // reparsed. On a 154 000-character Doc that difference is the feature.
  const hidden = createMemo(() =>
    hiddenSections(outline().sections, (id) => isFolded(props.page.id, id)),
  );

  return (
    <div class="prose-rask selectable text-base">
      <Show when={outline().intro}>
        <div class="rask-fold-body" innerHTML={outline().intro} />
      </Show>
      <For each={outline().sections}>
        {(section) => (
          <Section
            section={section}
            pageId={props.page.id}
            hidden={hidden().has(section.id)}
            folded={isFolded(props.page.id, section.id)}
          />
        )}
      </For>
    </div>
  );
}

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/**
 * One heading and its content.
 *
 * The toggle is a button beside the heading rather than the heading itself,
 * because a `<button>` carries `user-select: none` in every engine's own
 * stylesheet: wrapping the words in one would cut a selection dragged through
 * them in half, on the one part of the app that exists to be read and copied.
 * It also keeps double-click-to-select-a-word working on a heading.
 *
 * Sitting in the column's left padding, so folding a section moves nothing on
 * the line. Hidden until the heading is hovered or the button is tabbed to,
 * except when the section is folded — then it is the only thing on screen
 * saying there is anything under it.
 *
 * The glyph is small and the target is not: 24px wide by a full line tall,
 * which is the same box the "+" in the page index uses and the smallest one
 * WCAG will call a target. The first version drew a 10px chevron in a 16px box
 * and people missed it. The height is `1.65em` rather than a fixed 24px
 * because that is `.prose-rask`'s own line-height, so the button centres on the
 * heading's first line at every heading size instead of only at one of them.
 */
function Section(props: {
  section: DocSection;
  pageId: string;
  hidden: boolean;
  folded: boolean;
}): JSX.Element {
  const bodyId = () => `doc-body-${props.pageId}-${props.section.id}`;

  return (
    <>
      <Dynamic
        component={HEADING_TAGS[props.section.level - 1] ?? "h6"}
        class="group relative"
        hidden={props.hidden}
      >
        <button
          type="button"
          onClick={() => toggleFold(props.pageId, props.section.id)}
          aria-expanded={!props.folded}
          aria-controls={bodyId()}
          aria-label={`${props.folded ? "Expand" : "Collapse"} ${props.section.text}`}
          class="-left-7 absolute top-0 flex h-[1.65em] w-6 select-none items-center justify-center rounded-[5px] text-[12px] text-ink-4 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          classList={{ "opacity-0": !props.folded }}
        >
          {props.folded ? "▸" : "▾"}
        </button>
        <span innerHTML={props.section.heading} />
      </Dynamic>
      <div
        id={bodyId()}
        class="rask-fold-body"
        hidden={props.hidden || props.folded}
        innerHTML={props.section.body}
      />
    </>
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

  const draft = draftWriter(async (content) => {
    try {
      await api.appendDocPage(props.docId, props.pageId, content);
    } catch (error) {
      // A toast rather than a line under the editor, as every other
      // write-through failure in the app does it — the detail is ClickUp's own
      // words, and "you do not have edit access to this Doc" is the one people
      // will hit. The composer stays open with the text still in it, and the
      // rethrow is what keeps the draft unsent so only the button retries it.
      pushToast({
        tone: "error",
        title: "Could not add that entry",
        detail: error instanceof ApiError ? error.message : undefined,
      });
      throw error;
    }
    setOpen(false);
    props.onAppended();
  });

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
              onCommit={(value) => void draft.commit(value.trim())}
              /* Escape restores the empty document and closes, which is the same
               "never mind" the task panel's editors mean by it. */
              onCancel={() => setOpen(false)}
            />
          </Suspense>
          <div class="flex items-baseline justify-end gap-3 pt-2 text-ink-4 text-xs">
            <span>{draft.busy() ? "Adding…" : "⌘↵ to add"}</span>
            {/* Pressing this blurs the editor first, which commits and sends on
                its own; by the time the click lands the send is in flight or
                deduped. What is left for the handler is what blur cannot do:
                send the same text again after it failed. */}
            <button
              type="button"
              onClick={draft.retry}
              disabled={draft.busy()}
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

/**
 * Rewriting a page's body in place.
 *
 * The one thing in the reader that can overwrite writing that was already
 * there, and it is offered because the round trip turned out to hold: the
 * markdown ClickUp exports, sent straight back as a replace, comes back
 * byte-identical — measured on an 8627-character page of headings, tables and
 * diagrams. What that measurement cannot see is ClickUp's *render*, and the one
 * signal of loss it did turn up is that mermaid blocks export as ```plain
 * fences. A page whose diagrams matter is a page to edit in ClickUp.
 *
 * The other half is a check rather than a lock, and it lives in the API: the
 * page's `updated` goes back with the body, the route re-reads the page and
 * refuses with a 409 if it moved since. There is no webhook for a Doc, so
 * without it an edit written against a stale read would take somebody else's
 * paragraph with it and say nothing. A 409 leaves the draft in the editor —
 * it is not saveable as it stands, and re-applying it is the person's call.
 *
 * No optimistic paint, for the reason the append gives: no Doc body is
 * mirrored, so a guess here would be the only copy of the text anybody sees.
 */
function PageEditor(props: {
  docId: string;
  page: DocPage;
  /**
   * When the text in the editor was last written, as the page was read.
   *
   * Sent back with the body and compared upstream, so it has to be the read
   * this draft was written against. Taken once, on mount, for that reason.
   */
  readAt: string;
  onSaved: () => void;
  onClose: () => void;
}): JSX.Element {
  const readAt = props.readAt;

  const draft = draftWriter(async (content) => {
    try {
      await api.replaceDocPage(props.docId, props.page.id, content, readAt);
    } catch (error) {
      // ClickUp's own words, or the server's on a 409 — "somebody edited this
      // page while you had it open" is the one worth reading. The editor stays
      // open with the draft in it, and the rethrow is what keeps that draft
      // unsent so a blur cannot write it a second time.
      pushToast({
        tone: "error",
        title: "Could not save this page",
        detail: error instanceof ApiError ? error.message : undefined,
      });
      throw error;
    }
    props.onSaved();
  });

  const save = (text: string): void => {
    const content = text.trim();

    /*
     * Emptying a page is not an edit anybody means, and the shape they do mean
     * — the page going away — is the "×" in the index, behind a confirmation.
     * The API refuses this too; catching it here keeps the draft on screen
     * instead of spending a request to be told no.
     */
    if (!content) {
      pushToast({
        tone: "error",
        title: "A page cannot be emptied from Rask",
        detail: "Delete it from the page index instead, or leave something on it.",
      });
      return;
    }

    // Nothing to write. Cmd-Enter commits whether or not the document moved.
    if (content === props.page.content.trim()) {
      props.onClose();
      return;
    }

    void draft.commit(content);
  };

  return (
    <div class="rounded-[5px] border border-line/70 px-3 py-2">
      {/* Its own boundary, as the composer has: a lazy component suspends to
          the nearest one, and the next one up is the router's — opening the
          editor would blank the route for the length of the chunk download. */}
      <Suspense fallback={<div class="py-1 text-ink-4 text-base">Loading editor…</div>}>
        <MarkdownEditor
          value={props.page.content}
          placeholder="Write this page…"
          autofocus
          onCommit={save}
          /* Escape puts the page back as it was and closes, which is what it
             means everywhere else in the app. Blur commits, so clicking away
             saves — the same bargain a task description makes. */
          onCancel={props.onClose}
        />
      </Suspense>
      <div class="flex items-baseline justify-end gap-3 pt-2 text-ink-4 text-xs">
        <span>{draft.busy() ? "Saving…" : "⌘↵ to save · esc to discard"}</span>
        {/* Pressing this blurs the editor first, which commits and saves on its
            own; by the time the click lands the save is in flight or deduped.
            What is left for the handler is what blur cannot do: send the same
            text again after it failed. */}
        <button
          type="button"
          onClick={draft.retry}
          disabled={draft.busy()}
          class="h-6 rounded-[5px] px-2 text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}
