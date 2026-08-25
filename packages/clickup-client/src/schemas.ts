import { z } from "zod";

/**
 * Response shapes for the slice of the ClickUp API that Rask mirrors.
 *
 * Every object is loose on purpose: ClickUp ships new fields without notice and
 * a sync that throws on an unknown key is a sync that breaks on a Tuesday.
 * Fields we don't read are dropped, not rejected.
 */

/** ClickUp sends epoch milliseconds as a string. Sometimes as a number. Sometimes "". */
const epochMs = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? new Date(n) : null;
  });

/** `id` is a number on users/teams/lists but a string on tasks. Normalize to string. */
const id = z.union([z.string(), z.number()]).transform(String);
const numericId = z.union([z.string(), z.number()]).transform(Number);

export const clickUpUser = z.looseObject({
  id: numericId,
  username: z.string().nullish(),
  email: z.string().nullish(),
  color: z.string().nullish(),
  initials: z.string().nullish(),
  profilePicture: z.string().nullish(),
});
export type ClickUpUser = z.infer<typeof clickUpUser>;

export const clickUpStatus = z.looseObject({
  id: z.string().nullish(),
  status: z.string(),
  color: z.string().nullish(),
  /** "open" | "custom" | "closed" | "done". Not an enum: workspaces invent their own. */
  type: z.string().nullish(),
  orderindex: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null ? null : Number(v))),
});
export type ClickUpStatus = z.infer<typeof clickUpStatus>;

export const clickUpPriority = z.looseObject({
  id: id.nullish(),
  priority: z.string().nullish(),
  color: z.string().nullish(),
  orderindex: z.union([z.string(), z.number()]).nullish(),
});

export const clickUpTag = z.looseObject({
  name: z.string(),
  tag_fg: z.string().nullish(),
  tag_bg: z.string().nullish(),
});

/** A Custom Field definition plus, when it comes back on a task, its value. */
export type ClickUpTag = z.infer<typeof clickUpTag>;

export const clickUpCustomField = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  type_config: z.unknown().nullish(),
  date_created: epochMs,
  hide_from_guests: z.boolean().nullish(),
  required: z.boolean().nullish(),
  value: z.unknown().nullish(),
});
export type ClickUpCustomField = z.infer<typeof clickUpCustomField>;

const parentRef = z.looseObject({
  id: id,
  name: z.string().nullish(),
  /** True for the implicit folder ClickUp wraps folderless lists in. */
  hidden: z.boolean().nullish(),
});

/**
 * A file attached to a task.
 *
 * Three URLs come back for the same object and they are not interchangeable.
 * `url` and `url_w_host` address the file itself, and the CDN answers them with
 * `Content-Disposition: attachment` — fine for an `<img>`, but a link to one
 * downloads a PDF instead of showing it. `url_w_query` is the same URL plus
 * `?view=open`, which flips the disposition to `inline`. So: `url` for
 * rendering, `url_w_query` for anything a person clicks.
 *
 * Three thumbnails, too. For an image ClickUp points `thumbnail_medium` and
 * `thumbnail_large` back at the original file; for a PDF or a video they are
 * genuine renders (a first page, a poster frame) at roughly 533px and 1600px,
 * and `thumbnail_small` is always a real ~80px thumbnail.
 */
export const clickUpAttachment = z.looseObject({
  /** "<uuid>.<ext>". Unique across the workspace, so it keys the mirror row. */
  id: z.string(),
  date: epochMs,
  title: z.string().nullish(),
  extension: z.string().nullish(),
  mimetype: z.string().nullish(),
  size: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null || v === "" ? null : Number(v))),
  thumbnail_small: z.string().nullish(),
  thumbnail_medium: z.string().nullish(),
  thumbnail_large: z.string().nullish(),
  /** ClickUp keeps rows for removed files and flags them rather than dropping them. */
  deleted: z.boolean().nullish(),
  /** Set on files ClickUp itself does not list on the task. */
  hidden: z.boolean().nullish(),
  url: z.string().nullish(),
  url_w_query: z.string().nullish(),
  url_w_host: z.string().nullish(),
});
export type ClickUpAttachment = z.infer<typeof clickUpAttachment>;

