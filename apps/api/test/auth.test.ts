import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTestDb,
  oauthTokens,
  saveToken,
  sessions,
  TEST_DATABASE_URL,
  users,
} from "@rask/schema";
import { sql } from "drizzle-orm";
import type * as honoModule from "hono";
import { authRoutes, currentUser, hashSession } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";

/**
 * The only thing standing between a request and 200 people's workspace.
 *
 * Everything here is about refusal: an expired cookie, a forged OAuth
 * redirect, a route somebody registered on the wrong Hono instance. None of
 * these fail loudly in production — they fail by letting somebody in — so the
 * tests are written to go red the moment the refusal stops happening.
 */

const KEY = Buffer.alloc(32, 7).toString("base64");

function makeConfig(over: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    TOKEN_ENCRYPTION_KEY: KEY,
    SESSION_SECRET: "session-secret",
    CLICKUP_CLIENT_ID: "test-client-id",
    CLICKUP_CLIENT_SECRET: "test-client-secret",
    CLICKUP_REDIRECT_URI: "http://localhost:3000/auth/clickup/callback",
    SESSION_COOKIE_NAME: "rask_session",
    NODE_ENV: "development",
    ...over,
  } as NodeJS.ProcessEnv);
}

const db = createTestDb();
const config = makeConfig();

const LIVE_USER = "auth-test-user-live";
const TOKENLESS_USER = "auth-test-user-tokenless";
const CALLBACK_USER = "9182736";

/** The raw cookie value; only its SHA-256 is ever stored. */
const LIVE_COOKIE = "auth-test-live-cookie-value";
const EXPIRED_COOKIE = "auth-test-expired-cookie-value";
const TOKENLESS_COOKIE = "auth-test-tokenless-cookie-value";

const TEST_USERS = [LIVE_USER, TOKENLESS_USER, CALLBACK_USER];

async function wipe() {
  await db.delete(sessions).where(sql`user_id in ${TEST_USERS}`);
  await db.delete(oauthTokens).where(sql`user_id in ${TEST_USERS}`);
  await db.delete(users).where(sql`id in ${TEST_USERS}`);
}

beforeAll(async () => {
  await wipe();

  await db.insert(users).values([
    {
      id: LIVE_USER,
      username: "Roberto Spinelli",
      email: "roberto@example.test",
      initials: "RS",
      color: "#7b68ee",
      profilePicture: "https://example.test/rs.png",
      isRaskUser: true,
    },
    { id: TOKENLESS_USER, username: "Tokenless", email: "tokenless@example.test" },
  ]);

  await saveToken(db, {
    userId: LIVE_USER,
    teamId: "9001",
    token: "oauth-token",
    key: config.encryptionKey,
  });

  const hour = 3_600_000;
  await db.insert(sessions).values([
    { id: hashSession(LIVE_COOKIE), userId: LIVE_USER, expiresAt: new Date(Date.now() + hour) },
    // Yesterday. Nothing deletes it: expiry is enforced on read, not by a sweep.
    { id: hashSession(EXPIRED_COOKIE), userId: LIVE_USER, expiresAt: new Date(Date.now() - hour) },
    {
      id: hashSession(TOKENLESS_COOKIE),
      userId: TOKENLESS_USER,
      expiresAt: new Date(Date.now() + hour),
    },
  ]);
});

afterAll(wipe);

