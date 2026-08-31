# Writing to ClickUp Docs

Read-only Docs shipped first: the index in `docs`, the bodies read live, a
reader that renders them. This is the recommendation for the write half — which
endpoints to expose, in what order, and why none of them belong in the outbox.

Slice one — append — has shipped: `appendToDocPage` in the client,
`POST /api/docs/:docId/pages/:pageId/append`, and the composer at the foot of a
page in `DocReader`. Everything after it is still a design note, and the numbers
in it come from the vendored v3 spec and from the code as it stands.

## Summary

1. Expose **append** (`PUT .../pages/{page}` with `content_edit_mode: append`)
   first. It is the only write in the set that *cannot* lose text, and it
   validates the whole path at the lowest stakes. **Shipped.**
2. Then **create page** (`POST .../pages`). That is the endpoint the release
   notes Doc actually needs — see below; the guess that it needed append is only
   half right.
3. **Replace** waits behind a fidelity probe and a conflict check. It may never
   be worth it.
4. **Create Doc** (`POST /docs`) last, or not at all. It writes a row the `docs`
   index does not learn about until the nightly hierarchy pass.

Every one of them writes straight through to ClickUp. None go in the outbox.

## Append and create cannot lose text; replace can

This is the whole design, and it is a property of the request bodies rather than
of any check we write.

An **append** request carries only the new block. It does not contain the page's
existing content, so there is no version of the page in flight that could be
stale, and no way for the request to overwrite something written between the
read and the write. Two people appending at the same moment both land, in an
order nobody promised — which is not data loss. **Create page** has the same
property for the same reason: it addresses a page that does not exist yet.

A **replace** request carries the whole body, and that body was produced by
reading the page back as markdown. Two things can be wrong with it:

- **Somebody else's edit.** ClickUp's editor is collaborative and there is no
  webhook for a Doc, so Rask has no way to hear that a page moved. A replace
  built on a read from two minutes ago silently discards everything written
  since. The person who loses the text gets no signal at all — ClickUp's own
  version history is the only trace, and nothing in Rask points at it.
- **The markdown round trip.** ClickUp says this itself, in the description of
  `getPagePublic` in `openapi/clickup-v3.json`: *"Due to markdown format
  limitations, some content elements will not be displayed exactly as they
  appear in ClickUp."* A Doc holds blocks markdown has no spelling for —
  embedded task links, banners, columns, embeds. Read one as markdown and write
  it back and those blocks are gone, on a page nobody else touched, with nobody
  editing concurrently. This is the failure that worries me more than the race,
  because it needs no bad luck to happen.

The second point is the reason replace is not simply "append plus a conflict
check". It is lossy on its own, and the worst case for it is the most ordinary
edit anyone would want: fixing a typo. Small intended change, large unintended
one.

**Before replace ships, someone has to run the probe:** read a real page of the
release notes Doc as `text/md`, write it back unchanged with
`content_edit_mode: replace`, and diff what ClickUp then renders against what it
rendered before. If that is lossless for the blocks the workspace actually uses,
replace is a conversation. If it is not, the honest shape of this feature is:
*Rask can write into a Doc; it cannot rewrite one.*

## The release notes Doc wants a new page, not an append

`DocReader.tsx` records what that Doc looks like: 25 pages, 154 000 characters,
"24 dated pages … children of one root page", with names like "November 7 -
2025". Each release is a **new page** under the root, not a block appended to a
running one.

So `POST .../pages` with `parent_page_id` set to the root is the endpoint that
matches the workflow, and it is a create — which cannot lose anything by
construction. I am inferring the workflow from the page names and the shape, so
it is worth thirty seconds of looking at the Doc to confirm before building.

Append still goes first, on size rather than on fit: it is one editor at the
bottom of a page the reader already draws, it needs no form and no answer to
"where does this page go", and it exercises every part of the write path — the
session check, the mirror guard, the upstream error mapping, the retry hazard,
the refetch that repaints from ClickUp — at the lowest stakes in the set. Create page then
reuses all of it plus a name field.

Together the two additive endpoints are a coherent release: **write into a Doc,
never over one.**

`prepend` is the same enum, the same safety, the other end. Free to add and
worth nothing until somebody asks; the release notes Doc grows one way.

## Write-through, not the outbox

