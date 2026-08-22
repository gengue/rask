import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The Postgres mirror of ClickUp.
 *
 * Rules that shaped this file:
 *  - ClickUp is the source of truth. Every mirrored row can be thrown away and
 *    refetched, so nothing here has a foreign key onto ClickUp data that would
 *    block a partial resync arriving out of order.
 *  - Every ClickUp id is stored as text. Tasks use base-36 ids, everything else
 *    uses numeric strings; one type means no casting at join time.
 *  - `date_updated` from ClickUp drives incremental sync. `synced_at` is ours
 *    and says when we last heard about the row.
 */

const bytea = customType<{ data: Buffer; notNull: true }>({
  dataType: () => "bytea",
});

/** Local-clock timestamp column. ClickUp sends epoch ms; the client converts. */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// --- Identity -------------------------------------------------------------

/**
 * Every ClickUp user we have ever seen, whether or not they use Rask.
 * Assignees and comment authors land here too, which is what makes the
 * assignee filter renderable without a second round trip to ClickUp.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username"),
  email: text("email"),
  color: text("color"),
  initials: text("initials"),
  profilePicture: text("profile_picture"),
  /** True once they have completed the OAuth flow at least once. */
  isRaskUser: boolean("is_rask_user").notNull().default(false),
  syncedAt: ts("synced_at").notNull().defaultNow(),
});

/**
 * One ClickUp OAuth token per user. Never a shared token: the 100 req/min quota
 * is per token, and ClickUp attributes every write to the token's owner.
 *
 * Stored as AES-256-GCM ciphertext. The nonce is per-row and the auth tag is
 * appended to the ciphertext, so a leaked database dump is not a leaked token.
 */
export const oauthTokens = pgTable("oauth_tokens", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  nonce: bytea("nonce").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the cookie value. The raw value only ever lives in the cookie. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

// --- Hierarchy ------------------------------------------------------------

export const spaces = pgTable(
  "spaces",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    name: text("name").notNull(),
    private: boolean("private").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    /** The Space's status set, inherited by its lists unless a list overrides it. */
    statuses: jsonb("statuses").$type<StatusDef[]>().notNull().default(sql`'[]'::jsonb`),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("spaces_team_idx").on(t.teamId)],
);

export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    name: text("name").notNull(),
    orderindex: integer("orderindex"),
    hidden: boolean("hidden").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("folders_space_idx").on(t.spaceId)],
);

export const lists = pgTable(
  "lists",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    /** Null for lists that hang directly off a Space. */
    folderId: text("folder_id"),
    name: text("name").notNull(),
    orderindex: integer("orderindex"),
    content: text("content"),
    taskCount: integer("task_count"),
    archived: boolean("archived").notNull().default(false),
    /** Only set when the list overrides its Space's statuses. */
    statuses: jsonb("statuses").$type<StatusDef[] | null>(),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("lists_space_idx").on(t.spaceId), index("lists_folder_idx").on(t.folderId)],
);

// --- Tasks ----------------------------------------------------------------

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    customId: text("custom_id"),
    listId: text("list_id").notNull(),
    folderId: text("folder_id"),
    spaceId: text("space_id"),
    teamId: text("team_id"),

    name: text("name").notNull(),
    /** Markdown, from `include_markdown_description=true`. */
    description: text("description"),
    textContent: text("text_content"),

    /** Denormalized from the status object: this is what the UI groups by. */
    status: text("status"),
    statusColor: text("status_color"),
    /** "open" | "custom" | "closed" | "done", but workspaces invent their own. */
    statusType: text("status_type"),

    orderindex: text("orderindex"),
    parentId: text("parent_id"),
    /** 1 urgent, 2 high, 3 normal, 4 low. Null means no priority set. */
    priority: smallint("priority"),

    dueDate: ts("due_date"),
    startDate: ts("start_date"),
    dateCreated: ts("date_created"),
    /** ClickUp's own mtime. Feeds date_updated_gt on the next incremental poll. */
    dateUpdated: ts("date_updated"),
    dateClosed: ts("date_closed"),
    dateDone: ts("date_done"),

    creatorId: text("creator_id"),
    archived: boolean("archived").notNull().default(false),
    /** [{ name, fg, bg }]. Kept whole so the UI can render colors without a join. */
    tags: jsonb("tags").$type<TaskTag[]>().notNull().default(sql`'[]'::jsonb`),
    timeEstimate: bigint("time_estimate", { mode: "number" }),
    points: real("points"),
    url: text("url"),

    syncedAt: ts("synced_at").notNull().defaultNow(),
    /** Set when ClickUp reports the task gone. Rows are kept so open tabs can reconcile. */
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("tasks_list_idx").on(t.listId),
    index("tasks_space_idx").on(t.spaceId),
    index("tasks_status_idx").on(t.listId, t.status),
    index("tasks_due_idx").on(t.dueDate),
    index("tasks_updated_idx").on(t.dateUpdated),
    index("tasks_parent_idx").on(t.parentId),
    // Tag filtering is `tags @> '[{"name":"..."}]'`, which needs jsonb_path_ops.
    index("tasks_tags_idx").using("gin", sql`${t.tags} jsonb_path_ops`),
  ],
);

/**
 * Task assignees. This is the join that My Tasks reads, so it is indexed both
 * ways: by task to render one, by user to list them all.
 */
export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index("task_assignees_user_idx").on(t.userId),
  ],
);

// --- Custom fields --------------------------------------------------------

/**
 * Custom Field definitions, keyed by ClickUp's globally unique field id.
 *
 * ponytail: no list-scope join table. ClickUp returns every applicable field on
 * the task itself, so task detail never needs to ask "which fields belong to
 * this list". Add the join when list-level filtering by an unset field shows up.
 */
