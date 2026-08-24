# Security model

What Rask protects, how, and — more usefully — what it does not.

## Who can sign in

**Reads come from the mirror, not from ClickUp.** A session is enough to read
every task Rask has mirrored; ClickUp's own per-Space permissions are never
consulted on the read path. So the sign-in gate is the entire access control,
and on a box the internet can reach it is the only thing between a stranger's
ClickUp account and your company's tasks.

Two gates, in order:

1. **`CLICKUP_TEAM_ID`** — only members of that one ClickUp Workspace may sign
   in. Checked against the Workspaces the OAuth token can actually see, at the
   moment of sign-in. `loadConfig` refuses to start in production without it,
   because there is no safe default: guessing the Workspace from whoever signs
   in first is exactly the bug.
2. **`RASK_ALLOWED_EMAILS`** — optional, a comma-separated list matched
   case-insensitively against the ClickUp account's email. Blank means every
   member of the Workspace, which is usually what a team wants. Use it for a
   pilot, or where the Workspace has guests who should not be here.

Both are enforced in the OAuth callback, before any session is issued.

### What this does not give you

**No per-Space isolation.** Anyone who can sign in sees the whole mirror,
including Spaces ClickUp would have hidden from them. That is fine for a team
that already shares everything, and it is not a substitute for ClickUp's
permissions if some members must not read some Spaces. Fixing it properly means
mirroring ClickUp's ACLs and filtering every read by them, which is not built.

**No roles.** Every signed-in user can do everything the UI offers. Writes go
out under that user's own ClickUp token, so ClickUp still refuses what that
user could not have done in ClickUp — a write is rejected upstream, the mirror
is repaired, and the user is told. The read path has no such backstop.

## Tokens and sessions

- **ClickUp tokens** are encrypted at rest with AES-256-GCM under
  `TOKEN_ENCRYPTION_KEY`, one row per user. Never a shared token: ClickUp's rate
  limit is per token, and a shared one would also lie about who made each
  change. Rotating the key orphans every stored token and everyone signs in
  again.
- **Sessions** are 32 random bytes. The cookie carries the raw value; the
  database stores only its SHA-256, so a database dump does not contain
  anything that can be replayed as a session. They expire after 30 days and are
  revocable by deleting the row.
- **The cookie** is `httpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in
  production. `Secure` is why a deployment on plain http looks like a sign-in
  that silently never completes.
- **The OAuth `state`** is a cookie compared in constant time, and a mismatch
  is refused before the authorization code is ever exchanged.

## The webhook endpoint

`POST /webhooks/clickup` is the one route outside `requireAuth`, because
ClickUp does not carry a session. It authenticates by signature instead:

- HMAC-SHA256 over the **raw** request body, hex, compared with
  `timingSafeEqual` against every secret registered for this deployment, with
  no early exit.
- Re-serializing the parsed JSON would change key order and whitespace and
  reject every genuine delivery, so the raw bytes are what gets signed.
- Header shape and `Content-Length` are checked first, the body is read through
  a 64 KiB cap, and nothing after verification does more than one insert.
- Refusals are `400`/`403`, never `401` or `410`: ClickUp suspends a webhook
  outright on those two, where anything else only counts toward its failure
  budget.

Secrets come from the `webhooks` table, encrypted with the same key as the
ClickUp tokens. `CLICKUP_WEBHOOK_SECRET` is only for a webhook created outside
Rask, and is checked *alongside* the stored ones, never instead of them.

A test walks Hono's route table and demands 401 from every route outside a
five-name allow-list, so a route registered on the wrong router cannot be
silently public.

## Secrets

Everything through the environment, documented in
[`.env.example`](../.env.example). Nothing is hardcoded, and `.env` is not
committed. `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET` are 32 random bytes each
and must differ between deployments.

## Reporting something

Open a GitHub issue for anything that is not itself exploitable. For something
that is, mail the address on the repository owner's GitHub profile rather than
filing publicly.
