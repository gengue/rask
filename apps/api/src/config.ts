import { loadKey } from "@rask/schema";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  CLICKUP_CLIENT_ID: z.string().min(1),
  CLICKUP_CLIENT_SECRET: z.string().min(1),
  CLICKUP_REDIRECT_URI: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
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
  return {
    ...parsed.data,
    encryptionKey: loadKey(parsed.data.TOKEN_ENCRYPTION_KEY),
    isProduction: parsed.data.NODE_ENV === "production",
  };
}

export type Config = ReturnType<typeof loadConfig>;
