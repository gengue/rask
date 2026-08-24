import { describe, expect, test } from "bun:test";
import { signInError } from "../src/lib/sign-in-error.ts";

/**
 * A refused sign-in, in words.
 *
 * The API sends a code rather than a sentence, so the wording lives with the UI
 * and a redirect URL carries nothing a stranger can read off an address bar.
 * The codes are a contract between `apps/api/src/auth.ts` and this: a rename on
 * one side and the person who was refused sees the generic line instead of the
 * reason.
 */
describe("signInError", () => {
  test("no code is not an error", () => {
    // The sign-in page is also what a plain signed-out visit lands on.
    expect(signInError(undefined)).toBeUndefined();
  });

  test.each([
    ["not_a_member", "workspace"],
    ["not_allowed", "allow list"],
    ["no_workspace", "no workspace"],
    ["state_mismatch", "expired"],
  ])("%s says why", (code, fragment) => {
    expect(signInError(code)).toContain(fragment);
  });

  test("every code the API can send has wording", () => {
    // These are the literals in `refuse(...)`. A new one added there without a
    // line here falls through to the generic message, which is the one thing
    // this test exists to notice.
    const sent = ["no_code", "state_mismatch", "no_workspace", "not_a_member", "not_allowed"];
    const generic = signInError("something-nobody-defined");

    const silent = sent.filter((code) => signInError(code) === generic);
    expect(silent).toEqual(["no_code"]);
  });

  test("an unknown code shows a sentence, never the code", () => {
    // "signin=wat" means nothing to the person reading it.
    const message = signInError("wat");
    expect(message).toBeTruthy();
    expect(message).not.toContain("wat");
  });
});