describe("currentUser", () => {
  test("resolves a live session to the user and their workspace", async () => {
    const user = await currentUser(db, LIVE_COOKIE);

    expect(user).toEqual({
      id: LIVE_USER,
      username: "Roberto Spinelli",
      email: "roberto@example.test",
      initials: "RS",
      color: "#7b68ee",
      avatar: "https://example.test/rs.png",
      // From oauth_tokens, not from users: which workspace they are in is a
      // property of the token, and every query downstream is scoped by it.
      teamId: "9001",
      // Defaulted by the column, so a user who has never opened the inbox has a
      // window that starts when their row did rather than at the epoch.
      inboxSeenAt: expect.any(Date),
    });
  });

  test("refuses an expired session", async () => {
    // Nothing sweeps the sessions table, so a row that outlived its expiry is
    // the normal state of an old login. If the `expiresAt` predicate goes, a
    // cookie from any point in the app's history logs its holder back in.
    expect(await currentUser(db, EXPIRED_COOKIE)).toBeNull();
  });

  test("refuses a session whose user has no ClickUp token", async () => {
    // The join onto oauth_tokens is not decoration. Without it `teamId` is
    // undefined and a user who revoked Rask in ClickUp keeps a working Rask
    // session, reading and writing a workspace they no longer have access to.
    expect(await currentUser(db, TOKENLESS_COOKIE)).toBeNull();
  });

  test("refuses a cookie nobody issued", async () => {
    expect(await currentUser(db, "not-a-session")).toBeNull();
  });

  test("refuses no cookie at all, without asking the database", async () => {
    // Every unauthenticated request in the app takes this path. A query here
    // would be one round trip per anonymous hit on a public URL.
    expect(await currentUser(db, undefined)).toBeNull();
  });

  test("refuses the stored id used as a cookie, so a leaked table is not a login", async () => {
    // The table holds SHA-256(cookie). If the raw value were ever stored
    // instead, a dump of `sessions` would be 200 usable logins.
    expect(await currentUser(db, hashSession(LIVE_COOKIE))).toBeNull();
  });
});

/**
 * The OAuth callback.
 *
 * `state` is the only thing stopping a third party from walking somebody
 * through a login that ends with *their* ClickUp account attached to the
 * victim's browser. It is compared against a cookie the same browser was
 * given, so a redirect crafted elsewhere has nothing to match.
 */
describe("oauth callback", () => {
  /** Fails every outbound call, so a check that stops refusing shows up here. */
  function noNetwork() {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls++;
      throw new Error(`the callback reached ClickUp at ${String(input)}`);
    }) as unknown as typeof globalThis.fetch;
    return { restore: () => (globalThis.fetch = original), calls: () => calls };
  }

  test("refuses a state that does not match the cookie", async () => {
    const net = noNetwork();
    try {
      const app = authRoutes(db, config);
      const response = await app.request("/clickup/callback?code=abc&state=attacker", {
        headers: { cookie: "rask_oauth_state=ours" },
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("signin=state_mismatch");
      // Refused before the authorization code is spent, not after.
      expect(net.calls()).toBe(0);
    } finally {
      net.restore();
    }
  });

  test("refuses a callback with no state cookie in the browser", async () => {
    // What a link mailed to somebody looks like: a valid-looking state
    // parameter and a browser that was never sent to /auth/clickup.
    const net = noNetwork();
    try {
      const app = authRoutes(db, config);
      const response = await app.request("/clickup/callback?code=abc&state=attacker");

      expect(response.headers.get("location")).toContain("signin=state_mismatch");
      expect(net.calls()).toBe(0);
    } finally {
      net.restore();
    }
  });

  test("refuses a callback with no state parameter", async () => {
    const net = noNetwork();
    try {
      const app = authRoutes(db, config);
      const response = await app.request("/clickup/callback?code=abc", {
        headers: { cookie: "rask_oauth_state=ours" },
      });

      expect(response.headers.get("location")).toContain("signin=state_mismatch");
      expect(net.calls()).toBe(0);
    } finally {
      net.restore();
    }
  });

  test("refuses a callback with no authorization code", async () => {
    const net = noNetwork();
    try {
      const app = authRoutes(db, config);
      const response = await app.request("/clickup/callback?state=ours", {
        headers: { cookie: "rask_oauth_state=ours" },
      });

      expect(response.headers.get("location")).toContain("signin=no_code");
      expect(net.calls()).toBe(0);
    } finally {
      net.restore();
    }
  });

  test("issues a state cookie that JavaScript cannot read", async () => {
    // Readable from script, the state cookie stops being a second channel and
    // the CSRF check it backs becomes decoration.
    const app = authRoutes(db, makeConfig({ NODE_ENV: "production", CLICKUP_TEAM_ID: "9001" }));
    const response = await app.request("/clickup");

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("rask_oauth_state=");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    // The value in the cookie is the one in the redirect, or nothing matches.
    const state = /rask_oauth_state=([^;]+)/.exec(cookie)?.[1] ?? "";
    const location = new URL(response.headers.get("location") ?? "");
    expect(state).toBeTruthy();
    expect(location.searchParams.get("state")).toBe(state);
  });
});

/**
 * The session cookie itself.
 *
 * `httpOnly` is what keeps one XSS in the SPA from being 200 stolen sessions;
 * `secure` is what keeps the cookie off a plaintext hop. Both are one word in
 * an options object and neither has any visible effect if it goes missing.
 */
