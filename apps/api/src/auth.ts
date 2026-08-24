import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ClickUpClient } from "@rask/clickup-client";
import { type Db, oauthTokens, saveToken, sessions, users } from "@rask/schema";
import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "./config.ts";

/**
 * ClickUp OAuth, one token per user.
 *
 * The browser gets an opaque random cookie; the database stores only its
 * SHA-256. A leaked `sessions` table therefore cannot be replayed as a login.
 * The ClickUp token itself never leaves the server.
 */

const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  username: string | null;
  email: string | null;
  initials: string | null;
  color: string | null;
  avatar: string | null;
  teamId: string;
}

export function hashSession(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function authRoutes(db: Db, config: Config) {
  const app = new Hono();
  const cookieName = config.SESSION_COOKIE_NAME;

  /**
   * Kicks off the OAuth dance. `state` is a random value echoed back by
   * ClickUp and compared against a short-lived cookie, which is what stops a
   * third party from feeding us their own authorization code.
   */
  app.get("/clickup", (c) => {
    const state = randomBytes(16).toString("base64url");
    setCookie(c, "rask_oauth_state", state, {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.isProduction,
      path: "/",
      maxAge: 600,
    });

    const url = new URL("https://app.clickup.com/api");
    url.searchParams.set("client_id", config.CLICKUP_CLIENT_ID);
    url.searchParams.set("redirect_uri", config.CLICKUP_REDIRECT_URI);
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  app.get("/clickup/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const expected = getCookie(c, "rask_oauth_state");
    deleteCookie(c, "rask_oauth_state", { path: "/" });

    if (!code) return c.text("ClickUp did not return an authorization code", 400);
    if (!state || !expected || !safeEqual(state, expected)) {
      return c.text("OAuth state mismatch", 400);
    }

    const token = await ClickUpClient.exchangeCode({
      clientId: config.CLICKUP_CLIENT_ID,
      clientSecret: config.CLICKUP_CLIENT_SECRET,
      code,
    });

    const client = new ClickUpClient({ token, auth: "oauth" });
    const [me, teams] = await Promise.all([
      client.getAuthorizedUser(),
      client.getAuthorizedTeams(),
    ]);
    /*
     * Membership of the configured Workspace is the whole access check.
     *
     * Reads come from the mirror, not from ClickUp, so a session is enough to
     * see every task in it — ClickUp's per-Space permissions are never
     * consulted on the read path. Taking `teams[0]` meant any ClickUp account
     * anywhere could finish this flow and read the company's tasks.
     *
     * Unset only in development, where the Workspace is whatever the
     * developer's own token can see; `loadConfig` will not start in production
     * without it.
     */
    const teamId = config.CLICKUP_TEAM_ID ?? teams[0]?.id;
    if (!teamId) return c.text("This ClickUp account has no workspace", 400);
    if (config.CLICKUP_TEAM_ID && !teams.some((team) => team.id === config.CLICKUP_TEAM_ID)) {
      return c.text("This ClickUp account is not a member of this workspace", 403);
    }

    const email = me.email?.trim().toLowerCase();
    if (config.RASK_ALLOWED_EMAILS && (!email || !config.RASK_ALLOWED_EMAILS.includes(email))) {
      return c.text("This account is not on the allow list for this deployment", 403);
    }

    const userId = String(me.id);
    await db
      .insert(users)
      .values({
        id: userId,
        username: me.username ?? null,
        email: me.email ?? null,
        color: me.color ?? null,
        initials: me.initials ?? null,
        profilePicture: me.profilePicture ?? null,
        isRaskUser: true,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          username: me.username ?? null,
          email: me.email ?? null,
          color: me.color ?? null,
          initials: me.initials ?? null,
          profilePicture: me.profilePicture ?? null,
          isRaskUser: true,
          syncedAt: new Date(),
        },
      });

    await saveToken(db, { userId, teamId, token, key: config.encryptionKey });

    const raw = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await db.insert(sessions).values({ id: hashSession(raw), userId, expiresAt });

    setCookie(c, cookieName, raw, {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.isProduction,
      path: "/",
      maxAge: SESSION_DAYS * 86_400,
    });

    /*
     * Absolute, not "/".
     *
     * In production the API serves the SPA and the two are one origin, so "/"
     * happened to work. In development the API is on :3000 with no SPA behind
     * it, and signing in landed on a 404 — the browser is on :5173.
     */
    return c.redirect(config.WEB_ORIGIN);
  });

  app.post("/logout", async (c) => {
    const raw = getCookie(c, cookieName);
    if (raw) await db.delete(sessions).where(eq(sessions.id, hashSession(raw)));
    deleteCookie(c, cookieName, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}

/** Resolves the session cookie to a user, or null. */
export async function currentUser(
  db: Db,
  cookieValue: string | undefined,
): Promise<SessionUser | null> {
  if (!cookieValue) return null;

  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      initials: users.initials,
      color: users.color,
      avatar: users.profilePicture,
      teamId: oauthTokens.teamId,
      sessionId: sessions.id,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(oauthTokens, eq(oauthTokens.userId, sessions.userId))
    .where(and(eq(sessions.id, hashSession(cookieValue)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row) return null;

  // Fire-and-forget: last_seen is for cleanup, not for correctness.
  void db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch(() => {});

  const { sessionId: _sessionId, ...user } = row;
  return user;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
