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
- **Assume webhooks get lost.** ClickUp webhooks name a task and describe only
  the field that changed, so every event costs one `GET /task/{id}` to learn the
  rest. They have no replay and silently disappear. Backup polling with
  `date_updated_gt` never stops: every 2 minutes per active list when nothing is
  delivering, every 10 when a webhook is.
- **Resync is a first-class feature.** A per-list resync command and a nightly
  reconciliation job exist from day one, not as a later fix.

## Stack

| Workspace | What |
|---|---|
| `apps/web` | SolidJS, Vite, TanStack Router, TanStack DB, Tailwind v4, CodeMirror 6 for markdown. |
| `apps/api` | Bun + Hono, Drizzle over Bun's native Postgres client, Zod at the edges, per-user SSE fan-out. ClickUp OAuth, tokens encrypted at rest, session in an httpOnly cookie. In production it also serves the built SPA, so the whole app is one origin. |
| `apps/worker` | Ingest (polling, webhook read-backs, reconciliation), webhook registration and health, and the outbox drain. |
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

## Webhooks

Polling alone means up to two minutes of staleness on somebody else's change,
which is the thing a change feed exists to remove. So ClickUp's webhooks feed
the mirror too — without polling going away, because they are not reliable
enough to be the only path.

An event names a task, so ingestion is always the same move: read the task back
from ClickUp and upsert it. That is what makes the delivery guarantees stop
mattering. Duplicates collapse, order is irrelevant (the fetch returns what
ClickUp holds now, not what the event described), and the upserts in
`packages/schema/src/ingest.ts` are idempotent by design.

Events do carry a `history_items` diff with `before` and `after` — more than
the docs' summary suggests — and Rask deliberately ignores it. The diff only
covers the fields that event touched, so applying it to a task the mirror has
never seen would store a status and nothing else. Re-reading is one request,
one code path, and correct for every event type. Real fixtures are in
`packages/clickup-client/test/fixtures/webhook-task-*.json`.

Creating one task produces three deliveries — `taskCreated`,
`taskStatusUpdated`, `taskUpdated`, within 300ms — which the queue collapses
into one row and one `GET /task/{id}`.

```
ClickUp --POST /webhooks/clickup--> API --INSERT--> webhook_events --> worker --GET /task/{id}--> mirror --SSE--> browser
```

**The signature is the only authentication this route has.** It is the one
route in the app with no session, so `X-Signature` is what stands between the
public internet and a write into the mirror. It is a hex HMAC-SHA256 over the
*raw* request body, keyed by the secret ClickUp returns at creation
([docs](https://developer.clickup.com/docs/webhooksignature)) — raw because the
digest covers the bytes ClickUp sent, so verifying against a re-serialized copy
means betting that our JSON writer agrees with theirs. The route reads text
first, verifies with `timingSafeEqual` against every registered secret, and
only then parses. Before that: a 64-KiB cap enforced on the stream, not on
`Content-Length`, and a header shape check that costs nothing.

This was checked against ClickUp, not just against the docs: four real
deliveries to a temporary list-scoped webhook each carried an `X-Signature`
byte-identical to what we compute. `Content-Length` was present and accurate on
all four.

Refusals answer 400 or 403, never 401 or 410. ClickUp suspends a webhook
immediately on either of those two
([docs](https://developer.clickup.com/docs/webhookhealth)) where anything else
only counts towards a hundred, so returning the semantically obvious code would
turn one stale minute into an outage a human has to notice.

**Registration is the worker's job**, on boot and every five minutes after. It
stores the secret encrypted beside the OAuth tokens, and records which user's
token created it: `GET /team/{id}/webhook` only lists webhooks created by the
calling token, so asking with anyone else's answers "there is no webhook" and
registers a second one. A webhook ClickUp has suspended is reactivated with
`PUT /webhook/{id}`; one ClickUp has dropped is registered again.

**Nothing is repaired after an outage, deliberately.** Events dropped while a
webhook was suspended are exactly what incremental polling picks up on its next
pass, because polling never depended on the webhook.

**Which is why polling stays, at 10 minutes instead of 2.** Not off: webhooks
have no replay, cover only the events subscribed to, and go quiet without
saying so. Not unchanged either — a backstop should not cost the same as the
mechanism. The number comes from what each interval is actually insuring
against. At 2 minutes, polling is the only way anyone hears about a change, so
it sets the staleness everybody feels. At 10, a change reaches the browser in a
second or two through the event, and the poll only matters for events ClickUp
never delivered at all — which takes our endpoint being unreachable through all
five of ClickUp's delivery attempts, during which polling was the only thing
running anyway. So the cost of the change is ten minutes of staleness on an
event that was already lost, and the saving is 5x fewer requests against a
quota the whole app shares. If a webhook stops delivering, the worker notices
within five minutes and puts the interval back to 2 on its own.

The nightly reconciliation is unchanged and is still the backstop's backstop.

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

To turn webhooks on, set `CLICKUP_WEBHOOK_URL` on the worker to the API's
public `/webhooks/clickup` URL — the full path, https, reachable from the
internet. Nothing else is needed: the worker registers the webhook on its next
boot, stores the secret encrypted in `webhooks`, and the API reads it from
there. `CLICKUP_WEBHOOK_SECRET` on the API is only for a webhook created
outside Rask. `CLICKUP_WEBHOOK_LIST_ID` narrows a first rollout to one List.

Leave `CLICKUP_WEBHOOK_URL` blank and nothing changes: no webhook is
registered, no events arrive, and polling runs at `POLL_INTERVAL_MS` exactly as
it did before. That is also what dev looks like, since ClickUp cannot reach
localhost.

Still one worker replica. The queues are safe to drain from several — both use
`FOR UPDATE SKIP LOCKED` — but registration is not idempotent across processes:
two workers starting together would each find no webhook and create one.

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