The outbox exists so a write can be shown before it lands: the API updates the
mirror and queues a row in one transaction, and the browser paints from the
mirror immediately. That trade only pays when the mirror holds the thing being
edited. It does not here, and the `docs` table comment argues at length that it
should not — a body is read once by one person, there is no webhook to keep a
mirrored copy fresh, and freshness would cost a poll per Doc anyone ever opened.

So a queued Doc write would buy nothing. The optimistic state it would let us
paint is the page the reader is already looking at, and there is no mirrored row
for the worker to repair when ClickUp refuses.

The retry is the part that actively hurts. `outbox.ts` retries on a backoff and
reclaims `STALE_SENDING` rows, and an append that ships twice appends the same
paragraph twice. That is the argument `time.ts` already makes about starting the
same timer twice, and it lands the same way here.

There is also a check that has to run at the moment of the write and not before
it — the `date_updated` compare that replace would need. A queued row's check is
stale by the time it drains, which makes it worse than no check: it would report
a clean write over somebody's edit.

So these wait for ClickUp, as the attachment upload and the time entries do.

### One residual retry hazard, and it is in the client

`ClickUpClient.request` retries 429 and 5xx for every verb, PUT included. A 429
is safe — the request was refused, not applied. A 502 or 504 that ClickUp
returned *after* applying the append is not: the retry appends the block again.

`maxRetries` is per client and `clientFor` hands out one shared instance, so
turning it off for this one call means a second client per token. Not worth it
for a failure this narrow with damage this visible — a duplicated paragraph the
author can see and delete in ClickUp.

Shipped documented, with a `ponytail:` comment on `appendToDocPage` naming the
ceiling: if duplicates ever show up, the upgrade is one single-page read on the
failure path, comparing `date_updated` against the value read before the write,
to tell "it did not land" from "it landed and then the gateway died".

## Detecting a concurrent edit

For append and create: nothing to detect. Skip this section until replace is on
the table.

For replace, the best the v3 surface allows is a compare-and-swap done at the
application layer. There is no ETag, no `If-Match`, no conditional write
anywhere in `clickup-v3.json`.

- `DocPageDto.updated` already carries the page's `date_updated`, so the browser
  has the value it read.
- It sends that value back with the write.
- The route re-reads the page (`getPagePublic`, one request) and compares.
  Different → **409**, "somebody edited this page while you had it open", and
  the reader refetches so the person can re-apply their change against the text
  that is actually there. Same → the PUT goes.
- **Fail closed on null.** `date_updated` is optional in `PublicDocsPageV3Dto`.
  A page that came back without one is a page the check cannot be made on, and
  the check is the only thing making the write safe — so refuse rather than
  write.

Be honest about what that buys: the window between the compare-read and the PUT
is still open, a few hundred milliseconds of it. It is a check, not a lock. It
turns "your paragraph is gone and nothing said so" into "your paragraph is gone"
becoming rare and "please try again against the new text" becoming the normal
outcome. That is worth having and it is not the same as being safe.

## The first slice, concretely

**Client** — `packages/clickup-client/src/client.ts`, beside `getDocPages`:

- `appendToDocPage(workspaceId, docId, pageId, markdown)`. `content_edit_mode`
  and `content_format` are written into the method body, not taken as
  arguments — the same reasoning that makes `searchDocs` spell `parentType` as a
  word. A mode that arrives as a parameter is a mode a caller can get wrong, and
  the wrong value here is `replace`.
- The 200 on `editPagePublic` declares no schema at all in the vendored file.
  Parse `z.unknown()`; nothing is read out of it.
- No wrapper for `getPagePublic`. It was written and then deleted: the route
  does not re-read, so it had no caller, and an unused method is a method
  nobody keeps honest. It is the first thing to add back on the day conflict
  detection needs a `date_updated`.

**API** — `apps/api/src/docs.ts`:

- `POST /api/docs/:docId/pages/:pageId/append`, body `{ content: string }`,
  markdown, capped (50 000, matching a comment rather than a description).
- The route name is the safety property. Not `PUT` with a `mode` field: a route
  that can only append cannot be talked into replacing by a client sending a
  different string, and that is a property a test can hold.
- Guard `docId` against the mirrored `docs` index for the team, exactly as
  `GET /api/docs/:id` does and for the same reason — the id arrives from the
  caller and decides what this server writes on the caller's token. `pageId`
  cannot be checked, since pages are not mirrored; a wrong page id inside a Doc
  the caller has already proved access to is a page they could read anyway.
  Worth a comment saying so.
