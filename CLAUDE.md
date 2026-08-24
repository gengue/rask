# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Rask is an unofficial keyboard-first web client for ClickUp. It mirrors a ClickUp
workspace into Postgres, serves every read from that mirror, and pushes writes
back through an outbox. The browser never calls ClickUp.

`docs/architecture.md` has the reasoning and the numbers; `CONTRIBUTING.md` has
the full local setup. This file is the working subset plus the invariants that
only show up when you read several files at once.

## Commands

Bun 1.3+, not Node: internal packages export TypeScript source with no build
step, and the API and worker use Bun's native Postgres client.

```bash
bun install
bun run db:up          # Postgres on :5432 (Docker)
bun run db:migrate
bun run dev            # API :3000, Vite :5173, worker. Use :5173 — it proxies /api and /auth
```

```bash
bun run check          # Biome lint + format
bun run check:fix
bun run typecheck      # tsc over all five packages
bun run db:test        # (re)create the four rask_test_* databases — after any schema change
bun run test           # every package's suite
bun run e2e            # Playwright; starts its own API, Vite and database
bun run --cwd apps/web contrast   # WCAG audit of the colour tokens
```

One file, or one test:

```bash
bun run --cwd apps/api test test/filters.test.ts
bun run --cwd apps/api test test/filters.test.ts -t "rejects an unknown field"
```

Go through each package's `test` script (`bun run --cwd <pkg> test ...`), never a
bare `bun test`. The script is what sets `TEST_DATABASE_URL` to that package's
own `rask_test_*` database; without it a suite points at whatever `DATABASE_URL`
names, and these tests insert and delete real rows. A bare `bun test` at the root
also globs the Playwright specs.

Signing in locally:

```bash
bun run seed           # 450 fake tasks; writes apps/web/.dev-session
open http://localhost:5173/__dev-login
```

`seed` **deletes every row in whatever `DATABASE_URL` names** (it counts first and
refuses a database that looks real). `bun run link` instead stores
`CLICKUP_PERSONAL_TOKEN` and points the local build at your real workspace —
writes from there reach ClickUp.

## Layout

| | |
|---|---|
| [apps/web](apps/web) | SolidJS, Vite, TanStack Router + DB, Tailwind v4, CodeMirror. |
| [apps/api](apps/api) | Hono on Bun. Reads the mirror, writes the mirror + outbox, fans out SSE. Serves the built SPA in production. |
| [apps/worker](apps/worker) | Six self-rescheduling loops: outbox drain, webhook read-back, cold list, poll, webhook health, nightly reconcile. |
| [packages/schema](packages/schema) | Drizzle tables, idempotent ingest, token encryption. The mirror. |
| [packages/clickup-client](packages/clickup-client) | Typed ClickUp client, per-token rate limiter, vendored v2 OpenAPI spec, shared vocabulary. |

## How the pieces fit

**Reads answer from Postgres, then repair themselves.** `GET /api/tasks/:id`
returns the mirrored detail immediately and kicks off a background ClickUp
refresh; the fresher version arrives over SSE ([apps/api/src/index.ts:345](apps/api/src/index.ts:345)).
`ChangeFeed` polls `tasks.synced_at` once a second and pushes changed rows to
every stream ([apps/api/src/changes.ts](apps/api/src/changes.ts)). The one read that blocks on ClickUp is
`GET /api/views/:id/tasks` — a ClickUp view's filters are ClickUp's to evaluate,
so the response is used as *membership* and the rows still come from the mirror.

**Loading a list is what makes it worth polling.** Both task routes insert a
`sync_cursors` row for the list; the worker only ever polls lists that have one.
Nothing else registers interest.

**Writes are optimistic three layers deep.** The browser applies through the
TanStack collection ([apps/web/src/lib/store.ts](apps/web/src/lib/store.ts)); the API updates the mirror and
inserts an `outbox` row in one transaction ([apps/api/src/writes.ts](apps/api/src/writes.ts)); the worker
claims rows `FOR UPDATE SKIP LOCKED` and ships them ([apps/worker/src/outbox.ts](apps/worker/src/outbox.ts)).
A rejection is never retried forever and never papered over: the worker refetches
from ClickUp to repair the mirror, and the author gets a `write-failed` SSE event.
Rows not yet shipped carry a `tmp_` placeholder id; addressing one upstream would
404, so those writes are refused with 409 rather than queued.

