# Deployment

One image, three services: the API (which also serves the SPA), the worker, and
a one-shot migrator both depend on. Migrations run as their own service rather
than at API boot, because a rolling deploy would race them.

Every variable named here is documented in place in
[`.env.example`](../.env.example), which is the reference. This file is the
decisions.

## Before you start

Read [Who can sign in](security.md#who-can-sign-in) first. Rask serves reads
from its own Postgres mirror, so a session is enough to read every task in it,
and the sign-in gate is the entire access control. On a box the internet can
reach, that gate is the only thing between a stranger's ClickUp account and
your company's tasks.

## On a VPS

Any box with Docker. 2 GB of RAM is comfortable for the ~150,000-task workspace
this was built against; Postgres wants disk more than CPU.

```bash
git clone git@github.com:gengue/rask.git && cd rask
cp .env.example .env       # fill it in, see below
docker compose -f docker-compose.prod.yml up -d --build
```

The compose file does **not** include Postgres. Point `DATABASE_URL` at a
managed instance or at a container you run yourself, and back it up like any
other database — the mirror is rebuildable from ClickUp, but a full resync of a
large workspace is hours.

Nothing in Rask should be reachable from the internet except the API, and the
API expects to sit behind a reverse proxy that terminates TLS: Caddy, nginx, or
Coolify's built-in one. The session cookie is `Secure` in production and will
not survive plain http, so a deployment on `http://` looks like a sign-in that
silently never completes.

### The variables that matter

| | |
|---|---|
| `DATABASE_URL` | Postgres. |
| `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET` | `openssl rand -base64 32`, one each. Rotating the first orphans every stored ClickUp token and everyone signs in again. |
| `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET` | From the ClickUp OAuth app at **Settings → Apps**. |
| `CLICKUP_REDIRECT_URI` | `https://your.domain/auth/clickup/callback`, matching the OAuth app **character for character**. A mismatch fails the callback with no useful error. |
| `WEB_ORIGIN` | `https://your.domain`. Where the browser lands after signing in. |
| `CLICKUP_TEAM_ID` | The one Workspace this deployment serves. The API refuses to start without it. |
| `NODE_ENV` | `production`. The image sets it; only needed if you run outside the image. |

### The first sync

The worker discovers the hierarchy on boot and starts polling. A full load of a
large workspace runs at roughly five minutes per 17,000 tasks — see
[architecture.md](architecture.md#measured-against-the-real-workspace) — so the
first fill is hours, not minutes, and it is bounded by ClickUp's 100 req/min
per token rather than by anything here. The app is usable throughout; lists
fill in as they are reached.

### Webhooks

Optional, and off unless you set a URL. See [webhooks.md](webhooks.md) for what
they buy and why polling never stops.

Set `CLICKUP_WEBHOOK_URL` on the worker to the API's public `/webhooks/clickup`
URL — full path, https, reachable from the internet. Nothing else is needed:
the worker registers the webhook on its next boot, stores the secret encrypted
in the `webhooks` table, and the API reads it from there.

Leave it blank and nothing changes: no webhook, no events, and polling runs at
`POLL_INTERVAL_MS`. That is also what development looks like, since ClickUp
cannot reach localhost — and a URL that stops answering earns delivery failures
against the real Workspace, 100 of which suspend the webhook.

`CLICKUP_WEBHOOK_LIST_ID` narrows a first rollout to one List.

## On Coolify

Point the app at `docker-compose.prod.yml` and set the same variables in its
UI. Coolify terminates TLS for you, so `WEB_ORIGIN` and `CLICKUP_REDIRECT_URI`
are the https domain it gives you.

## The landing page

`apps/site` is the page at the apex domain, and it is a **second Coolify
application**, not a service in the compose file above. Same repository:

| | |
|---|---|
| Build pack | Dockerfile |
| Dockerfile location | `apps/site/Dockerfile` |
| Base directory | `/` |
| Domain | the apex, e.g. `getrask.com` |
| Environment | none |

The base directory is the repository root and not `apps/site`, because bun
workspaces resolve from the root lockfile and an install rooted at `apps/site`
finds nothing.

Separate because it shares nothing with the client — no database, no secrets,
no migration step. Coupling it to a stack whose deploy waits on `migrate` would
mean a copy edit on the landing page waits on Postgres. It also means the page
stays up while the client is being redeployed, which is the one moment somebody
might go looking for it.

The client itself goes on a subdomain (`app.` + the apex), and that subdomain is
what `WEB_ORIGIN` and `CLICKUP_REDIRECT_URI` have to name — the OAuth app at
ClickUp's end matches the redirect character for character, so pointing either
at the apex is a callback that fails with nothing useful in the log.

## Upgrading

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

`migrate` runs to completion before the API and worker start, so neither can
come up against a schema it does not understand. Migrations are forward-only;
there are no down migrations, and rolling back a deploy that migrated means
restoring the database.

## Scaling

Still one worker replica. Both queues are safe to drain from several — they use
`FOR UPDATE SKIP LOCKED` — but webhook registration is not idempotent across
processes: two workers starting together would each find no webhook and create
one.

The API is stateless apart from the session cookie and can be replicated
freely.

## When something is wrong

- **Sign-in redirects and nothing happens.** `WEB_ORIGIN` or
  `CLICKUP_REDIRECT_URI` disagrees with reality, or you are on plain http and
  the `Secure` cookie is being dropped.
- **"This ClickUp account is not a member of this workspace".** Working as
  intended. `CLICKUP_TEAM_ID` names one Workspace; that account is not in it.
- **The API will not start, complaining about `CLICKUP_TEAM_ID`.** Also
  working as intended. There is no safe default for it.
- **Tasks are stale.** Check the worker's logs for rate limiting, and
  `select status, count(*) from outbox group by status` for writes that never
  landed. `failed` rows have already been reverted in the mirror and the user
  told.
- **A list is wrong and polling will not fix it.** Per-list resync exists for
  exactly this, and the nightly reconciliation is the backstop.
