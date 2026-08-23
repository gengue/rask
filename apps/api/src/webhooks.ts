import { verifyWebhookSignature, webhookEvent } from "@rask/clickup-client";
import { type Db, enqueueWebhookEvent, loadWebhooks } from "@rask/schema";
import { Hono } from "hono";

/**
 * Where ClickUp posts change events.
 *
 * This is the only route in Rask with no session in front of it, so it is the
 * only place where "who is asking" has to be established from the request
 * itself. That answer is the `X-Signature` header and nothing else: an endpoint
 * that skips the check is strictly worse than no endpoint at all, because it
 * hands anyone who finds the URL a write into the mirror that every connected
 * browser will then be told about over SSE.
 *
 * Everything here is arranged around one rule — do as little as possible before
 * the signature verifies, and as little as possible after it. Before: a header
 * shape check, a size cap, one cached secret read. After: exactly one INSERT.
 * The read-back from ClickUp happens in the worker, off a table, because doing
 * it inline would let a burst of deliveries turn into a burst of outbound HTTP
 * from a process that is also serving the app.
 */

/**
 * The largest delivery we will read.
 *
 * ClickUp events carry an event name, a task id and a `history_items` array;
 * the biggest ones seen are low single-digit kilobytes. 64 KiB is far above
 * that and far below anything worth buffering from an unauthenticated caller.
 */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/**
 * How long a fetched set of secrets is trusted, and how often a failed
 * verification is allowed to force a re-read.
 *
 * The two windows are for opposite problems. The TTL keeps a delivery from
 * costing a database round trip on the unauthenticated path. The floor keeps
 * the refresh-on-miss below — which exists so a webhook the worker registered
 * seconds ago is accepted immediately rather than after the TTL — from being a
 * way to make an endpoint anyone can reach query Postgres in a loop.
 */
const SECRET_TTL_MS = 60_000;
const SECRET_REFRESH_FLOOR_MS = 5_000;

export interface WebhookRouteDeps {
  /** Candidate secrets to verify against. Expected to be cheap and cached. */
  secrets: () => Promise<readonly string[]>;
  /**
   * Re-reads the secrets now, if it has not just done so. Called only when a
   * delivery fails to verify, to close the window where the worker has
   * registered a webhook the API has not noticed yet.
   */
  refreshSecrets?: () => Promise<readonly string[]>;
  enqueue: (event: { taskId: string; event: string; webhookId: string | null }) => Promise<void>;
  maxBodyBytes?: number;
}

export function webhookRoutes(deps: WebhookRouteDeps) {
  const app = new Hono();
  const maxBytes = deps.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;

  app.post("/clickup", async (c) => {
    /*
     * Nothing below returns 401 or 410, however wrong the request is.
     *
     * ClickUp suspends a webhook the moment its endpoint answers with either
     * one (https://developer.clickup.com/docs/webhookhealth), where every other
     * failure only counts towards a hundred. So the codes that mean "I will not
     * process this" are 400 and 403: they still tell ClickUp the delivery
     * failed, without turning one bad minute — a stale secret, a restart
     * mid-registration — into a webhook that has stopped for good and needs a
     * human to notice.
     */
    const signature = c.req.header("x-signature");
    if (!signature) return c.json({ error: "missing X-Signature" }, 400);

    // Cheapest rejection there is: a declared size we will not read, refused
    // before a single byte of the body comes off the socket.
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return c.json({ error: "body too large" }, 413);
    }

    const body = await readCapped(c.req.raw, maxBytes);
    if (body === null) return c.json({ error: "body too large" }, 413);

    let secrets = await deps.secrets();
    let verified = verifyWebhookSignature({ body, signature, secrets });

    // A miss may just mean the worker registered a webhook since the cache was
    // filled. Re-read once and try again before refusing; the helper's own
    // floor is what keeps this from being a database amplifier.
    if (!verified && deps.refreshSecrets) {
      secrets = await deps.refreshSecrets();
      verified = verifyWebhookSignature({ body, signature, secrets });
    }

    if (!verified) {
      // Same answer whether the signature was wrong or there was nothing to
      // check it against. Saying "no secret configured" would tell an
      // unauthenticated caller that this deployment cannot verify anything.
      return c.json({ error: "bad signature" }, 403);
    }

    const parsed = webhookEvent.safeParse(safeJson(body));
    if (!parsed.success) return c.json({ error: "unrecognised payload" }, 400);

    /*
     * An event with no task id is accepted and dropped.
     *
     * Rask subscribes to task events only, but a webhook somebody registered by
     * hand with `"*"` delivers Space, Folder and Goal events too, and none of
     * them names a task to read back. Answering 2xx is the point: a refusal
     * would count against the webhook's health for events we simply have no use
     * for, and eventually suspend a webhook that is working perfectly.
     */
    const event = parsed.data;
    if (!event.task_id) return c.json({ ok: true, ignored: event.event });

    await deps.enqueue({
      taskId: event.task_id,
      event: event.event,
      webhookId: event.webhook_id ?? null,
    });

    return c.json({ ok: true });
  });

  return app;
}

/**
 * The secrets the receiving route verifies against, read at most once a minute.
 *
 * `envSecret` is `CLICKUP_WEBHOOK_SECRET`, and it is a real case rather than a
 * convenience: a webhook registered by hand, or one carried over from another
 * deployment, has a secret Rask never saw at creation and cannot put in the
 * table. It is listed alongside the registered ones, never instead of them.
 */
export function webhookSecrets(db: Db, key: Buffer, envSecret?: string) {
  let cached: readonly string[] = envSecret ? [envSecret] : [];
  let readAt = 0;
  let inflight: Promise<readonly string[]> | null = null;

  const read = (): Promise<readonly string[]> => {
    inflight ??= loadWebhooks(db, key)
      .then((rows) => {
        cached = [...rows.map((row) => row.secret), ...(envSecret ? [envSecret] : [])];
        return cached;
      })
      .catch((error) => {
        // Keep serving the last known set. A database blip should not turn
        // every delivery into a refusal that counts against the webhook.
        console.error("[webhooks] secret read failed:", messageOf(error));
        return cached;
      })
      .finally(() => {
        // Set on failure too, so a database that is down is retried on the next
        // TTL rather than on the next delivery.
        readAt = Date.now();
        inflight = null;
      });
    return inflight;
  };

  return {
    secrets: (): Promise<readonly string[]> =>
      Date.now() - readAt < SECRET_TTL_MS ? Promise.resolve(cached) : read(),
    refreshSecrets: (): Promise<readonly string[]> =>
      Date.now() - readAt < SECRET_REFRESH_FLOOR_MS ? Promise.resolve(cached) : read(),
  };
}

/** Production wiring: secrets from the mirror, events into the queue table. */
export function clickUpWebhookRoutes(db: Db, key: Buffer, envSecret?: string) {
  const { secrets, refreshSecrets } = webhookSecrets(db, key, envSecret);
  return webhookRoutes({
    secrets,
    refreshSecrets,
    enqueue: (event) => enqueueWebhookEvent(db, event),
  });
}

/**
 * The raw body, or null if it runs past `max`.
 *
 * Raw because the signature covers the bytes ClickUp sent, so the parse has to
 * happen afterwards and from this exact string. Capped by reading the stream
 * rather than by trusting `Content-Length`, which the caller writes and can
 * simply omit — the declared size is checked first as a fast path, and this is
 * what actually holds.
 */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const stream = request.body;
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