export const customFieldDefs = pgTable("custom_field_defs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** drop_down, labels, number, date, text, url, checkbox, users, ... */
  type: text("type").notNull(),
  /** Dropdown options, number precision, and so on. Shape varies by type. */
  typeConfig: jsonb("type_config"),
  required: boolean("required").notNull().default(false),
  syncedAt: ts("synced_at").notNull().defaultNow(),
});

export const taskCustomValues = pgTable(
  "task_custom_values",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    fieldId: text("field_id").notNull(),
    /** Raw ClickUp value. Type depends on the field type; the UI reads typeConfig. */
    value: jsonb("value"),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.fieldId] }),
    index("task_custom_values_field_idx").on(t.fieldId),
  ],
);

// --- Comments -------------------------------------------------------------

export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    /** Flattened `comment_text`. Rich-text segments are not mirrored. */
    text: text("text"),
    resolved: boolean("resolved").notNull().default(false),
    replyCount: integer("reply_count").notNull().default(0),
    date: ts("date"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("comments_task_idx").on(t.taskId, t.date)],
);

// --- Write path -----------------------------------------------------------

export type OutboxOp = "update_task" | "create_task" | "create_comment" | "set_custom_field";

export type OutboxStatus = "pending" | "sending" | "done" | "failed";

/**
 * Pending writes headed for ClickUp.
 *
 * ponytail: this table is the queue. A worker claims rows with
 * `FOR UPDATE SKIP LOCKED`, which is all a single-Postgres job runner needs.
 * pg-boss would put a second queue on top of a queue. Add it if we ever need
 * cron, priorities, or fan-out that this table cannot express.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Whose token sends it. ClickUp attributes the change to this person. */
    userId: text("user_id").notNull(),
    op: text("op").$type<OutboxOp>().notNull(),
    /** The ClickUp id being written to. Null for creates until ClickUp assigns one. */
    entityId: text("entity_id"),
    payload: jsonb("payload").notNull(),
    /**
     * Client-generated id for the optimistic row. Lets the API match ClickUp's
     * response back to the placeholder the browser is already showing.
     */
    clientId: text("client_id"),
    status: text("status").$type<OutboxStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // The claim query: pending rows whose backoff has elapsed, oldest first.
    index("outbox_claim_idx").on(t.status, t.nextAttemptAt),
    index("outbox_entity_idx").on(t.entityId),
    uniqueIndex("outbox_client_id_idx").on(t.clientId),
  ],
);

// --- Sync bookkeeping -----------------------------------------------------

export type SyncScope = "list" | "team";

/**
 * Where incremental sync left off, per list.
 *
 * `lastUpdatedAt` is the newest `date_updated` we have successfully stored, and
 * it becomes the next poll's `date_updated_gt`. It is only advanced after a
 * page is committed, so a crash mid-page re-reads rather than skips.
 */
export const syncCursors = pgTable(
  "sync_cursors",
  {
    scope: text("scope").$type<SyncScope>().notNull(),
    scopeId: text("scope_id").notNull(),
    lastUpdatedAt: ts("last_updated_at"),
    lastRunAt: ts("last_run_at"),
    lastFullSyncAt: ts("last_full_sync_at"),
    /** Rising counter of consecutive failures; drives how far polling backs off. */
    failures: integer("failures").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [primaryKey({ columns: [t.scope, t.scopeId] })],
);

export const webhooks = pgTable("webhooks", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  endpoint: text("endpoint").notNull(),
  /** Verifies the X-Signature header on delivery. Encrypted like OAuth tokens. */
  ciphertext: bytea("ciphertext").notNull(),
  nonce: bytea("nonce").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// --- Shared JSON shapes ---------------------------------------------------

export interface StatusDef {
  id?: string | null;
  status: string;
  color?: string | null;
  type?: string | null;
  orderindex?: number | null;
}

export interface TaskTag {
  name: string;
  fg?: string | null;
  bg?: string | null;
}

// --- Relations ------------------------------------------------------------

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  list: one(lists, { fields: [tasks.listId], references: [lists.id] }),
  creator: one(users, { fields: [tasks.creatorId], references: [users.id] }),
  assignees: many(taskAssignees),
  customValues: many(taskCustomValues),
  comments: many(comments),
}));

export const taskAssigneesRelations = relations(taskAssignees, ({ one }) => ({
  task: one(tasks, { fields: [taskAssignees.taskId], references: [tasks.id] }),
  user: one(users, { fields: [taskAssignees.userId], references: [users.id] }),
}));

export const taskCustomValuesRelations = relations(taskCustomValues, ({ one }) => ({
  task: one(tasks, { fields: [taskCustomValues.taskId], references: [tasks.id] }),
  field: one(customFieldDefs, {
    fields: [taskCustomValues.fieldId],
    references: [customFieldDefs.id],
  }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  task: one(tasks, { fields: [comments.taskId], references: [tasks.id] }),
  user: one(users, { fields: [comments.userId], references: [users.id] }),
}));

export const listsRelations = relations(lists, ({ one, many }) => ({
  space: one(spaces, { fields: [lists.spaceId], references: [spaces.id] }),
  folder: one(folders, { fields: [lists.folderId], references: [folders.id] }),
  tasks: many(tasks),
}));

export const foldersRelations = relations(folders, ({ one, many }) => ({
  space: one(spaces, { fields: [folders.spaceId], references: [spaces.id] }),
  lists: many(lists),
}));

export const spacesRelations = relations(spaces, ({ many }) => ({
  folders: many(folders),
  lists: many(lists),
}));
