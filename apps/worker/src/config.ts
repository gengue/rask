import { loadKey } from "@rask/schema";
import { z } from "zod";

/**
 * An optional setting where the empty string means "not set".
 *
 * Both ways of not setting one of these produce `""` rather than nothing:
 * `.env.example` documents them as `NAME=` with the value left blank, and
 * `docker-compose.prod.yml` interpolates `${NAME}` into the empty string when
 * the host has no such variable. Treating `""` as a value is how an unset
 * `CLICKUP_TEAM_ID` becomes `GET /v2/team//space`, and how a blank
 * `CLICKUP_WEBHOOK_URL` refuses to parse as a URL and stops the worker booting.
 */
const optionalText = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const optionalUrl = optionalText.refine(
  (value) => value === undefined || isHttpUrl(value),
  "must be an absolute http(s) URL",
);

/**
 * The protocol check is the whole point.
 *
 * `URL.canParse("localhost:3000/webhooks")` is true — it reads `localhost:` as
 * the scheme — so parsing alone accepts the exact typo somebody makes when
 * copying a dev address into this variable, and the registration then succeeds
 * against an endpoint ClickUp can never reach.
 */
function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  CLICKUP_TEAM_ID: optionalText,
  /**
   * Public HTTPS URL of the API's `/webhooks/clickup` route.
   *
   * Unset means no registration is attempted, which is the normal state in dev:
   * ClickUp has to be able to reach it from the internet, and localhost is not.
   * Everything else keeps working; polling is simply the only source of change.
   */
  CLICKUP_WEBHOOK_URL: optionalUrl,
  /**
   * Narrows the webhook to a single List instead of the whole Workspace.
   *
   * For a cautious first rollout, or for a developer pointing a tunnel at a
   * real workspace who does not want every task in it arriving. Unset in
   * production.
   */
  CLICKUP_WEBHOOK_LIST_ID: optionalText,
  /**
   * How often each tracked list is re-polled when no webhook is delivering.
   *
   * This is the pre-webhook behaviour and the floor Rask falls back to whenever
   * a registration is missing, unhealthy or impossible.
   */
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  /**
   * The same poll, while a healthy webhook is delivering.
   *
   * Five times slower, not switched off. Webhooks are lossy and have no replay,
   * so this stays as the thing that notices what they dropped — but it is a
   * backstop then rather than the mechanism, and one request per tracked list
   * every ten minutes is what a backstop should cost.
   */
  POLL_INTERVAL_WEBHOOK_MS: z.coerce.number().int().positive().default(600_000),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  /** Hour, local time, for the full reconciliation pass. */
  RECONCILE_HOUR: z.coerce.number().int().min(0).max(23).default(3),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Bad worker environment:\n${z.prettifyError(parsed.error)}`);
  }
  return { ...parsed.data, encryptionKey: loadKey(parsed.data.TOKEN_ENCRYPTION_KEY) };
}

export type Config = ReturnType<typeof loadConfig>;