- That guard also refuses an archived Doc for free. `DOC_LIVE_ONLY` keeps
  archived and deleted Docs out of both reads, so they never reach the index,
  and a write addressed at one answers 404 without a request leaving the
  machine. Free, but only as long as the guard stays — worth a line in the test.
- Answer `{ ok: true }` and nothing else. The recommendation first said to
  re-read the page and return it, which was one request too many: the browser
  has to refetch the Doc either way to see what ClickUp stored, and that refetch
  is the same single request `getDocPages` already was. Re-reading in the route
  as well would pay twice for one answer.
- Upstream failures need the `time.ts` shape, not the current `docs.ts` one: a
  4xx that is not 401 → 422, everything else → 502, and never ClickUp's status
  verbatim. "You do not have edit permission on this Doc" is an answer the
  person should read; a forwarded 401 signs them out of Rask. `upstream()` in
  `time.ts` is exactly this function and is not exported — two callers is the
  threshold, so lift it to its own module.

**Web** — `apps/web/src/components/DocReader.tsx`:

- An "Add an entry" affordance under the page body, opening `MarkdownEditor`
  with ⌘↵ to commit. Paste-to-upload does *not* come along for free — `onFiles`
  is wired by the task panel to that task's attachments, and a Doc reader has no
  task — so the editor is mounted without it. What it still buys is markdown
  highlighting, list continuation and an undo that understands the document.
- The composer has to be idempotent per draft, and this is the part worth
  knowing before writing it: `MarkdownEditor` commits on blur **and** on ⌘↵, and
  ⌘↵ does both — it calls `onCommit` and then blurs, which calls it again. A
  description PATCH does not care. The same paragraph appended twice to
  somebody's Doc does, and there is no delete-page endpoint to tidy up with. So
  the send is keyed on the text: one post per distinct draft, whatever fires it.
- Failures go to a toast, as every other write-through failure in the app does,
  carrying ClickUp's own words as the detail. The composer stays open with the
  text still in it, and an explicit "Add" button is what retries the same draft
  — blur must not, because a 502 that ClickUp had already applied would then
  duplicate.
- Nothing in `Docs.tsx`. That section is a reader inside a scroll of other
  things; the writing use lives in the full reader.
- `parentId` on `DocPageDto` waits for slice two. `ClickUpDocPage` carries
  `parent_page_id` and the DTO drops it, and nothing in an append needs it —
  it is create-page that has to know where a new page hangs.

**Tests** — `apps/api/test/docs.test.ts` already stubs a client, so these go
beside what is there. This is a write that can lose text, so they are not
optional:

- The captured request body carries `content_edit_mode: "append"` and never
  `replace`. This is the test that goes red the day somebody adds a `mode`
  parameter for convenience.
- A Doc not in the mirror, or one belonging to another team, answers 404 and
  makes no ClickUp call at all.
- ClickUp 403 → 422; ClickUp 401 → 502. Neither ever answers 401.
- An empty entry is a 400 and costs no ClickUp request. ClickUp accepts one and
  answers 200 having done nothing, which reads as a write that vanished.
- Client-level: `appendToDocPage` issues `PUT
  /v3/workspaces/{ws}/docs/{doc}/pages/{page}`, and its body carries **only**
  `content`, `content_edit_mode` and `content_format`. `name` and `sub_title`
  are writable on that endpoint and both default to `""`, so a body carrying
  either key empty would rename the page to nothing as a side effect.

## What not to do

- **Do not mirror page bodies.** Everything above works without it. Mirroring
  buys back the reconcile problem the `docs` comment already priced, and there
  is still no webhook to make it cheap.
- **Do not queue Doc writes.** Covered above.
- **Do not ship replace on a hunch.** The probe first.
- **Do not ship `POST /docs` yet.** A Doc created through Rask is invisible to
  `GET /api/docs/:id` and to the sidebar until the next hierarchy pass, which
  runs at boot and nightly. The fix is one insert into `docs` at creation time —
  the create response carries everything `mapDoc` needs — but `replaceDocs`
  deletes rows it was not given, so that row survives only because the next sync
  reads it back from ClickUp. That is a paragraph of reasoning owed to a feature
  nobody has asked for.
- **Note the missing delete.** There is no delete-page and no delete-doc
  endpoint in `clickup-v3.json`. Anything created through Rask can only be
  removed in ClickUp's own UI. That is a real cost of every create, and it is
  another reason the first slice appends to a page that already exists.
