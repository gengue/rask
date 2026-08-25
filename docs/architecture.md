# Architecture

How Rask is put together, and the decisions that are load-bearing rather than
incidental. For how to run it, see [CONTRIBUTING.md](../CONTRIBUTING.md); for
how to deploy it, [deployment.md](deployment.md).

```
Browser (SPA) <-- SSE --> API <-- REST + webhooks --> ClickUp
                           |
                       Postgres
                    (ClickUp mirror)
```

## Principles

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
  revert and tell the user. Attachment uploads are the one exception: an outbox
  row is JSON and a file is bytes, so they go straight to ClickUp and the task is
  re-read afterwards.
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

Some tests talk to a real Postgres on purpose: a jsonb column that round-trips
through the ORM while being stored wrong is not catchable any other way. They
write to a `rask_test_*` database, one per package, and never to `rask`, and
`test-db.ts` refuses a URL that is not clearly a test database — the tests insert and delete real rows, and
pointing them at the one you are looking at is a mistake worth making impossible
rather than remembering not to make.

How to run any of this is in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Things the original plan called for that are not here

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
- **wa-sqlite over OPFS with FTS5.** It was in the diagram above before it
  existed, which is why it is called out here. The in-memory collection is enough for the
  MVP, and cross-list search now runs on the server in single-digit
  milliseconds, so what this still buys is offline. A real piece of work, not a
  flag.
- **TanStack DB's query builder.** The collection stays — its optimistic layer
  replays pending mutations over the synced base rather than restoring a
  snapshot, which is what keeps a rollback from resurrecting stale values under
  a newer edit. The live-query engine went: the view predicate is a plain
  function of route params, so shipping a differential-dataflow compiler to
  answer `SELECT *` cost 30kB gzipped and a full array reconcile per change
  batch. `lib/live.ts` mirrors the collection into a keyed Solid store instead.
- **OpenTelemetry.** Not wired. Half-instrumenting is worse than not starting.
- **ClickUp's notification inbox.** The v2 spec has no endpoint for it — no
  feed, no read state, nothing to mirror and nowhere to write ours back. Rask's
  Inbox is a different thing wearing the same name: a query over the mirror for
  your tasks that ClickUp changed since your last visit, with one
  `users.inbox_seen_at` per person for where that was. Marking it read here
  changes nothing in ClickUp, and clearing it there changes nothing here.

  Clearing is a button, not a side effect of looking. The feed shows unread by
  default so that pressing it has somewhere visible to land — an inbox that
  cannot be emptied is not an inbox — and a second scope shows the last seven
  days so that clearing is not destruction.

  Read state is a watermark plus an exception list. `users.inbox_seen_at`
  answers "everything up to here"; `inbox_reads` holds the rows somebody
  dismissed one at a time and answers "and this one too". Unread is
  `activity > greatest(inbox_seen_at, read_at)`, which is what makes a
  dismissal a timestamp rather than a flag: a comment posted afterwards is
  newer than both and the row comes back. Marking the whole inbox read passes
  every exception by definition, so that route deletes them in the same
  transaction — the table has no other sweep and needs none.

  A comment is the exception, and the reason the feed can say anything at all:
  a comment *is* an event, with an author, a body and a time. Three signals feed
  the rows that carry one, ranked — you were mentioned, the comment was assigned
  to you, somebody said something on a task of yours. `notableComments` in
  `apps/api/src/queries.ts` is the query and the ranking.

  Mentions are indexed at ingest into `comment_mentions` rather than matched at
  read time, because "did this mention me" is otherwise a scan of every comment
  in the workspace. ClickUp omits the user on roughly one tag in ten and those
  are not represented at all — a display name matched out of free text notifies
  whoever happens to share it. What covers most of that gap is the blunt third
  signal: a mention usually lands on a task that is already yours.

  What is left is the task half's ceiling: state, not history. The Inbox can say
  *that* a task changed and show what it looks like now — it cannot say what it
  changed from, or who changed it, which is what would let a row read "Ana moved
  this to Done". That needs an event per change, and the two places one could
  come from both cost something. The webhook payload carries `history_items`
  with the actor in it, deliberately ignored today for the reasons in
  [webhooks.md](webhooks.md); a diff at ingest would catch the polled changes
  too, but `ingestTasks` upserts in bulk and never reads the row it is
  replacing, so it would mean a second SELECT on the hottest write path in the
  system. Neither is hard. Both are more than "this task moved" is worth until
  somebody asks for the sentence.

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
