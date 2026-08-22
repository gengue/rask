import { loadKey } from "@rask/schema";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  CLICKUP_TEAM_ID: z.string().optional(),
  /** How often each tracked list is re-polled. ClickUp webhooks are lossy. */
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
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
