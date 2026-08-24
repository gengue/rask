# Webhooks

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

Turning them on is in [deployment.md](deployment.md).
