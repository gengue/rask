import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

/**
 * Environment parsing, because getting it wrong stops the worker at boot rather
 * than degrading anything.
 *
 * The case that matters is the blank value. `.env.example` documents optional
 * settings as `NAME=` with nothing after it, and `docker-compose.prod.yml`
 * interpolates `${NAME}` into `""` when the host has no such variable — so
 * "unset" arrives as an empty string in both of the ways anyone actually
 * deploys this, and neither of them is a value.
 */

const base = {
  DATABASE_URL: "postgres://rask:rask@localhost:5432/rask_test",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const load = (extra: Record<string, string>) =>
  loadConfig({ ...base, ...extra } as NodeJS.ProcessEnv);

describe("optional settings", () => {
  test("reads a blank webhook URL as absent rather than refusing to start", () => {
    // Exactly what `.env.example` ships. This threw "Invalid URL" and took the
    // whole worker down with it.
    expect(load({ CLICKUP_WEBHOOK_URL: "" }).CLICKUP_WEBHOOK_URL).toBeUndefined();
  });

  test("reads a blank team id as absent, not as an empty path segment", () => {
    // `${CLICKUP_TEAM_ID}` unset in compose becomes "", and "" ?? entry.teamId
    // is "", which asks ClickUp for GET /v2/team//space.
    expect(load({ CLICKUP_TEAM_ID: "" }).CLICKUP_TEAM_ID).toBeUndefined();
    expect(load({ CLICKUP_TEAM_ID: "  " }).CLICKUP_TEAM_ID).toBeUndefined();
  });

  test("keeps a real value, trimmed", () => {
    const config = load({
      CLICKUP_WEBHOOK_URL: " https://rask.example/webhooks/clickup ",
      CLICKUP_WEBHOOK_LIST_ID: "901300000001",
    });
    expect(config.CLICKUP_WEBHOOK_URL).toBe("https://rask.example/webhooks/clickup");
    expect(config.CLICKUP_WEBHOOK_LIST_ID).toBe("901300000001");
  });

  test("still refuses a webhook URL that is not one", () => {
    // Absent is fine; wrong is not. A typo here means the registration succeeds
    // against an endpoint that will never answer.
    expect(() => load({ CLICKUP_WEBHOOK_URL: "localhost:3000/webhooks" })).toThrow();
  });
});

describe("poll intervals", () => {
  test("defaults to two minutes without webhooks and ten with them", () => {
    const config = load({});
    expect(config.POLL_INTERVAL_MS).toBe(120_000);
    expect(config.POLL_INTERVAL_WEBHOOK_MS).toBe(600_000);
  });

  test("takes both from the environment", () => {
    const config = load({ POLL_INTERVAL_MS: "30000", POLL_INTERVAL_WEBHOOK_MS: "900000" });
    expect(config.POLL_INTERVAL_MS).toBe(30_000);
    expect(config.POLL_INTERVAL_WEBHOOK_MS).toBe(900_000);
  });
});
