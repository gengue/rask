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
});
export type ClickUpTask = z.infer<typeof clickUpTask>;

export const taskPage = z.looseObject({
  tasks: z.array(clickUpTask).default([]),
  /** v2 sets this when another page exists. Older responses omit it. */
  last_page: z.boolean().nullish(),
});

export const clickUpComment = z.looseObject({
  id: z.string(),
  /** Rich-text segments. `comment_text` is the flattened version we actually store. */
  comment: z.array(z.looseObject({ text: z.string().nullish() })).nullish(),
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

/** The shape of a task event delivered to our webhook endpoint. Only ever an id. */
export const webhookEvent = z.looseObject({
  event: z.string(),
  task_id: z.string().nullish(),
  webhook_id: z.string().nullish(),
  history_items: z.array(z.unknown()).nullish(),
});
export type WebhookEvent = z.infer<typeof webhookEvent>;