/**
 * What `POST /task/{id}/attachment` answers with.
 *
 * Thinner than the same file as it arrives on `GET /task/{id}`: no size, no
 * mimetype, no `url_w_query`, and the `date` is a number where the task's is a
 * string. Enough to name the file and link to it, not enough to mirror — which
 * is why the upload path re-reads the task instead of storing this.
 */
export const clickUpAttachmentUpload = z.looseObject({
  id: z.string(),
  title: z.string().nullish(),
  extension: z.string().nullish(),
  url: z.string().nullish(),
  thumbnail_small: z.string().nullish(),
  thumbnail_large: z.string().nullish(),
});
export type ClickUpAttachmentUpload = z.infer<typeof clickUpAttachmentUpload>;

/**
 * One line item in a task checklist.
 *
 * The spec documents `id`, `name`, `orderindex`, `assignee`, `resolved`,
 * `parent`, `date_created` and `children`. The Ventura workspace also sends
 * `group_assignee`, `start_date`, `due_date` and `sent_due_date_notif` on every
 * item, so this is loose like everything else here.
 *
 * `assignee` is documented two ways in the same spec — a full user object in
 * the CreateChecklistItem response, a bare id or null in the EditChecklistItem
 * one — so both are accepted and the mapper reduces them to an id.
 *
 * `children` is dropped. Nesting is already expressed by `parent` on the child,
 * and keeping both would be two representations of one edge to disagree.
 */
export const clickUpChecklistItem = z.looseObject({
  id: z.string(),
  name: z.string(),
  orderindex: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null ? null : Number(v))),
  assignee: z.union([clickUpUser, id]).nullish(),
  resolved: z.boolean().nullish(),
  /** The item this one is nested under. ClickUp allows one level in the UI. */
  parent: z.string().nullish(),
  date_created: epochMs,
});
export type ClickUpChecklistItem = z.infer<typeof clickUpChecklistItem>;

/**
 * A checklist on a task.
 *
 * `creator` is a bare numeric user id, not the user object every other creator
 * field on the API carries, and the vendored spec does not mention the field at
 * all — the Ventura workspace is where it turned up.
 *
 * `resolved` and `unresolved` are counts, not flags. They are deliberately not
 * mirrored: they are `items` counted, and a stored copy is a second thing to
 * keep in step every time a box is ticked.
 */
export const clickUpChecklist = z.looseObject({
  id: z.string(),
  task_id: z.string().nullish(),
  name: z.string(),
  orderindex: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null ? null : Number(v))),
  creator: id.nullish(),
  date_created: epochMs,
  items: z.array(clickUpChecklistItem).default([]),
});
export type ClickUpChecklist = z.infer<typeof clickUpChecklist>;

/** Every checklist write answers with the whole checklist, items included. */
export const checklistResponse = z.looseObject({ checklist: clickUpChecklist });

export const clickUpTask = z.looseObject({
  id: z.string(),
  custom_id: z.string().nullish(),
  custom_item_id: z.number().nullish(),
  name: z.string(),
  text_content: z.string().nullish(),
  description: z.string().nullish(),
  markdown_description: z.string().nullish(),
  status: clickUpStatus.nullish(),
  orderindex: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null ? null : String(v))),
  date_created: epochMs,
  date_updated: epochMs,
  date_closed: epochMs,
  date_done: epochMs,
  archived: z.boolean().nullish(),
  creator: clickUpUser.nullish(),
  assignees: z.array(clickUpUser).default([]),
  watchers: z.array(clickUpUser).default([]),
  tags: z.array(clickUpTag).default([]),
  parent: z.string().nullish(),
  priority: clickUpPriority.nullish(),
  due_date: epochMs,
  start_date: epochMs,
  time_estimate: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null ? null : Number(v))),
  // Same union as `time_estimate`: ClickUp answers with a number here and a
  // decimal string over in the time-entry endpoints, and one task payload
  // typed either way is cheaper than finding out which by endpoint.
  time_spent: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null ? null : Number(v))),
  points: z.number().nullish(),
  custom_fields: z.array(clickUpCustomField).default([]),
  list: parentRef.nullish(),
  folder: parentRef.nullish(),
  space: parentRef.nullish(),
  url: z.string().nullish(),
  /**
   * Optional, not defaulted, and the difference matters. `GET /task/{id}` always
   * sends the key (`[]` when there are none); `GET /list/{id}/task` omits it
   * entirely. Defaulting to `[]` would make a list poll look like ClickUp had
   * just told us the task has no files, and the mirror would delete them all.
   */
  attachments: z.array(clickUpAttachment).optional(),
  /** Optional for the same reason as `attachments`, and with the same teeth. */
  checklists: z.array(clickUpChecklist).optional(),
});
export type ClickUpTask = z.infer<typeof clickUpTask>;

