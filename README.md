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
| `apps/web` | SolidJS, Vite, TanStack Router/DB/Virtual, Tailwind v4, CodeMirror 6. Local cache in wa-sqlite over OPFS with FTS5 for offline search. |
| `apps/api` | Bun + Hono, Drizzle over Postgres, Zod at the edges, per-user SSE fan-out. ClickUp OAuth, tokens encrypted at rest, session in an httpOnly cookie. |
| `apps/worker` | Ingest (webhooks, polling, reconciliation) and the outbox drain. Queues on pg-boss, same Postgres, no Redis. |
| `packages/schema` | Drizzle schema and shared Zod types. |
| `packages/clickup-client` | Typed client generated from ClickUp's OpenAPI spec, with a token-bucket rate limiter per token. |

Tooling: Biome (lint + format), Vitest for web, `bun test` for api/worker,
Playwright for one critical flow, Docker Compose for local Postgres.

Package management is Bun workspaces. No pnpm, no Turborepo: internal packages
export TypeScript source with no build step, so there is no build graph to order.
`bun run --filter '*' <script>` covers the rest. Turborepo goes in the day CI
typecheck time actually hurts.

## MVP scope

1. My Tasks, grouped by status or due date
2. List view with basic filters (status, assignee, tag)
3. Task detail: markdown description, status, assignee, due date, custom fields, comments
4. Quick add, and inline status changes without opening the task
5. Command palette and vim-style keyboard navigation (`j`/`k`, `/`, `gg`, `:`)

Explicitly out of scope: docs, gantt, dashboards, time tracking, whiteboards,
chat, multi-workspace, creating views.

## Getting started

Requires [Bun](https://bun.sh) >= 1.3, Node >= 22 (Vite runs on it), and Docker.

```bash
bun install
cp .env.example .env    # then fill in the ClickUp OAuth credentials
bun run db:up           # Postgres on localhost:5432
bun run dev
```

Useful scripts:

| Command | What |
|---|---|
| `bun run check` | Lint and format check across the repo |
| `bun run check:fix` | Same, but writes fixes |
| `bun run typecheck` | Typecheck every workspace |
| `bun test` | Run tests |
| `bun run db:reset` | Drop the Postgres volume and start clean |

## Conventions

- TypeScript strict everywhere. No `any`.
- Code and docs in English.
- Conventional Commits.
- Secrets only via `.env`, documented in `.env.example`. Never hardcoded.
- Never invent a ClickUp endpoint. Check the OpenAPI spec vendored in
  `packages/clickup-client`.
