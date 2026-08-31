# Writing to ClickUp Docs

Read-only Docs shipped first: the index in `docs`, the bodies read live, a
reader that renders them. This is the recommendation for the write half — which
endpoints to expose, in what order, and why none of them belong in the outbox.

All four writes have now shipped. The two additive ones first —
`appendToDocPage` and `createDocPage` in the client,
`POST /api/docs/:docId/pages/:pageId/append` and `POST /api/docs/:docId/pages`,
the entry composer at the foot of a page and the two ways to add a page in
`DocReader`. Then delete: `deleteDocPage`,
`DELETE /api/docs/:docId/pages/:pageId`, and the "×" in the page index behind a
confirmation. Then replace, which this file spent most of its length arguing
about: `getDocPage` and `replaceDocPage`,
`PUT /api/docs/:docId/pages/:pageId` carrying the timestamp the browser read,
and an "Edit" button beside a page's byline. "Slice three, as it shipped" at the
end has what the design note here got right and what it did not. The numbers
elsewhere come from the vendored v3 spec and from the code as it stands.

**One correction runs through this file**, and it is worth reading before the
rest: most of this was written believing the Docs surface has no delete. It
does. "What the spec omits" near the end has the live answers and what they
change.

## Summary

1. Expose **append** (`PUT .../pages/{page}` with `content_edit_mode: append`)
   first. It is the only write in the set that *cannot* lose text, and it
   validates the whole path at the lowest stakes. **Shipped.**
2. Then **create page** (`POST .../pages`). That is the endpoint the release
   notes Doc actually needs — see below; the guess that it needed append is only
   half right. **Shipped.**
3. **Replace** — shipped, behind the conflict check below. The probe came back
   clean (see "The probe, run"), and the one question the API cannot answer —
   what a replace does to ClickUp's *render* — is answered instead by keeping
   the check honest and telling the person when it fires.
4. **Create Doc** (`POST /docs`) last, or not at all. It writes a row the `docs`
   index does not learn about until the nightly hierarchy pass.

**Delete page** is missing from this list because it was believed not to
exist. It does, and it shipped after create: one route, one confirmation naming
the page, no undo. It is the only write here that destroys text, and unlike the
other three a retried delete is harmless — the second one 404s at worst.

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

**The probe has been run — see "The probe, run" near the end.** Short version:
the API round trip is byte-stable, including a one-word edit, across three
replace cycles. The lossiness argument above is weaker than it looked. What it
does not settle is whether ClickUp's *render* survives, because the API will not
show a render at any format.

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
  somebody's Doc does, and tidying that up means deleting the page and writing
  it again. So the send is keyed on the text: one post per distinct draft,
  whatever fires it.
- Failures go to a toast, as every other write-through failure in the app does,
  carrying ClickUp's own words as the detail. The composer stays open with the
  text still in it, and an explicit "Add" button is what retries the same draft
  — blur must not, because a 502 that ClickUp had already applied would then
  duplicate.
- Nothing in `Docs.tsx`. That section is a reader inside a scroll of other
  things; the writing use lives in the full reader.
- `DocPageDto` does not carry the parent id, and should not. The browser
  creates a page under the page whose "+" was pressed, so it already holds the
  id; a copy on every row would be a field nothing reads. `parent_page_id` still
  matters server-side — `depth` is walked from it.

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
- **Note what the spec does not list.** `clickup-v3.json` has no delete of any
  kind. Treat that as unknown rather than settled — see "What the spec omits"
  below, where exactly this turned out to be wrong. Delete-*page* is real and
  has since shipped; delete-*doc* is genuinely a 405, so a Doc created through
  Rask is still only removable in ClickUp's own UI.

## Slice two, as it shipped

Create page, and two things it turned up that the recommendation had not.

**Where the control lives.** The plan put "New page" at the foot of the page
index. That is wrong, and the index's own comment says why: it only draws once a
Doc has more than one page, because a one-page Doc names its page after itself
and the column would repeat the title beside it. A control that appears only
after you already have two pages cannot be the one that gets you the second.

