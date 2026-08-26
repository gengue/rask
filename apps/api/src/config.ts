import { CLICKUP_API_BASE } from "@rask/clickup-client";
import { loadKey } from "@rask/schema";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  CLICKUP_CLIENT_ID: z.string().min(1),
  CLICKUP_CLIENT_SECRET: z.string().min(1),
  CLICKUP_REDIRECT_URI: z.string().url(),
  /**
   * Where the ClickUp API lives.
   *
   * Only ever moved off the default by the end-to-end suite, which points it
   * at a closed port. That stack seeds a fixture workspace and holds no real
   * OAuth token, so every outbound call can only ever come back 401 — but it
   * comes back 401 *over the internet*, and a CI runner's round-trip to
   * api.clickup.com is what made "Could not read time from ClickUp." take
   * longer than a test's five-second wait and turned the suite red at random.
   * A refused connection is the same answer in eight milliseconds.
   */
  CLICKUP_API_BASE: z.string().url().default(CLICKUP_API_BASE),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  /**
   * The one ClickUp Workspace this deployment serves.
   *
   * This is the access control. Rask reads from a mirror, not from ClickUp, so
   * a session is enough to read every task in that mirror — ClickUp's own
   * permissions are never consulted on the read path. Without this check any
   * ClickUp account anywhere could finish the OAuth flow and read the whole
   * company's tasks.
   *
   * Optional in development, where the workspace is whatever the developer's
   * token can see. `loadConfig` refuses to start in production without it.
   */
  CLICKUP_TEAM_ID: z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined)),
  /**
   * Emails allowed to sign in, on top of Workspace membership.
   *
   * Unset means every member of the Workspace may sign in, which is usually
   * what a team wants. Set it to run a pilot, or where the Workspace has guests
   * who should not be here.
   */
  RASK_ALLOWED_EMAILS: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    )
    .transform((list) => (list?.length ? list : undefined)),
  /** Directory of built SPA assets. Set in production so one process serves both. */
  WEB_DIST: z.string().optional(),
  /**
   * Cookie name for the session.
   *
   * Cookies are scoped by host and ignore the port, so two checkouts served
   * from localhost overwrite each other's session. Give each one its own name
   * and they stop fighting. Leave it alone unless you run more than one.
   */
  SESSION_COOKIE_NAME: z.string().min(1).default("rask_session"),
  /**
   * An extra secret the webhook endpoint will verify against.
   *
   * Not normally set. The worker stores the secret of every webhook it
   * registers in the `webhooks` table, encrypted, and the endpoint reads them
   * from there. This is for a webhook created outside Rask — by hand, or in
   * another deployment — whose secret was never ours to store.
   *
   * The empty string means unset: `.env.example` documents it as `NAME=` with
   * nothing after it, and an empty secret would otherwise be offered to the
   * verifier as a real candidate.
   */
  CLICKUP_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined)),
  NODE_ENV: z.string().default("development"),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Bad API environment:\n${z.prettifyError(parsed.error)}`);

  /*
   * Refused at boot rather than defaulted, because the safe default does not
   * exist: guessing the Workspace from whoever signs in first is how a
   * deployment ends up serving one company's tasks to another's account.
   */
  if (parsed.data.NODE_ENV === "production" && !parsed.data.CLICKUP_TEAM_ID) {
    throw new Error(
      "CLICKUP_TEAM_ID is required in production. It is what stops any ClickUp " +
        "account from signing in and reading this deployment's mirror. Find it in " +
        "any ClickUp URL: app.clickup.com/<team_id>/...",
    );
  }

  return {
    ...parsed.data,
    encryptionKey: loadKey(parsed.data.TOKEN_ENCRYPTION_KEY),
    isProduction: parsed.data.NODE_ENV === "production",
  };
}

export type Config = ReturnType<typeof loadConfig>;
