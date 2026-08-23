import { describe, expect, test } from "bun:test";
import { ClickUpError } from "@rask/clickup-client";
import { placeholderId } from "@rask/clickup-client/vocabulary";
import { backoffMs, isPermanent, MAX_ATTEMPTS } from "../src/outbox.ts";

/**
 * Retry classification is the part of the drain that is easy to get subtly
 * wrong and expensive when it is: retry a 400 forever and the queue jams behind
 * one bad row; give up on a 502 and a write is lost with the user told it
 * failed when it never really did.
 */
describe("retry classification", () => {
  test("gives up on a 4xx, which will fail the same way next time", () => {
    expect(isPermanent(new ClickUpError(400, "bad request"))).toBe(true);
    expect(isPermanent(new ClickUpError(401, "token invalid"))).toBe(true);
    expect(isPermanent(new ClickUpError(404, "not found"))).toBe(true);
  });

  test("retries a 429, because the ClickUp client will have waited out the reset", () => {
    expect(isPermanent(new ClickUpError(429, "rate limited"))).toBe(false);
  });

  test("retries 5xx", () => {
    expect(isPermanent(new ClickUpError(500, "boom"))).toBe(false);
    expect(isPermanent(new ClickUpError(502, "bad gateway"))).toBe(false);
  });

  test("retries anything that is not a ClickUp error at all", () => {
    // A DNS failure or a dropped socket is transient by nature.
    expect(isPermanent(new Error("ECONNRESET"))).toBe(false);
  });
});

describe("backoff", () => {
  test("doubles each attempt", () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(2)).toBe(4_000);
    expect(backoffMs(3)).toBe(8_000);
    expect(backoffMs(4)).toBe(16_000);
  });

  test("caps, so a long-lived row does not schedule itself past the heat death", () => {
    expect(backoffMs(30)).toBe(300_000);
  });

  test("never exceeds the cap within the attempt budget", () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(backoffMs(attempt)).toBeLessThanOrEqual(300_000);
    }
  });
});

test("placeholder ids are prefixed so the API, worker and browser agree on them", () => {
  expect(placeholderId("abc")).toBe("tmp_abc");
});
