import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type JSX, onCleanup, onMount } from "solid-js";
import { filesFrom } from "../lib/attach.ts";

/**
 * Markdown editing for task descriptions.
 *
 * CodeMirror rather than a textarea because the things that make writing
 * markdown bearable — list continuation, undo that understands the document,
 * headings that look like headings — are exactly what a textarea cannot do.
 * The theme is deliberately quiet: this should read like the rest of the panel,
 * not like an IDE dropped into it.
 *
 * Every colour is a `var()` rather than a literal, which is not only tidier:
 * it is what lets the editor follow a theme switch. The alternative is tearing
 * the view down and rebuilding it, and rebuilding drops whatever the user has
 * typed since the last commit. CSS variables re-resolve on their own and the
 * document is never touched.
 *
 * The syntax marks (`#`, `*`, the backticks) sit at ink-3 rather than the
 * dimmest ink. They are characters the user typed and has to be able to read
 * back; they used to be #4a4e55, which was 2.3:1 against the panel.
 */

const highlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--color-ink)", fontWeight: "600" },
  { tag: tags.strong, color: "var(--color-ink)", fontWeight: "600" },
  { tag: tags.emphasis, color: "var(--color-ink-prose)", fontStyle: "italic" },
  { tag: tags.link, color: "var(--color-accent)" },
  { tag: tags.url, color: "var(--color-ink-3)" },
  { tag: tags.monospace, color: "var(--color-code)" },
  { tag: tags.quote, color: "var(--color-ink-3)" },
  { tag: tags.list, color: "var(--color-ink-3)" },
  { tag: tags.processingInstruction, color: "var(--color-ink-3)" },
]);

/*
 * `.cm-editor` is repeated into the selectors on purpose.
 *
 * CodeMirror's base theme carries its own light/dark fallbacks, and some of
 * them are written with five classes — more specific than the two a plain
 * theme rule gets, so they win no matter which order the stylesheets mount in.
 * That is why the previous selection colour here never actually rendered.
 * Repeating the class buys the specificity to override them deterministically,
 * and makes the `{ dark: true }` flag that used to be on this theme
 * unnecessary: nothing CodeMirror would pick from it survives.
 *
 * Selection is styled through `::selection` because this editor does not load
 * `drawSelection`, so there is no `.cm-selectionBackground` element to colour —
 * the browser draws the selection natively.
 */