export const taskPage = z.looseObject({
  tasks: z.array(clickUpTask).default([]),
  /** v2 sets this when another page exists. Older responses omit it. */
  last_page: z.boolean().nullish(),
});

/**
 * Inline and block formatting on a comment run.
 *
 * This is a Quill delta wearing ClickUp's clothes: the inline keys style the
 * run's own text, and the block keys (`list`, `indent`) belong to the line that
 * the run *ends*, which is why they only ever turn up on a run whose text is
 * "\n". `block-id` is ClickUp's editor bookkeeping and means nothing to us.
 */
const commentAttributes = z.looseObject({
  bold: z.boolean().nullish(),
  italic: z.boolean().nullish(),
  strike: z.boolean().nullish(),
  code: z.boolean().nullish(),
  link: z.string().nullish(),
  /**
   * "bullet" | "ordered" | "checked" | "unchecked" | "toggled" | "none",
   * sometimes wrapped in an object of the same name. Both shapes occur in the
   * Ventura workspace, on adjacent lines of the same comment.
   */
  list: z.union([z.string(), z.looseObject({ list: z.string().nullish() })]).nullish(),
  indent: z.number().nullish(),
});
export type ClickUpCommentAttributes = z.infer<typeof commentAttributes>;

/**
 * A file carried inside a comment: `image` on a pasted screenshot, `frame` on a
 * screen recording, `attachment` on anything uploaded (which is what older
 * comments use even for images).
 *
 * `url` points at t{team}.p.clickup-attachments.com, which is public and
 * unsigned but sends no CORS headers, so an `<img src>` works and a `fetch()`
 * does not. The bare URL is served `Content-Disposition: attachment`; the
 * `?view=open` variant is served inline. ClickUp precomputes both on
 * `attachment` as `url` and `url_w_query`, which is where that convention
 * comes from.
 */
const commentFile = z.looseObject({
  id: z.string().nullish(),
  name: z.string().nullish(),
  title: z.string().nullish(),
  /** Present on `attachment`. The only reliable way to tell an image from a PDF. */
  mimetype: z.string().nullish(),
  url: z.string().nullish(),
  url_w_query: z.string().nullish(),
  src: z.string().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});
export type ClickUpCommentFile = z.infer<typeof commentFile>;

/**
 * A table, as Quill stores one: a list of row ids, a list of column ids, and a
 * `cells` map keyed "row:column", both 1-based. Each cell holds its own little
 * delta. ClickUp's flattening renders the whole thing as the literal string
 * "undefined".
 */
const commentTable = z.looseObject({
  rows: z.array(z.unknown()).nullish(),
  columns: z.array(z.unknown()).nullish(),
  cells: z
    .record(
      z.string(),
      z.looseObject({
        content: z
          .array(z.looseObject({ insert: z.unknown(), attributes: commentAttributes.nullish() }))
          .nullish(),
      }),
    )
    .nullish(),
});
export type ClickUpCommentTable = z.infer<typeof commentTable>;

