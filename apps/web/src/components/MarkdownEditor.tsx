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
 */

const highlight = HighlightStyle.define([
  { tag: tags.heading, color: "#f7f8f8", fontWeight: "600" },
  { tag: tags.strong, color: "#f7f8f8", fontWeight: "600" },
  { tag: tags.emphasis, color: "#d6d9de", fontStyle: "italic" },
  { tag: tags.link, color: "#6e79d6" },
  { tag: tags.url, color: "#6b6f76" },
  { tag: tags.monospace, color: "#8fd4c1" },
  { tag: tags.quote, color: "#6b6f76" },
  { tag: tags.list, color: "#6b6f76" },
  { tag: tags.processingInstruction, color: "#4a4e55" },
]);

const theme = EditorView.theme(
  {
    "&": { color: "#9ca1a9", fontSize: "13px", backgroundColor: "transparent" },
    "&.cm-focused": { outline: "none" },
    ".cm-content": {
      padding: "0",
      fontFamily: "var(--font-sans)",
      lineHeight: "1.65",
      caretColor: "#f7f8f8",
    },
    ".cm-line": { padding: "0" },
    ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.65" },
    ".cm-placeholder": { color: "#4a4e55" },
    "&.cm-editor .cm-cursor": { borderLeftColor: "#f7f8f8" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#2c3057",
    },
  },
  { dark: true },
);

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
