import { describe, expect, test } from "bun:test";
import { signWebhookBody, verifyWebhookSignature } from "../src/webhook-signature.ts";

/**
 * The signature check is the only thing standing between the public internet
 * and a write into the mirror, so the cases below are the ones that decide
 * whether it is a check or a decoration.
 *
 * The fixture is ClickUp's own worked example from
 * https://developer.clickup.com/docs/webhooksignature — body and key exactly as
 * documented — so this asserts against ClickUp's arithmetic rather than against
 * our own implementation reproducing itself.
 */
const DOC_SECRET = "secret";
const DOC_BODY =
  '{"webhook_id":"7689a169-a000-4985-8676-6902b96d6627","event":"taskCreated","task_id":"c0j"}';

/**
 * The digest for the pair above, pinned rather than recomputed.
 *
 * A test that signs with the same function it is checking passes no matter what
 * that function does. This constant is the one thing here that comes from
 * outside the codebase, so it is what actually says "we compute the same HMAC
 * ClickUp does" instead of "we agree with ourselves".
 */
const DOC_SIGNATURE = "4830bf524f6e29a3e8da953936c6f21c1fea2b9669b825d3e1be293ef3416c8c";

describe("signWebhookBody", () => {
  test("reproduces the digest for ClickUp's own worked example", () => {
    expect(signWebhookBody(DOC_BODY, DOC_SECRET)).toBe(DOC_SIGNATURE);
    // Lowercase hex, not base64 — the other encoding webhook providers pick,
    // and the one that fails by rejecting every delivery rather than loudly.
    expect(DOC_SIGNATURE).toMatch(/^[0-9a-f]{64}$/);
  });

  test("signs the bytes, not the parsed object", () => {
    // Same JSON, different whitespace and key order. A receiver that verified
    // against `JSON.stringify(JSON.parse(body))` would call these equal and
    // then reject every real delivery, since ClickUp's formatting is not ours.
    const reserialized = JSON.stringify(JSON.parse(DOC_BODY));
    const spaced = `${DOC_BODY.slice(0, -1)} }`;

    expect(signWebhookBody(reserialized, DOC_SECRET)).not.toBe(signWebhookBody(spaced, DOC_SECRET));
  });
});

describe("verifyWebhookSignature", () => {
  const valid = DOC_SIGNATURE;

  test("accepts a signature ClickUp would have sent", () => {
    expect(
      verifyWebhookSignature({ body: DOC_BODY, signature: valid, secrets: [DOC_SECRET] }),
    ).toBe(true);
  });

  test("accepts it in upper case, since hex has two spellings", () => {
    expect(
      verifyWebhookSignature({
        body: DOC_BODY,
        signature: valid.toUpperCase(),
        secrets: [DOC_SECRET],
      }),
    ).toBe(true);
  });

  test("rejects a signature made with a different secret", () => {
    const wrong = signWebhookBody(DOC_BODY, "not-the-secret");
    expect(
      verifyWebhookSignature({ body: DOC_BODY, signature: wrong, secrets: [DOC_SECRET] }),
    ).toBe(false);
  });

  test("rejects a valid signature for a different body", () => {
    // The replay an attacker actually has: a signature they saw on the wire,
    // reused on a body they wrote.
    const tampered = DOC_BODY.replace('"c0j"', '"someone-elses-task"');
    expect(
      verifyWebhookSignature({ body: tampered, signature: valid, secrets: [DOC_SECRET] }),
    ).toBe(false);
  });

  test("rejects a truncated body", () => {
    expect(
      verifyWebhookSignature({
        body: DOC_BODY.slice(0, -1),
        signature: valid,
        secrets: [DOC_SECRET],
      }),
    ).toBe(false);
  });

  test("rejects a truncated signature", () => {
    // Length is checked before any HMAC runs, so this never reaches
    // timingSafeEqual, which throws on a length mismatch.
    expect(
      verifyWebhookSignature({
        body: DOC_BODY,
        signature: valid.slice(0, 63),
        secrets: [DOC_SECRET],
      }),
    ).toBe(false);
  });

  test("rejects a missing header", () => {
    expect(
      verifyWebhookSignature({ body: DOC_BODY, signature: undefined, secrets: [DOC_SECRET] }),
    ).toBe(false);
    expect(verifyWebhookSignature({ body: DOC_BODY, signature: null, secrets: [DOC_SECRET] })).toBe(
      false,
    );
    expect(verifyWebhookSignature({ body: DOC_BODY, signature: "", secrets: [DOC_SECRET] })).toBe(
      false,
    );
  });

  test("rejects sixty-four characters that are not hex", () => {
    // Buffer.from(..., "hex") truncates rather than throwing, so the right
    // length of the wrong alphabet is the case that gets past a naive check.
    expect(
      verifyWebhookSignature({ body: DOC_BODY, signature: "z".repeat(64), secrets: [DOC_SECRET] }),
    ).toBe(false);
  });

  test("rejects everything when there is no secret to check against", () => {
    // The state a deployment is in before the worker has registered anything.
    // "Nothing to compare" must never read as "nothing to object to".
    expect(verifyWebhookSignature({ body: DOC_BODY, signature: valid, secrets: [] })).toBe(false);
  });

  test("accepts either secret while a re-registration is in flight", () => {
    // ClickUp keeps delivering under the old webhook for a moment after a new
    // one is made. Both secrets are live, and a delivery signed with either is
    // genuine.
    const rotated = signWebhookBody(DOC_BODY, "the-new-one");
    for (const signature of [valid, rotated]) {
      expect(
        verifyWebhookSignature({
          body: DOC_BODY,
          signature,
          secrets: [DOC_SECRET, "the-new-one"],
        }),
      ).toBe(true);
    }
  });
});
