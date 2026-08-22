# Rask

A fast, keyboard-first web client for ClickUp. Unofficial.

Rask is a minimal alternative UI for ClickUp built for people who live in the task
list all day and find the official client slow. It mirrors ClickUp into our own
Postgres, serves reads from there, and pushes writes back through an outbox. The
browser never talks to ClickUp directly.

MIT licensed. Not affiliated with ClickUp.

## Architecture

```
Browser (SPA) <-- SSE --> API <-- REST + webhooks --> ClickUp
     |                     |
  OPFS cache          Postgres
  (wa-sqlite)      (ClickUp mirror)
```

### Principles

- **The browser never calls ClickUp.** CORS and per-token rate limits make that a
  non-starter. It only talks to our API.
- **Postgres is a mirror, not the source of truth.** ClickUp always wins. Every
  table carries enough ClickUp metadata to be rebuilt from scratch.
- **One OAuth token per user, never a shared one.** ClickUp's Business plan allows
  100 requests/min per token. A shared token would burn that in seconds and would
  also lie about who made each change. Respect the `X-RateLimit-*` headers.
- **Writes are optimistic, then reconciled.** The client applies the change
  immediately, the API writes it to Postgres and enqueues it in an outbox, and a
  worker ships it to ClickUp with exponential backoff. If ClickUp rejects it, we
  revert and tell the user.
- **Assume webhooks get lost.** ClickUp webhooks carry only a `task_id` (so every
  event costs one `GET /task/{id}`), have no replay, and silently disappear.
  Backup polling with `date_updated_gt` runs every 5 minutes per active list.
- **Resync is a first-class feature.** A per-list resync command and a nightly
  reconciliation job exist from day one, not as a later fix.

## Stack

| Workspace | What |
|---|---|
| `apps/web` | SolidJS, Vite, TanStack Router, TanStack DB, Tailwind v4, CodeMirror 6 for markdown. |
| `apps/api` | Bun + Hono, Drizzle over Bun's native Postgres client, Zod at the edges, per-user SSE fan-out. ClickUp OAuth, tokens encrypted at rest, session in an httpOnly cookie. In production it also serves the built SPA, so the whole app is one origin. |
| `apps/worker` | Ingest (polling, reconciliation) and the outbox drain. |
| `packages/schema` | The mirror: Drizzle tables, token encryption, and the mapping from ClickUp payloads to rows. |
| `packages/clickup-client` | Typed client for the ten ClickUp endpoints Rask uses, with a token-bucket rate limiter per token. The v2 OpenAPI spec is vendored under `openapi/` so endpoint and parameter names get checked rather than guessed. |

Tooling: Biome, `bun test`, Playwright for the critical flow, Docker Compose for
local Postgres.

Run the suite with `bun run test`, not a bare `bun test`: the latter globs the
Playwright specs, which need running servers. Some tests talk to the local
Postgres on purpose — a jsonb column that round-trips through the ORM while
being stored wrong is not catchable any other way.

Those tests write to `rask_test`, never to `rask`. Run `bun run db:test` once to
create it. The default is deliberate: the tests insert and delete real rows, and
pointing them at the database you are actually looking at is a mistake worth
making impossible rather than remembering not to make.

### Things the original plan called for that are not here

Each of these was dropped for a reason, and each has a way back in.

- **pnpm and Turborepo.** The API and worker already require Bun, so pnpm would
  be a second package manager for no gain. Internal packages export TypeScript
  source with no build step, which leaves no build graph for Turborepo to order.
  `bun run --filter '*' <script>` covers the rest. Turborepo goes in the day CI
  typecheck time hurts.
- **pg-boss.** The `outbox` table is the queue; the worker claims rows with
  `FOR UPDATE SKIP LOCKED`. pg-boss would put a second queue on top of a queue.
  Add it if cron, priorities, or fan-out are ever needed.
- **TanStack Virtual.** Its Solid adapter resolves the scroll element while the
  component body runs, before any ref exists, and on the path where the detail
  panel mounts first it binds to a 0x0 rect and never re-measures. Rows are
  fixed height, so the list is windowed by hand in thirty lines. A virtualizer
  earns its place back when rows need measuring rather than assuming.
- **Webhook ingestion.** Polling covers it, and the endpoint needs a public URL
  that does not exist in dev. `createWebhook` and the payload schema are in
  place; what is missing is the receiving route and signature check.
- **wa-sqlite over OPFS with FTS5.** The in-memory collection is enough for the
  MVP. This buys offline and instant cross-list search, and it is a real piece
  of work, not a flag.
- **OpenTelemetry.** Not wired. Half-instrumenting is worse than not starting.

## Measured against the real workspace

Numbers from the Ventura workspace (`bun run --cwd apps/worker measure`), not
estimates. 6 spaces, 36 folders, **243 lists**, 200 members.

| | requests | time |
|---|---|---|
| Space/folder/list tree | 13 | 1.4s |
| Full load of the 8 biggest IT lists (17,049 tasks) | 196 | 4.7min |
| Incremental poll of those same 8 lists, nothing changed | 8 | 7.5s |

Two things follow.

Steady state is cheap: one request per tracked list per cycle, and a quiet list
costs exactly one. Rask only polls lists somebody has opened, and round-robins
across every signed-in token, so the 100 req/min ceiling is not the binding
constraint. Polling all 243 lists on one token would take 2.4 minutes per pass,
which is why "lists someone has looked at" is the unit rather than "all lists".

The first load is what costs. 4.7 minutes for eight lists, and the wall is
ClickUp's own latency — roughly 1.8s per page of 100 tasks — not our rate
limiter, which never had to throttle. A full initial load of the workspace is
an overnight job, not something to do while a user waits.

One list in that workspace holds 5,696 tasks. Views cap at 500 rows and say so
(`553+` in the header) rather than truncating quietly.

## Deployment

One image, three commands: the API (which also serves the SPA), the worker, and
a one-shot migrator that both depend on. Migrations run as their own service
rather than at API boot, because a rolling deploy would race them.

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

On Coolify, point the app at `docker-compose.prod.yml` and set the variables
from `.env.example`. `CLICKUP_REDIRECT_URI` has to match the redirect URL
registered on the ClickUp OAuth app exactly, or the callback fails with no
useful error.

## Themes

Dark by default, light available, and it follows the OS unless you say
otherwise. The choice lives in `localStorage["rask.theme"]`; "system" is stored
as the absence of that key, so a fresh profile follows `prefers-color-scheme`
with nothing written. An inline script in `index.html` applies the class before
the stylesheet loads, because a theme read after first paint is a white flash
on a dark screen.

Every text colour clears WCAG AA in both themes — 4.5:1 for body text, 3:1 for
glyphs — measured rather than eyeballed. `apps/web/src/lib/contrast.ts` computes
the ratios; run it before changing a colour token.

## Conventions

- TypeScript strict everywhere. No `any`.
- Code and docs in English.
- Conventional Commits.
- Secrets only via `.env`, documented in `.env.example`. Never hardcoded.
- Never invent a ClickUp endpoint. Check the OpenAPI spec vendored in
  `packages/clickup-client`.
