import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The `X-Signature` header ClickUp puts on every webhook delivery.
 *
 * https://developer.clickup.com/docs/webhooksignature — HMAC-SHA256 over the
 * raw request body, keyed by the `secret` ClickUp returns when the webhook is
 * created, digested as lowercase hex.
 *
 * "Raw" is the whole trick. The signature covers the exact bytes ClickUp sent,
 * so a receiver that parses the JSON and re-serializes it to check the digest
 * is relying on its own serializer agreeing with ClickUp's about key order,
 * whitespace, number formatting and unicode escaping. The route reads text
 * first and parses second for that reason and no other.
 *
 * Checked against ClickUp rather than against the docs: on 2026-08-23, four
 * genuine deliveries (taskCreated, taskStatusUpdated, taskUpdated, taskDeleted)
 * to a temporary list-scoped webhook each carried an X-Signature identical to
 * what `signWebhookBody` produces over the raw body. Re-serializing happened to
 * agree on those four payloads, which is luck rather than a guarantee and not
 * something to build on.
 */

/** 32 bytes of SHA-256 as hex. Anything else is not a signature. */
const HEX_DIGEST_LENGTH = 64;
const DIGEST_BYTES = 32;

export function signWebhookBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * True when `signature` is a digest of `body` under any of `secrets`.
 *
 * Several secrets, because there is always a window with two live ones: the
 * worker registers a replacement webhook before ClickUp has stopped delivering
 * under the old one, and a delivery in flight during that swap is signed with
 * whichever secret its webhook holds. Accepting both is what keeps a
 * re-registration from looking like an attack.
 *
 * Every candidate is compared with `timingSafeEqual` and the loop does not
 * stop at the first match, so neither the answer nor how long it took says
 * which secret was tried or how nearly it fit. The length checks happen before
 * any HMAC is computed and leak only whether the header was the right shape,
 * which is already visible from the response.
 */
export function verifyWebhookSignature(input: {
  body: string;
  signature: string | null | undefined;
  secrets: readonly string[];
}): boolean {
  const { body, signature, secrets } = input;
  if (!signature || signature.length !== HEX_DIGEST_LENGTH) return false;

  // Buffer.from(..., "hex") truncates at the first character that is not hex
  // rather than throwing, so the byte length is what actually rules out
  // "sixty-four characters of something else".
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== DIGEST_BYTES) return false;

  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(body, "utf8").digest();
    if (timingSafeEqual(expected, provided)) matched = true;
  }
  return matched;
}