/**
 * One run of a comment body.
 *
 * The published formatting guide only documents what a client may *send* —
 * `tag` and `emoticon` — and says nothing about what comes back. These are the
 * types actually found in the Ventura workspace over ~1,350 comments: plain
 * text, tag, image, attachment, assignees_tag, people_custom_field_tag,
 * bookmark, emoticon, link_mention, task_mention, frame, table-embed.
 *
 * Loose on purpose, and every renderer falls back to `text`, so a type ClickUp
 * adds tomorrow degrades to the words it was carrying instead of vanishing.
 */
export const clickUpCommentSegment = z.looseObject({
  /** Absent on a plain run of text. */
  type: z.string().nullish(),
  text: z.string().nullish(),
  /** On `tag`: who was mentioned. ClickUp omits it on roughly one tag in ten. */
  user: clickUpUser.nullish(),
  image: commentFile.nullish(),
  frame: commentFile.nullish(),
  attachment: commentFile.nullish(),
  "table-embed": commentTable.nullish(),
  bookmark: z.looseObject({ url: z.string().nullish() }).nullish(),
  emoticon: z.looseObject({ code: z.string().nullish(), name: z.string().nullish() }).nullish(),
  link_mention: z.looseObject({ url: z.string().nullish() }).nullish(),
  task_mention: z.looseObject({ task_id: z.string().nullish(), team_id: id.nullish() }).nullish(),
  attributes: commentAttributes.nullish(),
});
export type ClickUpCommentSegment = z.infer<typeof clickUpCommentSegment>;

export const clickUpComment = z.looseObject({
  id: z.string(),
  /**
   * The rich body. `comment_text` is ClickUp's flattening of it, and the
   * flattening drops everything that is not a word: an image becomes its file
   * name and a mention becomes "@Name". `renderCommentBody` turns this into the
   * markdown the mirror stores alongside the flat text.
   */
  comment: z.array(clickUpCommentSegment).nullish(),
  comment_text: z.string().nullish(),
  user: clickUpUser.nullish(),
  assignee: clickUpUser.nullish(),
  resolved: z.boolean().nullish(),
  reply_count: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null ? 0 : Number(v))),
  date: epochMs,
});
export type ClickUpComment = z.infer<typeof clickUpComment>;

/** What POST .../comment answers with. Just enough to find the row again. */
export const createdComment = z.looseObject({ id: id });

/** The reply endpoint is documented as answering `{}`, so the id is optional. */
export const threadedCommentCreated = z.looseObject({ id: id.optional() });

/**
 * How a view groups the tasks under it.
 *
 * `field` is ClickUp's own vocabulary — "status", "assignee", "priority",
 * "dueDate", a Custom Field id — and is the only part Rask evaluates itself,
 * since the filters are applied upstream by `GET /view/{id}/task`. `dir` is
 * 1 or -1, `collapsed` holds the group keys folded shut in ClickUp's UI, and
 * `single` and `ignore` are its own bookkeeping. Null on the view types that
 * hold no tasks: forms and conversations send `grouping: null` outright.
 */
export const clickUpViewGrouping = z.looseObject({
  field: z.string().nullish(),
  dir: z.number().nullish(),
  collapsed: z.array(z.string()).nullish(),
  ignore: z.boolean().nullish(),
  single: z.boolean().nullish(),
});

/**
 * A view's filter set.
 *
 * Kept whole for the shape, read for one field. `fields` is the rule list
 * (`[{field:"tag", op:"ANY", values:[...]}]`) and Rask never evaluates it:
 * `GET /view/{id}/task` does that server-side. `show_closed` is different —
 * it says what the answer already contains, which is something Rask's own
 * show-closed toggle has to agree with rather than re-decide.
 */
export const clickUpViewFilters = z.looseObject({
  op: z.string().nullish(),
  fields: z.array(z.unknown()).nullish(),
  search: z.string().nullish(),
  show_closed: z.boolean().nullish(),
});