const theme = EditorView.theme({
  "&": {
    color: "var(--color-ink-2)",
    fontSize: "var(--text-base)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  "&.cm-editor .cm-content": {
    padding: "0",
    fontFamily: "var(--font-sans)",
    lineHeight: "1.65",
    caretColor: "var(--color-ink)",
  },
  ".cm-line": { padding: "0" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.65" },
  ".cm-placeholder": { color: "var(--color-ink-4)" },
  "& ::selection": { backgroundColor: "var(--color-selection)" },
});

/**
 * Writing an upload's markdown back into the document, on a line of its own.
 *
 * At the caret rather than at the position the file arrived at: an upload takes
 * as long as ClickUp takes, and by then the person has usually carried on
 * typing. `replaceSelection` also does the obvious thing with a selection,
 * which is what pasting over selected text means everywhere else.
 *
 * The newlines are the same rule the comment composer's `insertBlock` uses, and
 * for the same reason: an image spliced into the middle of a sentence renders
 * inline, halfway through the paragraph it interrupted. Two screenshots pasted
 * one after the other would otherwise end up on the same line as each other.
 */
function insertBlock(view: EditorView, markdown: string): void {
  const { from } = view.state.selection.main;
  const lead = from > 0 && view.state.sliceDoc(from - 1, from) !== "\n" ? "\n" : "";
  view.dispatch(view.state.replaceSelection(`${lead}${markdown}\n`));
}

export function MarkdownEditor(props: {
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel?: () => void;
  autofocus?: boolean;
  /**
   * Files pasted or dropped into the document.
   *
   * The editor knows where text goes and nothing about where bytes go, so it
   * hands over both: the files, and the way to write the answer back in.
   * `insert` is called once the caller has a URL — seconds later, on the far
   * side of an upload — which is why it is a callback and not a return value.
   */
  onFiles?: (files: File[], insert: (markdown: string) => void) => void;
}): JSX.Element {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;

  /*
   * Built once, on mount.
   *
   * This used to be a createEffect that read props.value, which tracks it — so
   * any change to the surrounding task tore the editor down and built a new one
   * from the incoming text. The task refreshes from ClickUp in the background
   * and again whenever a teammate touches any field, so someone typing a
   * description would lose it, with no warning and nothing to undo: `destroy()`
   * does not fire the blur handler that commits.
   *
   * The document is the editor's from here. The parent hears about it on blur
   * or on Cmd-Enter.
   */
  onMount(() => {
    const initial = props.value;

    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          markdown(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          placeholderExt(props.placeholder ?? "Add a description…"),
          theme,
          keymap.of([
            {
              // Blur commits. Cmd-Enter commits without reaching for the mouse.
              key: "Mod-Enter",
              run: (target) => {
                props.onCommit(target.state.doc.toString());
                target.contentDOM.blur();
                return true;
              },
            },
            {
              key: "Escape",
              run: (target) => {
                target.dispatch({
                  changes: { from: 0, to: target.state.doc.length, insert: initial },
                });
                props.onCancel?.();
                target.contentDOM.blur();
                return true;
              },
            },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.domEventHandlers({
            /*
             * A pasted screenshot becomes an attachment rather than nothing.
             *
             * CodeMirror handles both of these itself and neither knows what to
             * do with bytes: paste reads the clipboard's *text*, drop reads the
             * drag's, so a file goes in and nothing comes out. Preventing the
             * default is also what tells the surrounding panel to stand down —
             * its own drop target checks `defaultPrevented` before uploading.
             */
            paste: (event, target) => {
              const onFiles = props.onFiles;
              const files = filesFrom(event.clipboardData);
              if (files.length === 0 || !onFiles) return false;
              event.preventDefault();
              onFiles(files, (markdown) => insertBlock(target, markdown));
              return true;
            },
            drop: (event, target) => {
              const onFiles = props.onFiles;
              const files = filesFrom(event.dataTransfer);
              if (files.length === 0 || !onFiles) return false;
              event.preventDefault();
              // Where it was dropped, not where the caret was left behind. The
              // upload outlives the drag by seconds, so this is the last moment
              // the pointer's position is worth anything.
              const at = target.posAtCoords({ x: event.clientX, y: event.clientY });
              if (at !== null) target.dispatch({ selection: { anchor: at } });
              onFiles(files, (markdown) => insertBlock(target, markdown));
              return true;
            },
            blur: (_event, target) => {
              const next = target.state.doc.toString();
              if (next !== initial) props.onCommit(next);
              return false;
            },
          }),
        ],
      }),
    });

    if (props.autofocus) view.focus();
  });

  onCleanup(() => view?.destroy());

  /*
   * The shield against the shell's shortcuts lives here, on the wrapper, and
   * not in `domEventHandlers`: CodeMirror runs those after its keymaps — which
   * consume Escape and Mod-Enter and stop the chain — and defers the whole
   * list to a microtask when a key lands mid-update, so a stopPropagation in
   * there is either skipped or too late. The shell then reads the Escape that
   * promised "esc to cancel" as "close the task". A listener on the wrapper
   * runs during the native dispatch, every time, whatever CodeMirror is doing.
   * Same pattern as DateField in TaskDetail.
   */
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: not interactivity — only keeps keys typed in the editor from reaching the shell
    <div ref={host} class="selectable" onKeyDown={(event) => event.stopPropagation()} />
  );
}
