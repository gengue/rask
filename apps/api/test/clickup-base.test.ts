import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLICKUP_API_BASE } from "@rask/clickup-client";
import { createTestDb, TEST_DATABASE_URL } from "@rask/schema";
import { authRoutes } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";

/**
 * Every outbound call has to go where the config says.
 *
 * `CLICKUP_API_BASE` exists for one caller: the end-to-end suite points it at
 * a closed port so its fixture stack never leaves the machine. The fixture
 * holds no real token, so a call that escapes the override still *fails* — it
 * just fails after a round-trip to api.clickup.com, and that round-trip is
 * what used to run past a five-second assertion and turn CI red at random.
 *
 * Which makes a missed `baseUrl` invisible: nothing throws, no test fails, the
 * suite simply goes flaky again some weeks later. The sweep below is there
 * because that is not a failure anyone reads correctly the second time.
 */

const KEY = Buffer.alloc(32, 7).toString("base64");
const OVERRIDE = "http://127.0.0.1:1";

function makeConfig(over: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    TOKEN_ENCRYPTION_KEY: KEY,
    SESSION_SECRET: "session-secret",
    CLICKUP_CLIENT_ID: "test-client-id",
    CLICKUP_CLIENT_SECRET: "test-client-secret",
    CLICKUP_REDIRECT_URI: "http://localhost:3000/auth/clickup/callback",
    NODE_ENV: "development",
    ...over,
  } as NodeJS.ProcessEnv);
}

test("defaults to ClickUp itself", () => {
  expect(makeConfig().CLICKUP_API_BASE).toBe(CLICKUP_API_BASE);
});

test("the OAuth callback spends the code at the configured base", async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    // Enough of an answer to get past the exchange and into the two calls
    // that follow it, which is where a second client is built.
    const url = String(input);
    const body = url.includes("/oauth/token")
      ? { access_token: "granted-token", token_type: "Bearer" }
      : url.endsWith("/v2/user")
        ? {
            user: {
              id: 4242,
              username: "Base User",
              email: "base@example.test",
              initials: "BU",
              color: "#000000",
              profilePicture: null,
            },
          }
        : { teams: [{ id: "9001", name: "Ventura" }] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    const app = authRoutes(
      createTestDb(),
      // Refused on workspace membership, so nothing is written: what is being
      // read here is the three URLs the callback asked for on the way there.
      makeConfig({ CLICKUP_API_BASE: OVERRIDE, CLICKUP_TEAM_ID: "somewhere-else" }),
    );
    await app.request("/clickup/callback?code=abc&state=ours", {
      headers: { cookie: "rask_oauth_state=ours" },
    });
  } finally {
    globalThis.fetch = original;
  }

  expect(seen.length).toBeGreaterThan(0);
  for (const url of seen) expect(url.startsWith(OVERRIDE)).toBe(true);
});

/**
 * `clientFor` in `index.ts` is the one that matters and the one no test can
 * reach: importing that module boots a server on a real port. So the invariant
 * is asserted over the source instead — crude, and still the only thing that
 * goes red when the next call site forgets.
 */
describe("every client in apps/api", () => {
  test("is built with the configured base", async () => {
    const dir = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];

    for (const name of await readdir(dir)) {
      if (!name.endsWith(".ts")) continue;
      const source = await readFile(join(dir, name), "utf8");
      // Each constructor call, from `new ClickUpClient(` to its closing brace.
      for (const match of source.matchAll(/new ClickUpClient\(\{[\s\S]*?\}\)/g)) {
        if (!match[0].includes("baseUrl")) offenders.push(`${name}: ${match[0]}`);
      }
      for (const match of source.matchAll(/ClickUpClient\.exchangeCode\(\{[\s\S]*?\}\)/g)) {
        if (!match[0].includes("baseUrl")) offenders.push(`${name}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
