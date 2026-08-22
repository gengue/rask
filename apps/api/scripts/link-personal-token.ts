/**
 * Points a local Rask at your real ClickUp workspace without the OAuth round
 * trip.
 *
 *   bun run --cwd apps/api link
 *
 * Takes CLICKUP_PERSONAL_TOKEN, looks up who it belongs to, stores it the same
 * way an OAuth token would be stored (AES-256-GCM, same key), and writes a
 * session for that user so /__dev-login signs you in as yourself.
 *
 * Development only, and deliberately a script rather than a route: there is no
 * code path in the server that can be talked into doing this.
 */

import { createHash, randomBytes } from "node:crypto";
import { ClickUpClient } from "@rask/clickup-client";
import { createDb, loadKey, saveToken, sessions, users } from "@rask/schema";

const token = process.env.CLICKUP_PERSONAL_TOKEN;
if (!token) {
  console.error("CLICKUP_PERSONAL_TOKEN is not set. ClickUp > Settings > Apps > API Token.");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL ?? "postgres://rask:rask@localhost:5432/rask");
const client = new ClickUpClient({ token, auth: "personal" });

const [me, teams] = await Promise.all([client.getAuthorizedUser(), client.getAuthorizedTeams()]);
const teamId = process.env.CLICKUP_TEAM_ID ?? teams[0]?.id;
if (!teamId) throw new Error("this token has no workspace");

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
    set: { username: me.username ?? null, email: me.email ?? null, isRaskUser: true },
  });

await saveToken(db, { userId, teamId, token, key: loadKey(process.env.TOKEN_ENCRYPTION_KEY) });

const raw = randomBytes(32).toString("base64url");
await db.insert(sessions).values({
  id: createHash("sha256").update(raw).digest("hex"),
  userId,
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
});
await Bun.write(new URL("../../web/.dev-session", import.meta.url), raw);

console.log(`linked ${me.username ?? userId} (${me.email ?? "no email"}) to workspace ${teamId}`);
console.log("sign in: http://localhost:5173/__dev-login");
process.exit(0);
