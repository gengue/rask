import { describe, expect, test } from "bun:test";
import { draftWriter } from "../src/lib/doc-draft.ts";

/**
 * The guard that keeps a Doc write from happening twice.
 *
 * Worth its own test because both things it prevents are invisible where they
 * happen. `MarkdownEditor` commits on blur *and* on Cmd-Enter, and Cmd-Enter
 * does both — so without the key on the text, every entry added with the
 * keyboard lands twice, and the only way to tidy that up is to delete the page
 * and write it again. The other half is the failure path: a blur on the way
 * out of a failed write re-sends the same text, which against a 502 ClickUp had
 * already applied is a duplicate nobody asked for.
 */

function recorder(fail = false) {
  const sent: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    sent,
    release,
    write: async (text: string) => {
      sent.push(text);
      await held;
      if (fail) throw new Error("ClickUp said no");
    },
  };
}

describe("draftWriter", () => {
  test("writes once per draft, however many times it is committed", async () => {
    const spy = recorder();
    const draft = draftWriter(spy.write);

    // Cmd-Enter: onCommit, then the blur it causes. Then the same text once
    // more, with the first write long since finished — the busy flag cannot
    // catch that one, only the key on the text can.
    void draft.commit("## November 7");
    void draft.commit("## November 7");
    spy.release();
    await draft.commit("## November 7");
    await draft.commit("## November 7");

    expect(spy.sent).toEqual(["## November 7"]);
  });

  test("writes again once the text changes", async () => {
    const spy = recorder();
    const draft = draftWriter(spy.write);

    spy.release();
    await draft.commit("first");
    await draft.commit("second");

    expect(spy.sent).toEqual(["first", "second"]);
  });

  test("ignores an empty draft", async () => {
    const spy = recorder();
    const draft = draftWriter(spy.write);

    await draft.commit("");

    expect(spy.sent).toEqual([]);
  });

  test("is busy while the write is in flight, and free again after", async () => {
    const spy = recorder();
    const draft = draftWriter(spy.write);

    const inFlight = draft.commit("text");
    expect(draft.busy()).toBe(true);
    spy.release();
    await inFlight;
    expect(draft.busy()).toBe(false);
  });

  /*
   * The half that costs somebody a duplicated paragraph. After a failure the
   * composer stays open with the text in it, and clicking away blurs — which
   * commits the identical draft. That must not reach ClickUp: the write may
   * have landed and died on the way back.
   */
  test("keeps a failed draft unsent, so a blur cannot repeat it", async () => {
    const spy = recorder(true);
    const draft = draftWriter(spy.write);

    spy.release();
    await draft.commit("text");
    await draft.commit("text");

    expect(spy.sent).toEqual(["text"]);
  });

  /* The button is the retry, and it is the only thing that clears the draft. */
  test("retry sends the draft that failed", async () => {
    const spy = recorder(true);
    const draft = draftWriter(spy.write);

    spy.release();
    await draft.commit("text");
    draft.retry();
    await Promise.resolve();

    expect(spy.sent).toEqual(["text", "text"]);
  });

  test("retry does nothing when there is no failed draft", async () => {
    const spy = recorder();
    const draft = draftWriter(spy.write);

    spy.release();
    await draft.commit("text");
    draft.retry();
    await Promise.resolve();

    expect(spy.sent).toEqual(["text"]);
  });
});