**Do not guess the parent. This one shipped wrong first.** The original rule was
"a sibling of the page you are reading" — send the current page's parent id.
Standing on "November 7" that gives the next entry beside it, which is right.
Standing on the Doc's own first page it gives the *root*, and pages asked for
while simply looking at a Doc were filed outside the tree they belonged to. It
happened in the live workspace within a day.

Guessing was never the right shape here, and the reason is in the spec:

```
editPagePublic: ['name', 'sub_title', 'content', 'content_edit_mode', 'content_format']
```

No `parent_page_id`, no `order_index`, no move endpoint and no reorder
endpoint. `parent_page_id` is write-once, and ClickUp's own
drag-and-drop runs on its internal API, not this one. A page filed in the wrong
place can only be corrected by deleting it and making it again, which costs it
its content and its history. The single moment the parent is decidable is the
moment the page is created; a control that guesses spends it on a coin flip.

So it asks. Every row of the index carries a `+` meaning "inside this one", the
header button is the root slot, and the name box opens **in the index at the
indent the page will occupy** — the placement is shown, not described. Opening
it is also what reveals the index on a one-page Doc.

**The page is born empty.** Name only; the body is `appendToDocPage`'s job. One
endpoint per shape of change means a page cannot be created and overwritten in
one breath, and two obvious steps beat a form that has to decide how much of a
page you may author before it exists.

### Two bugs the tests found

Both were caught by tests written against the recommendation, before the code
was believed.

`z.string().min(1)` passes on `"   "`. A page named with three spaces reached
ClickUp and was stored as a row the index draws blank, which is the exact thing
the schema's comment claimed to prevent. `.trim().min(1)` on both the page name
and the append body — the append had the same hole.

`flattenDocPages` dropped the nesting without recording it. A sub-page that
arrives nested and carries no `parent_page_id` of its own came out with no
parent at all, so it drew flat *and* filed its siblings at the root of the Doc.
The workspace has only ever answered flat, where the field is always set, so
this was latent — but `pages` is parsed at all for precisely the shape nobody
has seen, and the fix belongs in the same place: the flatten knows the parent,
so a child inherits it.

## The probe, run

Against the live workspace, on `gh-81835/gh-45695` (8627 characters of
markdown — headings, tables, mermaid diagrams), copied into a throwaway Doc so
nothing real was written to:

```
replace, unchanged  : sent 8627 -> read 8627  IDENTICAL
replace, one word   : sent 8628 -> read 8628  IDENTICAL
replace, restored   : sent 8627 -> read 8627  IDENTICAL
```

Create-then-read was byte-identical too. So the markdown round trip is a stable
fixed point, and the "replace is lossy on its own" argument is weaker than it
was written above.

Two things the probe could not close, and neither is a formality:

**The render is invisible to the API.** `content_format=text/html` answers 400,
as does anything but `text/md` and `text/plain`. So markdown is the highest
fidelity the public API offers in either direction, and whether ClickUp's
*rendered* page survives a replace cannot be measured from here — only by
looking at both Docs in ClickUp.

