import { describe, expect, test } from "bun:test";
import { signWebhookBody } from "@rask/clickup-client";
import { MAX_WEBHOOK_BODY_BYTES, webhookRoutes } from "../src/webhooks.ts";

/**
 * The receiving route, exercised as HTTP rather than as a function.
 *
 * The unit under test is not "does the HMAC match" — that lives in the client
 * package — but "does a request that should be refused actually get refused",
 * which is a property of the order the route does things in. Calling
 * `app.request` means the header parsing, the body reading and the early
 * returns are all in the path, and a refactor that verifies the signature one
 * line later than it should still fails here.
 */

const SECRET = "test-secret";

function delivery(body: unknown) {
  return JSON.stringify(body);
}

const EVENT = delivery({
  event: "taskUpdated",
  task_id: "9hz1",
  webhook_id: "7689a169-a000-4985-8676-6902b96d6627",
});

interface Enqueued {
  taskId: string;
  event: string;
  webhookId: string | null;
}

function makeApp(
  options: {
    secrets?: string[];
    /** Secrets a forced refresh would find. Omitted means no refresh is wired. */
    refreshed?: string[];
    maxBodyBytes?: number;
  } = {},
) {
  const enqueued: Enqueued[] = [];
  let refreshes = 0;
  let current: readonly string[] = options.secrets ?? [SECRET];

  const app = webhookRoutes({
    secrets: async () => current,
    refreshSecrets: options.refreshed
      ? async () => {
          refreshes++;
          current = options.refreshed ?? [];
          return current;
        }
      : undefined,
    enqueue: async (event) => {
      enqueued.push(event);
    },
    maxBodyBytes: options.maxBodyBytes,
  });

  const post = (body: string, headers: Record<string, string> = {}) =>
    app.request("/clickup", { method: "POST", body, headers });

  const signed = (body: string, secret = SECRET) =>
    post(body, { "x-signature": signWebhookBody(body, secret) });

  return { post, signed, enqueued, refreshes: () => refreshes };
}

describe("signature check", () => {
  test("accepts a correctly signed delivery and queues the task", async () => {
    const { signed, enqueued } = makeApp();

    const response = await signed(EVENT);

    expect(response.status).toBe(200);
    expect(enqueued).toEqual([
      {
        taskId: "9hz1",
        event: "taskUpdated",
        webhookId: "7689a169-a000-4985-8676-6902b96d6627",
      },
    ]);
  });

  test("refuses a signature made with the wrong secret", async () => {
    const { signed, enqueued } = makeApp();

    const response = await signed(EVENT, "attacker-guess");

    expect(response.status).toBe(403);
    expect(enqueued).toEqual([]);
  });

  test("refuses a request with no X-Signature at all", async () => {
    const { post, enqueued } = makeApp();

    const response = await post(EVENT);

    expect(response.status).toBe(400);
    expect(enqueued).toEqual([]);
  });

  test("refuses a body that was altered after signing", async () => {
    // A real signature lifted off the wire, replayed against a body the
    // attacker chose. This is the attack the header exists to stop.
    const { post, enqueued } = makeApp();
    const stolen = signWebhookBody(EVENT, SECRET);

    const response = await post(delivery({ event: "taskUpdated", task_id: "not-yours" }), {
      "x-signature": stolen,
    });

    expect(response.status).toBe(403);
    expect(enqueued).toEqual([]);
  });

  test("refuses a truncated body", async () => {
    const { post, enqueued } = makeApp();

    const response = await post(EVENT.slice(0, -5), {
      "x-signature": signWebhookBody(EVENT, SECRET),
    });

    expect(response.status).toBe(403);
    expect(enqueued).toEqual([]);
  });

  test("refuses everything when no secret is configured", async () => {
    // The state between deploying the endpoint and registering a webhook.
    const { signed, enqueued } = makeApp({ secrets: [] });

    const response = await signed(EVENT);

    expect(response.status).toBe(403);
    expect(enqueued).toEqual([]);
  });

  test("never answers 401, which ClickUp reads as 'suspend this webhook'", async () => {
    // https://developer.clickup.com/docs/webhookhealth — a 401 or a 410
    // suspends the webhook immediately, where any other failure only counts
    // towards a hundred. Every refusal here has to stay off those two codes.
    const { post, signed } = makeApp();

    const refusals = [
      await post(EVENT),
      await signed(EVENT, "wrong"),
      await post(EVENT, { "x-signature": "z".repeat(64) }),
      await post("not json", { "x-signature": signWebhookBody("not json", SECRET) }),
    ];

    for (const response of refusals) {
      expect(response.ok).toBe(false);
      expect([401, 410]).not.toContain(response.status);
    }
  });
});

