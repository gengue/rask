import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type JSX, onCleanup, onMount } from "solid-js";

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

export function MarkdownEditor(props: {
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel?: () => void;
  autofocus?: boolean;
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
            // Stop j/k and the rest of the global shortcuts from firing while typing.
            keydown: (event) => {
              event.stopPropagation();
              return false;
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

  return <div ref={host} class="selectable" />;
}