**One concrete signal of loss.** That page's mermaid diagrams come back as
` ```plain ` code fences. If ClickUp renders them as diagrams and the export
says `plain`, writing that back may flatten them. Ambiguous — the source may
genuinely be `plain` — and it is exactly the kind of thing only eyes on the
render will settle.

The conflict check is unaffected by any of this and still required: there is no
webhook for a Doc, so a replace built on a stale read still discards whatever
was written in between, and the compare-and-swap above is still the only
defence available.

## What is still not built

- **Replace**, now gated on eyes-on-the-render plus the conflict check rather
  than on the probe.
- **Reparenting or reordering a page.** Not deferred — impossible. There is no
  endpoint for either, and `editPagePublic` cannot write `parent_page_id`.
  Delete-and-recreate is the only correction, and it costs the page its content
  and its history.
- **`POST /docs`**, still behind the index question: a Doc created through Rask
  is invisible to `GET /api/docs/:id` and to the sidebar until the next
  hierarchy pass, which runs at boot and nightly.
- **Reordering or renaming a page.** `editPagePublic` writes `name`, so a rename
  is one field away — but it is a field on the endpoint whose other field is the
  one that destroys pages, and nothing has asked for it yet.

## What the spec omits — a correction

Written after the fact, because this document asserted the opposite several
times and the code quoted it.

**`DELETE /v3/workspaces/{ws}/docs/{doc_id}/pages/{page_id}` exists.** Verified
live against workspace 529 on 2026-08-31: it answers `204` and the page is
gone. It is not in `packages/clickup-client/openapi/clickup-v3.json`.

That is the trap CLAUDE.md names in as many words — *"Not in either means it
does not exist — but the reverse does not hold"* — and this file walked into it
anyway, having already recorded the vendored file understating the
`parent_type` enum two paragraphs earlier. Absence from the spec is not
evidence. Send the request.

Also verified live, so the next person does not have to guess twice:

| Request | Answer |
|---|---|
| `DELETE /v3/.../docs/{doc}/pages/{page}` | `204` — works, undocumented |
| `DELETE /v3/.../docs/{doc}` | `405` — no doc-level delete on v3 |
| `DELETE /v2/view/{doc_id}` | `200` — removes the Doc; Docs are view-backed |
| `PUT .../pages/{page}` with `archived: true` | `403` — archiving a page is not offered |
| `GET .../pages/{page}?content_format=text/html` | `400` — only `text/md` and `text/plain` exist |

What this changes, and what it does not:

- **The "ask, do not guess" conclusion stands.** Reparenting is still
  impossible, so the parent is still decided once and only once.
- **The stakes were overstated.** "Cannot be put right from Rask at all" was
  wrong. It is delete-and-recreate — bad, since the page loses its content and
  its history, but not permanent.
- **Rask should probably offer deletion.** It does now: `deleteDocPage`,
  `DELETE /api/docs/:docId/pages/:pageId` behind the same `writable` guard the
  additive writes use, and a "×" per index row behind a `window.confirm` that
  names the page. Two things the build turned up. `request` was calling
  `.json()` on every 2xx, and this is the only endpoint that answers with an
  empty body — the parse error read like a malformed response rather than the
  success it was. And an empty Doc became reachable for the first time, so the
  reader draws "This Doc has no pages." where it used to sit on "Loading…".
  What is still unverified: whether deleting a parent takes its children. The
  confirmation says "may take them with it" rather than claiming either way.

## Slice three, as it shipped

Replace, with the compare-and-swap this file specified, and nothing about the
shape of it changed on contact. `getDocPage` came back — it was written and
deleted once for having no caller, and this is the caller — the route re-reads
the page, compares `date_updated` against the value the browser sent, and
refuses with 409 on a mismatch **and** on a page ClickUp gave no timestamp for.
Three things worth knowing that the plan above did not say.

**The empty body is refused, and for a different reason than the append's.**
An empty append is a no-op ClickUp answers 200 to, which reads as a write that
vanished. An empty *replace* works perfectly: it empties the page. That is
never what somebody meant by an edit, and the thing they do mean — the page
going away — already has a route with a confirmation in front of it. So
`.trim().min(1)`, and the reader says so in a toast rather than spending a
request to be told no.

**409 is shared with "no ClickUp token", deliberately.** Both reach the same
toast and neither is a status the browser acts on structurally, so the message
is what distinguishes them. Splitting them would mean inventing a code for a
case that is unreachable in the reader — every read would already have failed.

**The reader's `Show` had to become keyed.** `Page` holds whether its body is
open in the editor and `MarkdownEditor` takes its document once on mount, so
with the unkeyed `Show` that was there, switching page mid-edit left one page's
draft sitting over another page's id — and the save would have written it there.
Keying is what makes a different page a different component.

The retry hazard the append carries does not apply here: the same body sent
twice leaves the page holding what it held after the first. What a retry can do
is win a race it should have lost, which is what the compare is for and why the
window between the compare-read and the PUT is still worth naming out loud.

One near-miss worth recording, because the test that caught it was written for
exactly this. Mutating `content_edit_mode` to check the tests went red, and
restoring it by matching on text, swapped the modes between the two methods —
append became a replace. `appendToDocPage`'s own "never as a replace" assertion
is what said so. Two methods, one string apart, is the whole reason both of
them pin it.
