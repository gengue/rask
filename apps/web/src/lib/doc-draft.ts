import { createSignal } from "solid-js";

/**
 * One write per distinct draft, whatever fires it.
 *
 * `MarkdownEditor` commits on blur *and* on Cmd-Enter, and Cmd-Enter does both:
 * it calls `onCommit` and then blurs, which calls it again. A description PATCH
 * does not care — the same value written twice is the same value. A Doc does:
 * the same paragraph appended twice is somebody's Doc with the paragraph in it
 * twice, and tidying that up means deleting the page and writing it again. So
 * every write into a Doc is keyed on its text.
 *
 * The same key is what stops a failure from re-sending on the way out. Click
 * away from a composer that just failed and blur commits the identical text
 * again; that is a retry nobody asked for, and against a 502 that ClickUp had
 * already applied it is a duplicate. So the draft is *kept* on failure and
 * `retry` — the explicit button — is the only thing that clears it.
 *
 * `write` is expected to say what went wrong (a toast, as the rest of the app
 * does) and then throw. Throwing is what marks the draft unsent.
 */
export function draftWriter(write: (text: string) => Promise<void>): {
  /** True while a write is in flight. */
  busy: () => boolean;
  /** Blur or Cmd-Enter. Deduped against the draft already sent or failed. */
  commit: (text: string) => Promise<void>;
  /** The button. Sends the draft that failed, which a blur must never do. */
  retry: () => void;
} {
  const [busy, setBusy] = createSignal(false);

  /**
   * The last text written, in flight, or failed — kept whichever it was.
   *
   * Kept after a success as well, which is what makes the rule one line: a
   * given text is written once per composer. Both writers close on success, so
   * a second commit of the same draft can only be the blur arriving after the
   * keystroke that already sent it.
   */
  let attempted: string | null = null;

  /** Whether that last write came back a failure. Only then is there a retry. */
  let failed = false;

  const commit = async (text: string): Promise<void> => {
    if (!text || busy() || text === attempted) return;

    attempted = text;
    failed = false;
    setBusy(true);
    try {
      await write(text);
    } catch {
      // `write` has already told the person. The draft stays keyed either way,
      // so the next blur is a no-op; the flag is what leaves a retry available
      // to the button and to nothing else.
      failed = true;
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    commit,
    retry: () => {
      const text = attempted;
      if (!text || busy() || !failed) return;
      attempted = null;
      void commit(text);
    },
  };
}