describe("body limit", () => {
  test("refuses a body past the cap before trying to verify it", async () => {
    const { post, enqueued } = makeApp({ maxBodyBytes: 128 });
    const big = delivery({ event: "taskUpdated", task_id: "9hz1", pad: "x".repeat(500) });

    const response = await post(big, { "x-signature": signWebhookBody(big, SECRET) });

    // Correctly signed and still refused: the cap is about how much an
    // unauthenticated caller can make us buffer, so it cannot depend on
    // knowing whether the caller is genuine.
    expect(response.status).toBe(413);
    expect(enqueued).toEqual([]);
  });

  test("refuses a body past the cap even when Content-Length lies", async () => {
    // The declared length is a fast path, not the check. Bun sets
    // Content-Length itself here, so the stream cap is what has to hold.
    const { post } = makeApp({ maxBodyBytes: 64 });
    const big = "x".repeat(4096);

    const response = await post(big, { "x-signature": "0".repeat(64) });

    expect(response.status).toBe(413);
  });

  test("accepts a delivery comfortably inside the default cap", async () => {
    const { signed } = makeApp();
    const body = delivery({
      event: "taskUpdated",
      task_id: "9hz1",
      history_items: Array.from({ length: 20 }, (_, i) => ({ id: String(i), field: "status" })),
    });

    expect(body.length).toBeLessThan(MAX_WEBHOOK_BODY_BYTES);
    expect((await signed(body)).status).toBe(200);
  });
});

describe("payload handling", () => {
  test("accepts and drops an event that names no task", async () => {
    // A `*` webhook somebody made by hand delivers Space and Goal events.
    // Refusing them would count against a webhook that is working fine.
    const { signed, enqueued } = makeApp();
    const body = delivery({ event: "spaceUpdated", space_id: "42" });

    const response = await signed(body);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: "spaceUpdated" });
    expect(enqueued).toEqual([]);
  });

  test("refuses a signed body that is not a ClickUp event", async () => {
    const { signed, enqueued } = makeApp();

    const response = await signed(delivery({ nothing: "recognisable" }));

    expect(response.status).toBe(400);
    expect(enqueued).toEqual([]);
  });

  test("refuses a signed body that is not JSON", async () => {
    const { signed } = makeApp();
    expect((await signed("<html>502 Bad Gateway</html>")).status).toBe(400);
  });
});

describe("secret refresh", () => {
  test("re-reads once when a delivery does not verify, then accepts it", async () => {
    // The window that exists by construction: the worker registers a webhook in
    // its own process and the API only learns the secret through Postgres.
    // Without this, every delivery in that window is refused and counts.
    const { signed, enqueued, refreshes } = makeApp({
      secrets: ["stale"],
      refreshed: ["stale", SECRET],
    });

    const response = await signed(EVENT);

    expect(response.status).toBe(200);
    expect(refreshes()).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  test("still refuses when the refresh finds nothing new", async () => {
    const { signed, enqueued, refreshes } = makeApp({
      secrets: ["stale"],
      refreshed: ["stale"],
    });

    expect((await signed(EVENT)).status).toBe(403);
    expect(refreshes()).toBe(1);
    expect(enqueued).toEqual([]);
  });

  test("does not refresh on a delivery that already verifies", async () => {
    const { signed, refreshes } = makeApp({ secrets: [SECRET], refreshed: [SECRET] });

    await signed(EVENT);

    expect(refreshes()).toBe(0);
  });
});