/**
 * A view on a List, Folder, Space or Team.
 *
 * `type` is ClickUp's tab kind: list, board, calendar, gantt, timeline,
 * workload, table, box, activity, map, mind_map, doc, form, conversation.
 * Loose, not an enum: ClickUp ships new view types and a sync that throws on
 * one would break the tab bar for every list that has it.
 *
 * `orderindex` is one sequence across the saved views and the built-in ones,
 * which is what makes merging the two response buckets into one tab row work.
 *
 * `public_url` only ever appears on a form. It is the address the form is
 * published at (forms.clickup.com, not app.clickup.com), so it is the only
 * link that opens a form where a person can fill it in.
 */
export const clickUpView = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  parent: z.looseObject({ id: id, type: z.number().nullish() }).nullish(),
  orderindex: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null || v === "" ? null : Number(v))),
  protected: z.boolean().nullish(),
  grouping: clickUpViewGrouping.nullish(),
  filters: clickUpViewFilters.nullish(),
  public_url: z.string().nullish(),
});
export type ClickUpView = z.infer<typeof clickUpView>;

/**
 * What `GET /{container}/{id}/view` answers with.
 *
 * Three buckets carrying the same objects. `views` is what somebody saved,
 * `required_views` is a map keyed by view type holding the built-ins the
 * container actually has — every other key is present and `null`, which the
 * published schema does not mention at all. `default_view` is the tab ClickUp
 * opens the container on, serialised as the full row rather than the trimmed
 * one, with `type` as a number instead of the string the other two use. Only
 * its id is read here, so that disagreement never has to be reconciled.
 */
export const listViewsResponse = z.looseObject({
  views: z.array(clickUpView).default([]),
  required_views: z.record(z.string(), clickUpView.nullish()).default({}),
  default_view: z.looseObject({ id: z.string() }).nullish(),
});

/** What `GET /view/{id}` answers with: the same object, on its own. */
export const viewResponse = z.looseObject({ view: clickUpView });

/**
 * What `parent.type` on a view means.
 *
 * The container the view hangs off, and the only thing that says which level a
 * view lives at — the id alone does not, since a Workspace id and a List id are
 * both bare numbers. The built-in view ids echo it (`6-{list}-1`,
 * `7-{team}-1`), but saved views are named `gh-96335` and carry the level here
 * and nowhere else.
 *
 * Observed, not published: the GetView schema documents `parent` as an opaque
 * object. Four values seen against the Ventura workspace, one per level of the
 * hierarchy Rask already mirrors.
 */
export const VIEW_PARENT = { space: 4, folder: 5, list: 6, workspace: 7 } as const;

export const clickUpList = z.looseObject({
  id: z.string(),
  name: z.string(),
  orderindex: z.number().nullish(),
  content: z.string().nullish(),
  status: clickUpStatus.nullish(),
  task_count: z.number().nullish(),
  due_date: epochMs,
  start_date: epochMs,
  archived: z.boolean().nullish(),
  override_statuses: z.boolean().nullish(),
  /** Only present when the List overrides its Space's statuses. */
  statuses: z.array(clickUpStatus).nullish(),
  folder: z
    .looseObject({ id: id, name: z.string().nullish(), hidden: z.boolean().nullish() })
    .nullish(),
  space: parentRef.nullish(),
});
export type ClickUpList = z.infer<typeof clickUpList>;

export const clickUpFolder = z.looseObject({
  id: z.string(),
  name: z.string(),
  orderindex: z.number().nullish(),
  hidden: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  task_count: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null ? null : Number(v))),
  space: parentRef.nullish(),
  lists: z.array(clickUpList).default([]),
});
export type ClickUpFolder = z.infer<typeof clickUpFolder>;

export const clickUpSpace = z.looseObject({
  id: z.string(),
  name: z.string(),
  private: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  multiple_assignees: z.boolean().nullish(),
  statuses: z.array(clickUpStatus).default([]),
});
export type ClickUpSpace = z.infer<typeof clickUpSpace>;

export const clickUpTeam = z.looseObject({
  id: id,
  name: z.string(),
  color: z.string().nullish(),
  avatar: z.string().nullish(),
  members: z.array(z.looseObject({ user: clickUpUser })).default([]),
});
export type ClickUpTeam = z.infer<typeof clickUpTeam>;

