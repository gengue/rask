# Rask

A fast, keyboard-first web client for ClickUp. Unofficial.

Rask is a minimal alternative UI for ClickUp built for people who live in the task
list all day and find the official client slow. It mirrors ClickUp into our own
Postgres, serves reads from there, and pushes writes back through an outbox. The
browser never talks to ClickUp directly.

MIT licensed. Rask is an independent project, not affiliated with, endorsed by, or
sponsored by ClickUp. ClickUp is a trademark of Mango Technologies, Inc.

```
Browser (SPA) <-- SSE --> API <-- REST + webhooks --> ClickUp
                           |
                       Postgres
                    (ClickUp mirror)
```

The browser never calls ClickUp: CORS and per-token rate limits make that a
non-starter. Postgres is a mirror and ClickUp always wins. Writes are applied
optimistically, queued in an outbox, and reverted if ClickUp rejects them.

## Documentation

| | |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | Run it locally, sign in three ways, and the traps that have each cost somebody an afternoon. |
| [docs/architecture.md](docs/architecture.md) | The pieces, the principles behind them, what was deliberately left out, and numbers measured against a real 150,000-task workspace. |
| [docs/deployment.md](docs/deployment.md) | A VPS or Coolify, the variables that matter, the first sync, upgrades, and what to check when something is wrong. |
| [docs/security.md](docs/security.md) | Who can sign in, how tokens and sessions are held, how the webhook endpoint authenticates — and what the model does not cover. |
| [docs/webhooks.md](docs/webhooks.md) | Why ingestion is webhooks *and* polling, and why polling never stops. |
| [docs/themes.md](docs/themes.md) | Light, dark, and the contrast budget. |

## Conventions

- TypeScript strict everywhere. No `any`.
- Code and docs in English.
- Conventional Commits.
- Secrets only via `.env`, documented in `.env.example`. Never hardcoded.
- Never invent a ClickUp endpoint. Check the OpenAPI spec vendored in
  `packages/clickup-client`.