describe("the session cookie", () => {
  /** ClickUp, canned: token exchange, whoami, workspaces. */
  function stubClickUp() {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes("/oauth/token")
        ? { access_token: "granted-token", token_type: "Bearer" }
        : url.endsWith("/v2/user")
          ? {
              user: {
                id: Number(CALLBACK_USER),
                username: "Callback User",
                email: "callback@example.test",
                initials: "CU",
                color: "#000000",
                profilePicture: null,
              },
            }
          : { teams: [{ id: "9001", name: "Ventura" }] };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  async function completeLogin(nodeEnv: string, over: Record<string, string> = {}) {
    const restore = stubClickUp();
    try {
      const app = authRoutes(
        db,
        makeConfig({ NODE_ENV: nodeEnv, CLICKUP_TEAM_ID: "9001", ...over }),
      );
      return await app.request("/clickup/callback?code=abc&state=ours", {
        headers: { cookie: "rask_oauth_state=ours" },
      });
    } finally {
      restore();
    }
  }

  /**
   * Who is allowed in at all.
   *
   * Reads come from the mirror, so a session is enough to see every task in it
   * — ClickUp's own per-Space permissions are never consulted on the read path.
   * The Workspace check is therefore the entire access control on a deployment
   * anyone can reach, and it used to be `teams[0]`: whatever workspace the
   * account signing in happened to have.
   */
  test("refuses an account that is not in this deployment's workspace", async () => {
    const response = await completeLogin("production", { CLICKUP_TEAM_ID: "someone-else" });

    expect(response.headers.get("location")).toContain("signin=not_a_member");
    expect(response.headers.getSetCookie().some((c) => c.startsWith("rask_session="))).toBe(false);
  });

  test("refuses an account off the allow list, even inside the workspace", async () => {
    const response = await completeLogin("production", {
      RASK_ALLOWED_EMAILS: "someone@example.test",
    });

    expect(response.headers.get("location")).toContain("signin=not_allowed");
    expect(response.headers.getSetCookie().some((c) => c.startsWith("rask_session="))).toBe(false);
  });

  test("admits an account on the allow list, matched case-insensitively", async () => {
    const response = await completeLogin("production", {
      RASK_ALLOWED_EMAILS: " other@example.test , CALLBACK@Example.TEST ",
    });

    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie().some((c) => c.startsWith("rask_session="))).toBe(true);
  });

  test("an empty allow list is not an allow list of nobody", async () => {
    // `RASK_ALLOWED_EMAILS=` in a .env file is how "unset" is spelled. Reading
    // it as a list containing nothing locks every user out of a live
    // deployment, with the deploy that did it looking like a no-op.
    const response = await completeLogin("production", { RASK_ALLOWED_EMAILS: "" });

    expect(response.status).toBe(302);
  });

  test("sends the browser to the web origin, not to a path on the API", async () => {
    // The API serves the SPA in production, so "/" happened to work there and
    // 404'd in development, where the browser is on another port.
    const response = await completeLogin("development", { WEB_ORIGIN: "http://localhost:5173" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173");
  });

  test("is httpOnly and secure in production", async () => {
    const response = await completeLogin("production");
    const cookie =
      response.headers.getSetCookie().find((value) => value.startsWith("rask_session=")) ?? "";

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain("Path=/");
  });

  test("is httpOnly on a plain-http dev origin too, where Secure would break it", async () => {
    // `secure` is conditional because a Secure cookie is dropped over http and
    // nobody could log in locally. `httpOnly` is not conditional on anything.
    const response = await completeLogin("development");
    const cookie =
      response.headers.getSetCookie().find((value) => value.startsWith("rask_session=")) ?? "";

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/Secure/i);
  });

  test("carries a value that is not what the database stores", async () => {
    // Each login above left a row behind, and every one of them is valid.
    await db.delete(sessions).where(sql`user_id = ${CALLBACK_USER}`);
    const response = await completeLogin("production");
    const raw = /rask_session=([^;]+)/.exec(
      response.headers.getSetCookie().find((v) => v.startsWith("rask_session=")) ?? "",
    )?.[1];

    expect(raw).toBeTruthy();
    const [row] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(sql`user_id = ${CALLBACK_USER}`)
      .limit(1);

    expect(row?.id).not.toBe(raw);
    expect(row?.id).toBe(hashSession(raw ?? ""));
    // And the cookie it handed out actually works.
    expect((await currentUser(db, raw))?.id).toBe(CALLBACK_USER);
  });
});

/**
 * Every route the process answers, checked against one allow-list.
 *
 * `requireAuth` is mounted on the `api` sub-app. A handler registered on `app`
 * by mistake — one character, `app.get` instead of `api.get` — is served with
 * no session check at all and looks completely normal in review, in the diff
 * and in the browser. Nothing else in this repo would notice.
 *
 * So rather than testing the routes we remember, this walks Hono's own route
 * table and demands a 401 from every entry that is not named below. Adding a
 * public route means editing this list, in a file called auth.
 */
describe("the route table", () => {
  /**
   * Routes that answer without a session, and why each one is allowed to.
   *
   * `/webhooks/clickup` is the real one: ClickUp carries no cookie, so it
   * authenticates by HMAC over the body instead (see webhooks.ts). The rest
   * are the login flow itself and a liveness probe that returns a constant.
   */
  const PUBLIC = new Set([
    "GET /health",
    "GET /auth/clickup",
    "GET /auth/clickup/callback",
    "POST /auth/logout",
    "POST /webhooks/clickup",
  ]);

  let root: honoModule.Hono;

  beforeAll(async () => {
    // Never the developer's own database: importing index.ts builds a pool
    // from the environment, and `.env` names the mirror of a real workspace.
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    process.env.SESSION_SECRET = "session-secret";
    process.env.CLICKUP_CLIENT_ID = "test-client-id";
    process.env.CLICKUP_CLIENT_SECRET = "test-client-secret";
    process.env.CLICKUP_REDIRECT_URI = "http://localhost:3000/auth/clickup/callback";
    process.env.SESSION_COOKIE_NAME = "rask_session";
    // The SPA fallback would answer every unmatched path with the shell.
    delete process.env.WEB_DIST;

    /*
     * The routes as Hono holds them, not as anyone remembers writing them.
     *
     * Imported dynamically because the environment above has to be set before
     * index.ts builds its pool and reads its config.
     */
    root = (await import("../src/index.ts")).app as unknown as honoModule.Hono;
  });

  /** `/api/tasks/:id` is not a URL. Give every parameter something to be. */
  function concrete(path: string): string {
    return path.replace(/:[A-Za-z0-9_]+/g, "probe");
  }

  function endpoints() {
    return (
      root.routes
        // METHOD_NAME_ALL entries are `use()` middleware, not routes anyone calls.
        .filter((route) => route.method !== "ALL" && !route.path.includes("*"))
        .map((route) => ({ method: route.method, path: route.path }))
    );
  }

  test("has routes to check, so a silent zero cannot pass this file", () => {
    expect(endpoints().length).toBeGreaterThan(20);
  });

  test("mounts requireAuth across the whole api group", () => {
    // The `api.use("*", requireAuth)` line, as Hono recorded it.
    expect(root.routes.some((r) => r.method === "ALL" && r.path === "/api/*")).toBe(true);
  });

  test("every public route in the allow-list still exists", () => {
    // Otherwise the list rots into permission for routes nobody can name.
    const registered = new Set(endpoints().map((e) => `${e.method} ${e.path}`));
    for (const name of PUBLIC) expect(registered).toContain(name);
  });

  test("refuses every route that is not on the allow-list", async () => {
    const leaked: string[] = [];

    for (const { method, path } of endpoints()) {
      if (PUBLIC.has(`${method} ${path}`)) continue;
      const response = await root.request(concrete(path), { method });
      if (response.status !== 401) leaked.push(`${method} ${path} -> ${response.status}`);
    }

    // A non-empty list here is a route serving workspace data to anyone who
    // knows the URL. The names are in the failure so it says which.
    expect(leaked).toEqual([]);
  });

  test("says unauthenticated rather than leaking why", async () => {
    const response = await root.request("/api/me");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  test("lets a live session through the same middleware", async () => {
    // Without this the test above would also pass if requireAuth rejected
    // everything unconditionally.
    const response = await root.request("/api/me", {
      headers: { cookie: `rask_session=${LIVE_COOKIE}` },
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string }).toMatchObject({ id: LIVE_USER });
  });
});
