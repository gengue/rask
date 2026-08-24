# Contributing to Rask

Rask mirrors a real ClickUp workspace into Postgres and writes back through a
queue. Most of what follows exists because that arrangement has a few sharp
edges, and every warning below is one somebody already ran into.

Read [README.md](README.md) first for what the pieces are and why. This file is
how to run them.

## What you need

- **Bun 1.3+** (`curl -fsSL https://bun.sh/install | bash`). Not Node — the
  packages export TypeScript source with no build step, and the API and worker
  use Bun's native Postgres client.
- **Docker**, for local Postgres. Nothing else runs in a container in dev.
- **A ClickUp account.** You do not need a paid plan to develop against it, but
  the rate limit differs by plan and the client is tuned for Business (100
  req/min per token).

## Setup

```bash
git clone git@github.com:gengue/rask.git
cd rask
bun install

cp .env.example .env
openssl rand -base64 32   # -> TOKEN_ENCRYPTION_KEY
openssl rand -base64 32   # -> SESSION_SECRET

bun run db:up                              # Postgres on :5432
bun run --cwd packages/schema migrate      # create the schema
```

Every variable in `.env.example` is documented in place. `CLICKUP_CLIENT_ID`
and `CLICKUP_CLIENT_SECRET` come from an OAuth app you create at
**ClickUp → Settings → Apps**; `CLICKUP_REDIRECT_URI` has to match what you
registered there character for character, or the callback fails with no useful
error.

Leave `CLICKUP_WEBHOOK_URL` blank in dev. ClickUp cannot reach localhost, and a
URL that stops answering earns delivery failures against the real workspace —
100 of them suspend the webhook.

## Signing in

Three ways, in order of how much they cost you.

### Fake data, no ClickUp account

```bash
bun run --cwd apps/api seed        # 450 tasks, 6 lists, 230 comments
bun run dev
open http://localhost:5173/__dev-login
```

`seed` writes a session token to `apps/web/.dev-session`, and `/__dev-login`
turns it into a cookie. That route lives in the Vite dev server, which is not
part of any build, so nothing in the deployed app can do the same thing.

**`seed` deletes every row in whatever `DATABASE_URL` names.** On a fresh clone
that is an empty database. On a checkout that has already synced a real
workspace it is not, so the script counts first and refuses anything holding
more tasks than it could have written, naming the database in the error.
`RASK_SEED_FORCE=1` overrides it, and is meant to be inconvenient to type.

This is what the e2e suite uses. Writes are queued and fail against ClickUp,
which is correct — there is no upstream task to write to.

### Your real workspace, no OAuth round trip

Put a personal token (**ClickUp → Settings → Apps → API Token**) in
`CLICKUP_PERSONAL_TOKEN`, then:

```bash
bun run --cwd apps/api link
bun run dev
open http://localhost:5173/__dev-login
```

`link` stores the token exactly as an OAuth token would be stored and writes a
session for whoever it belongs to. Deliberately a script rather than a route:
there is no code path in the server that can be talked into doing this.

**This points a local build at a real workspace, and writes reach it.** Prefer
the fake data unless you are working on something that only reproduces against
real shapes.

### Full OAuth

Set the OAuth variables and visit `http://localhost:3000/auth/clickup`. Worth
doing once before touching anything in `apps/api/src/auth.ts`.

## Running it

```bash
bun run dev
```

Starts the API on `:3000`, Vite on `:5173`, and the worker. The worker polls
ClickUp and drains the outbox; if you are on fake data it will log failures
against tasks that do not exist upstream, which is expected.

Vite proxies `/api` to the API, so use `http://localhost:5173` and not the API
port directly.

## Checks

```bash
bun run check          # Biome: lint and format
bun run check:fix      # and fix what it can
bun run typecheck      # tsc across all five packages
bun run db:test        # (re)create rask_test — once per schema change
bun run test           # the suite
```

Run the suite with `bun run test`, **not** a bare `bun test`: the latter globs
the Playwright specs, which need running servers, and it does not set
`TEST_DATABASE_URL`.

End-to-end, which starts its own API, Vite and database on their own ports:

```bash
bun run --cwd apps/web e2e
```

Before changing a colour token:

```bash
bun run --cwd apps/web contrast
```

It reads the tokens out of `styles.css` and prints every foreground/surface
ratio in both themes, exiting non-zero if any is below WCAG AA. The same audit
runs as a test, so CI catches it too.

## Things that have bitten people

- **Tests must never touch your dev database.** `bun run test` sets
  `TEST_DATABASE_URL` to `rask_test`, and `packages/schema/src/test-db.ts`
  refuses anything that is not clearly a test database. A bare `bun test` once
  truncated a 147,000-task mirror. If you add a test that imports
  `apps/api/src/index.ts`, set `DATABASE_URL` yourself before the import — that
  file builds a pool from the environment at module scope.
- **`bun test` resolves `solid-js` to its server build.** Memos and effects do
  not react there, so a reactive test passes while asserting nothing. Anything
  worth testing in `apps/web` has to be a pure function of its arguments; that
  is why `selectRows`, `matchesTask` and the sidebar's state are shaped the way
  they are.
- **jsonb columns need the custom types in `packages/schema/src/schema.ts`.**
  Drizzle stringifies before binding and Bun's driver encodes again, which
  yields a jsonb *string*. It reads back fine through the ORM and silently
  breaks containment (`@>`) — that hid 71,503 rows from the tag filter for
  weeks. `packages/schema/test/jsonb.test.ts` asserts `jsonb_typeof` on the
  stored value, which is the only thing that catches it.
- **Never invent a ClickUp endpoint.** The v2 OpenAPI spec is vendored at
  `packages/clickup-client/openapi/clickup-v2.json`. If it is not in there, it
  does not exist for us — that is how we know ClickUp has no favourites API.
- **One `SESSION_COOKIE_NAME` per checkout.** Cookies are scoped by host and
  ignore the port, so two Rask instances on localhost overwrite each other's
  session and you end up writing to the wrong workspace.
- **Two evaluators, one vocabulary.** A filter runs as SQL in
  `apps/api/src/filters.ts` and over rows in `apps/web/src/lib/filters.ts`.
  Change one and `apps/api/test/filter-parity.test.ts` will tell you about the
  other. Shared words live in `@rask/clickup-client/vocabulary`.

## Sending a change

- Branch off `main`. One branch per piece of work.
- [Conventional Commits](https://www.conventionalcommits.org). The body should
  say why, not what — the diff already says what.
- Write in English: code, comments, commit messages, docs.
- TypeScript strict. No `any`.
- Secrets only through `.env`, documented in `.env.example`.
- New dependency? Say in one line what it does that a few lines of ours would
  not.

Tests are expected for anything that can lose data, be silently wrong, or be
got wrong at a trust boundary. **Break your own code to check the test goes
red** — a test that cannot fail is worse than none, because it reads as
coverage. If you cannot make it fail, say so rather than keeping it.

CI runs lint, typecheck across all five packages, migrations, the suite,
Playwright, and a Docker build. All of it has to be green.