The exception is `POST /api/tasks/:id/attachments` ([attachments.ts](apps/api/src/attachments.ts)): an outbox
payload is jsonb and a file is bytes, so an upload waits for ClickUp and the task
is re-read into the mirror afterwards. It is also the only multipart request in
either direction — `readUpload` caps it on the stream, not on `Content-Length`.

**Ingestion is webhooks *and* polling, and polling never stops.** A webhook event
only names a task, so every event costs one `GET /task/{id}` — which is what makes
duplicates and out-of-order deliveries harmless. `docs/webhooks.md` explains why
the `history_items` diff is deliberately ignored and why the endpoint answers
400/403 but never 401/410 (ClickUp suspends a webhook on those two).

**The front end has one collection, not one per view.** Every task the session has
loaded lives in `store.ts`; `live.ts` mirrors it into a keyed Solid store and views
are plain predicates over that. `view.ts` owns what the main panel is showing, the
route owns the query. TanStack DB's live-query engine was removed on purpose —
don't reintroduce `useLiveQuery`.

## Invariants that fail silently

- **Shared words live in [packages/clickup-client/src/vocabulary.ts](packages/clickup-client/src/vocabulary.ts).** Placeholder
  prefix, closed status types, filter fields and operators, `cf:` addressing, date
  parsing. Retyping any of them in a second package is how the tag filter went
  blind to half the mirror.
- **Two filter evaluators, one vocabulary.** [apps/api/src/filters.ts](apps/api/src/filters.ts) turns clauses
  into SQL, [apps/web/src/lib/filters.ts](apps/web/src/lib/filters.ts) evaluates the same clauses over loaded rows.
  Change one and `apps/api/test/filter-parity.test.ts` fails on the other. Web-side
  filter code must stay a pure function of its arguments — the parity test imports
  it server-side.
- **jsonb columns need the custom types in [packages/schema/src/schema.ts](packages/schema/src/schema.ts).** Drizzle
  stringifies and Bun's driver encodes again, which stores a jsonb *string* that
  reads back fine through the ORM while `@>` silently matches nothing.
  `packages/schema/test/jsonb.test.ts` asserts `jsonb_typeof` and is the only thing
  that catches it.
- **Never invent a ClickUp endpoint.** The v2 spec is vendored at
  `packages/clickup-client/openapi/clickup-v2.json`. Not in there means it does not
  exist.
- **Register authenticated routes on `api`, not `app`.** A route on `app` is public;
  `apps/api/test/auth.test.ts` walks the route table and asserts everything outside
  a five-name allow-list answers 401.
- **`bun test` resolves `solid-js` to its server build.** Memos and effects do not
  react there, so a reactive test passes while asserting nothing. Anything worth
  testing in `apps/web` is a pure function.
- **Run `bun run --cwd apps/web contrast` before changing a colour token.** The same
  audit runs as a test.
- **One `SESSION_COOKIE_NAME` per checkout.** Cookies ignore the port, so two Rask
  instances on localhost overwrite each other's session.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess`, no `any` (Biome errors on it).
  Biome for lint and format: 2 spaces, double quotes, 100 columns.
- English everywhere: code, comments, commits, docs.
- Conventional Commits. Subjects here read as prose describing the behaviour
  (`fix(worker): page a list oldest-first, so an interrupted read resumes`), and
  bodies say why, not what.
- Comments carry the reasoning that the diff cannot — why a bargain was made, what
  broke last time. `ponytail:` marks a deliberate simplification and names its
  ceiling and upgrade path. Match that density rather than annotating syntax.
- Secrets only through `.env`, documented in `.env.example`.
- Tests are expected for anything that can lose data, be silently wrong, or be got
  wrong at a trust boundary. Break your own code to check the test goes red.