export const clickUpWebhook = z.looseObject({
  id: z.string(),
  endpoint: z.string().nullish(),
  events: z.array(z.string()).default([]),
  /** Only returned once, at creation. Verifies the X-Signature header on events. */
  secret: z.string().nullish(),
  health: z
    .looseObject({ status: z.string().nullish(), fail_count: z.number().nullish() })
    .nullish(),
});
export type ClickUpWebhook = z.infer<typeof clickUpWebhook>;

export const accessTokenResponse = z.looseObject({
  access_token: z.string(),
  token_type: z.string().nullish(),
});

/**
 * A task event delivered to our webhook endpoint.
 *
 * Confirmed against real deliveries rather than the docs: creating one task
 * produced `taskCreated`, `taskStatusUpdated` and `taskUpdated`, and every one
 * of them carried exactly these five keys.
 *
 * `history_items` is richer than "an event name and an id" suggests — each
 * entry names the field that changed and carries `before` and `after`, plus
 * the user who did it. Rask still re-reads the task rather than applying that
 * diff, and deliberately: the array only describes the fields this event
 * touched, so it can populate a task the mirror has never seen with a status
 * and nothing else. Re-reading is one request and is correct for every event
 * with one code path, which is what makes duplicates and reordering harmless.
 * The array is kept as `unknown` because nothing reads inside it.
 */
export const webhookEvent = z.looseObject({
  event: z.string(),
  task_id: z.string().nullish(),
  webhook_id: z.string().nullish(),
  /** The Workspace. Always present on a real delivery, though undocumented. */
  team_id: z.string().nullish(),
  history_items: z.array(z.unknown()).nullish(),
});
export type WebhookEvent = z.infer<typeof webhookEvent>;

/**
 * One tracked interval.
 *
 * Three of ClickUp's own quirks are absorbed here rather than at the call site:
 *
 *  - `duration` is a decimal string from the list endpoints and a number from
 *    the create one, so it is a union like every other numeric field.
 *  - A **negative** `duration` means the timer is still running. The vendored
 *    spec says so under `GET /team/{id}/time_entries`. Nothing derives elapsed
 *    time from it; `isTimeEntryRunning` is the only reader.
 *  - `task` is absent entirely when the entry is not attached to one. ClickUp
 *    allows that on the higher plans, and `.nullish()` is the difference
 *    between showing an orphan entry and throwing mid-render.
 */
export const clickUpTimeEntry = z.looseObject({
  id: id,
  task: z
    .looseObject({
      id: z.string(),
      name: z.string().nullish(),
      status: clickUpStatus.nullish(),
    })
    .nullish(),
  wid: id.nullish(),
  user: clickUpUser.nullish(),
  billable: z.boolean().nullish(),
  start: epochMs,
  /** Absent on a running entry: `GET .../current` does not list it as required. */
  end: epochMs,
  duration: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null || v === "" ? null : Number(v))),
  description: z.string().nullish(),
  tags: z.array(clickUpTag).default([]),
});
export type ClickUpTimeEntry = z.infer<typeof clickUpTimeEntry>;

/**
 * Whether this entry is the one currently running.
 *
 * The rule lives here, next to the schema, because it is a fact about ClickUp's
 * wire format rather than a word Rask shares between packages — the API
 * normalises it into a boolean before anything else sees an entry, so the web
 * side never has to know.
 */
export function isTimeEntryRunning(entry: ClickUpTimeEntry): boolean {
  return entry.duration !== null && entry.duration < 0;
}

/**
 * `GET .../current` answers `{ data: null }` when nothing is running, and the
 * key is documented as required — so `null` is the answer, not an absence.
 */
export const runningTimeEntryResponse = z.looseObject({
  data: clickUpTimeEntry.nullish(),
});

export const timeEntryResponse = z.looseObject({ data: clickUpTimeEntry });
export const timeEntriesResponse = z.looseObject({
  data: z.array(clickUpTimeEntry).nullish(),
});
