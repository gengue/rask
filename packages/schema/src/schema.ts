import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
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

/**
 * jsonb that hands the driver the value itself.
 *
 * Drizzle's built-in `jsonb` calls JSON.stringify before binding, because
 * node-postgres sends parameters as text for Postgres to cast. Bun's SQL driver
 * encodes JS values to JSON on its own, so a pre-stringified value lands as a
 * jsonb *string* instead of an object or array.
 *
 * Reads still round-trip, which is what makes it easy to miss: Drizzle parses
 * the string back on the way out. What breaks is everything else. `tags @>
 * '[{"name":"..."}]'` never matches a string, so the tag filter silently returns
 * nothing, and anything reading the column with raw SQL — the outbox drain, for
 * one — gets a string where it expected an object.
 */
const jsonb = <T>(name: string) =>
  customType<{ data: T; driverData: T }>({
    dataType: () => "jsonb",
    toDriver: (value) => value,
    /*
     * Unwrap a double-encoded value on the way out.
     *
     * Every column using this holds an object or an array, so a plain string
     * coming back means the row was written by the pre-fix code path (or by
     * something we have not found) and is JSON inside JSON. Parsing it here
     * keeps one bad row from reaching the UI as `tags.slice(...).map is not a
     * function`, which is how this surfaced. Rows are repaired in place when
     * found; this is the seatbelt, not the fix.
     */
    fromDriver: (value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    },
  })(name);

/**
 * JSON kept as text.
 *
 * The same Bun driver that encodes objects and arrays correctly binds numbers
 * and booleans as int4 and bool, which Postgres refuses to assign to a jsonb
 * column. That is fine everywhere the value is known to be a container, and
 * fatal for ClickUp Custom Field values: a number field really does send `42`,
 * and a checkbox sends `true`.
 *
 * Nothing queries inside this column — values are read whole and rendered — so
 * text costs nothing here. The day filtering by Custom Field arrives, this
 * becomes jsonb with a migration and an explicit cast.
 */
const jsonText = <T>(name: string) =>
  customType<{ data: T; driverData: string }>({
    dataType: () => "text",
    toDriver: (value) => JSON.stringify(value ?? null),
    fromDriver: (value) => (value === null ? null : JSON.parse(value)) as T,
  })(name);

/**
 * A Postgres `tsvector`, written by the database and never by us.
 *
 * Only ever generated, so there is no `toDriver`: nothing binds a value to a
 * column Postgres computes. Reads come back as the text rendering of the
 * vector, which nothing looks at — the column exists to be matched against with
 * `@@`, not to be selected.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
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
  /**
   * When this user last opened the inbox. Everything ClickUp touched on their
   * tasks after it counts as unread.
   *
   * Defaults to now rather than to null, on the column and on the backfill
   * both, so nobody's first visit is 450 unread tasks from before the feature
   * existed. Local knowledge — ClickUp has no notifications API to read a real
   * read-state from, and no way to write ours back.
   */
  inboxSeenAt: ts("inbox_seen_at").notNull().defaultNow(),
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
    statuses: jsonb<StatusDef[]>("statuses").notNull().default(sql`'[]'::jsonb`),
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
    statuses: jsonb<StatusDef[] | null>("statuses"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("lists_space_idx").on(t.spaceId), index("lists_folder_idx").on(t.folderId)],
);

/**
 * The tabs above a List: "All", "Board", every saved view, every form.
 *
 * Deliberately not the whole view object. ClickUp sends `filters`, `sorting`,
 * `columns`, `divide`, `settings` and `team_sidebar` on every view, and Rask
 * evaluates none of them — `GET /view/{id}/task` applies the filters upstream
 * and hands back the tasks that survived. Mirroring a rule nobody runs would
 * be a second representation of ClickUp's filter engine, stale the moment
 * somebody edits the view and impossible to notice was stale.
 *
 * So what is here is exactly what it takes to draw a tab and act on it:
 *
 *  - `name`, `type`, `orderindex`, `isDefault` draw the tab bar. `type` decides
 *    whether the tab opens a Rask route or ClickUp, and it is text rather than
 *    an enum because ClickUp keeps adding view types.
 *  - `groupField` is the one part of a view Rask does apply itself, since the
 *    tasks arrive already filtered but not already grouped. Stored raw, in
 *    ClickUp's vocabulary ("status", "dueDate", a Custom Field id), and mapped
 *    to Rask's grouping in the client where the fallback is visible.
 *  - `showClosed` is `filters.show_closed`, kept because it describes what the
 *    answer already contains: Rask's own show-closed toggle has to agree with
 *    the view rather than filter its rows again.
 *  - `publicUrl` is only ever set on a form, and is the only address at which a
 *    form can be opened. Every other type is addressed by id.
 *
 * That day came for Rask's own filters and this column did not grow, which is
 * worth writing down because the comment above predicted otherwise. A facet
 * that has to survive the 500-row cap is now pushed into SQL over the mirror
 * (`apps/api/src/filters.ts`) using the same `{field, op, values}` vocabulary
 * ClickUp writes its view filters in. What did not change is who evaluates a
 * *view's* filters: still ClickUp, through `GET /view/{id}/task`. Sharing a
 * vocabulary is not the same as owning the rules, and mirroring rules nobody
 * here runs would still be a second copy of ClickUp's filter engine.
 */
export const listViews = pgTable(
  "list_views",
  {
    /** ClickUp's view id: "gh-96335" for a saved view, "6-{list}-1" for a built-in. */
    id: text("id").primaryKey(),
    listId: text("list_id").notNull(),
    name: text("name").notNull(),
    /** list, board, calendar, gantt, timeline, workload, table, form, ... */
    type: text("type").notNull(),
    /** One sequence across the saved views and the built-in ones. Drives tab order. */
    orderindex: integer("orderindex"),
    /** The tab ClickUp opens the List on. Exactly one per list, or none. */
    isDefault: boolean("is_default").notNull().default(false),
    /** ClickUp's `grouping.field`, verbatim. Null on forms and conversations. */
    groupField: text("group_field"),
    /** `filters.show_closed`: whether the rows ClickUp returns include closed ones. */
    showClosed: boolean("show_closed").notNull().default(false),
    /** Forms only. forms.clickup.com, not app.clickup.com. */
    publicUrl: text("public_url"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("list_views_list_idx").on(t.listId, t.orderindex)],
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
    tags: jsonb<TaskTag[]>("tags").notNull().default(sql`'[]'::jsonb`),
    timeEstimate: bigint("time_estimate", { mode: "number" }),
    /**
     * Milliseconds tracked against the task, as ClickUp totals them.
     *
     * Read-only here, and the only piece of time tracking the mirror holds. It
     * costs nothing to keep: every task payload already carries it. Rask does
     * start and stop timers now, but never through this column — those writes
     * go straight to ClickUp and come back in the next read of the task. See
     * `apps/api/src/time.ts` for why none of the rest of it is mirrored.
     */
    timeSpent: bigint("time_spent", { mode: "number" }),
    points: real("points"),
    url: text("url"),

    /**
     * The description, tokenised, for search.
     *
     * Generated and stored rather than computed by an expression index, which
     * is a 23MB column on the 147,000-task mirror and buys the worst case
     * rather than the common one. Both forms let a GIN index answer
     * `description @@ query`; the difference is what happens when the planner
     * decides not to use it. `ORDER BY date_updated DESC LIMIT 12` over a
     * two-word query is such a case — it walks the date index expecting to fill
     * the limit early — and with an expression index every row it walks pays
     * for a `to_tsvector` over a description that can be 31kB. Measured on the
     * mirror: 93ms as an expression index, 5.5ms as a stored column.
     *
     * `simple`, not `english`: the workspace writes tasks in Spanish, German
     * and English, and an English stemmer applied to Spanish is not a
     * translation, it is damage. `simple` also keeps stop words, which is what
     * makes "the" findable in a title that is a quotation.
     *
     * The name is indexed by trigram instead and is deliberately not in here —
     * see `tasks_name_trgm_idx`.
     */
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(description, ''))`,
    ),

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
    // The API's change feed polls this to decide what to push over SSE.
    index("tasks_synced_idx").on(t.syncedAt),
    index("tasks_parent_idx").on(t.parentId),
    // Tag filtering is `tags @> '[{"name":"..."}]'`, which needs jsonb_path_ops.
    index("tasks_tags_idx").using("gin", sql`${t.tags} jsonb_path_ops`),

    /**
     * The list view, exactly.
     *
     * Partial on the rows a view can show, because hiding closed tasks
     * otherwise defeats the due-date index and walks the table: the query was
     * 40.6ms with "Rows Removed by Filter: 54,246" before this existed and
     * 0.15ms after. Being partial it is also 1.2MB rather than the 2.5MB the
     * same three columns cost over every row.
     *
     * The predicate has to be written out rather than referenced because
     * Postgres matches a partial index by proving the query's WHERE implies the
     * index's; `listTasks` emits these three conditions verbatim for that
     * reason.
     */
    index("tasks_open_by_list_v2_idx")
      .on(t.listId, t.dueDate, t.dateUpdated.desc())
      .where(
        sql`deleted_at is null and archived = false and (status_type is null or status_type <> all (array['closed', 'done']))`,
      ),

    /**
     * Substring search on the two short identifying columns.
     *
     * Trigram rather than full text, and the split is the point: a name is a
     * handful of words where somebody types the middle of one ("auth" for
     * "reauthorize"), and a custom id is a token where they type the number
     * without the prefix. Neither is prose, and word-boundary matching answers
     * the wrong question on both. Descriptions are prose, and get `tsvector`.
     *
     * Both columns need one. With only `name` indexed the OR falls back to a
     * scan and a miss gets slower than it was with no index at all: 38ms for a
     * hit and 51ms for a miss before, everything measured under 1.5ms after.
     */
    index("tasks_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
    index("tasks_custom_id_trgm_idx").using("gin", sql`${t.customId} gin_trgm_ops`),

    /** Description search. See `searchVector` for why the column is stored. */
    index("tasks_search_idx").using("gin", t.searchVector),
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

/**
 * Files attached to a task.
 *
 * Only `GET /task/{id}` carries these, so they arrive on a different schedule
 * from the rest of the row: the list poll that refreshes a task's name and
 * status says nothing about its files, and ingest has to leave them alone
 * rather than read the silence as "there are none".
 *
 * The URLs are mirrored rather than rebuilt. ClickUp's attachment CDN is public
 * — no token, no signature — so the browser loads these directly and there is
 * no proxy in the path. `url` is what an `<img>` gets; `urlWithQuery` carries
 * the `?view=open` that makes the CDN serve a PDF inline instead of downloading
 * it, and is what a link points at.
 *
 * All three thumbnails are kept because they are three different things
 * depending on the file type, and which one is worth showing is a UI decision
 * rather than an ingest decision. Today the grid reads `thumbnailMedium`:
 * `thumbnailSmall` is roughly 80px on the long edge, which is a stripe, not a
 * picture.
 */
export const taskAttachments = pgTable(
  "task_attachments",
  {
    /** ClickUp's "<uuid>.<ext>". Stable, so a re-read updates rather than duplicates. */
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    title: text("title"),
    extension: text("extension"),
    mimetype: text("mimetype"),
    /** Bytes. int64 on the wire, and a 4GB upload would overflow an integer. */
    size: bigint("size", { mode: "number" }),
    date: ts("date"),
    thumbnailSmall: text("thumbnail_small"),
    thumbnailMedium: text("thumbnail_medium"),
    thumbnailLarge: text("thumbnail_large"),
    url: text("url"),
    urlWithQuery: text("url_with_query"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("task_attachments_task_idx").on(t.taskId, t.date)],
);

/**
 * Checklists on a task, and their line items.
 *
 * These arrive on the same schedule as attachments and for the same reason:
 * only `GET /task/{id}` carries a `checklists` array, so a list poll says
 * nothing about them and ingest has to leave them alone rather than read the
 * silence as "there are none".
 *
 * ClickUp reports `resolved` and `unresolved` counts on the checklist. They are
 * not mirrored, because they are the items counted — a stored copy would be a
 * second number to keep in step every time somebody ticks a box, and the query
 * that renders the list already holds the items.
 */
export const taskChecklists = pgTable(
  "task_checklists",
  {
    /** ClickUp's uuid, not a task-scoped index, so it survives a reorder. */
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    orderindex: integer("orderindex"),
    /** ClickUp sends a bare user id here, not the user object it sends elsewhere. */
    creatorId: text("creator_id"),
    dateCreated: ts("date_created"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("task_checklists_task_idx").on(t.taskId, t.orderindex)],
);

export const checklistItems = pgTable(
  "checklist_items",
  {
    id: text("id").primaryKey(),
    /**
     * Cascades, unlike most of the mirror.
     *
     * The usual rule — no foreign key a partial resync could arrive out of
     * order against — does not bite here: items only ever arrive inside their
     * checklist, in one payload, so there is no ordering to lose. The cascade
     * is what makes replacing a task's checklists a single delete.
     */
    checklistId: text("checklist_id")
      .notNull()
      .references(() => taskChecklists.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    orderindex: integer("orderindex"),
    assigneeId: text("assignee_id"),
    resolved: boolean("resolved").notNull().default(false),
    /** Set on an item nested under another. ClickUp's UI allows one level. */
    parentItemId: text("parent_item_id"),
    dateCreated: ts("date_created"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("checklist_items_checklist_idx").on(t.checklistId, t.orderindex)],
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
  typeConfig: jsonb<unknown>("type_config"),
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
    value: jsonText<unknown>("value"),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.fieldId] }),
    index("task_custom_values_field_idx").on(t.fieldId),
  ],
);

// --- Comments -------------------------------------------------------------

/**
 * Task comments and their replies, in one table.
 *
 * ClickUp threads are exactly one level deep: a comment has replies, a reply
 * has none. Storing both here with a self-reference keeps the ingest path,
 * the write path and the detail query single-shaped, and the "one level"
 * rule lives in the UI where it is visible rather than in two tables.
 *
 * `parentCommentId` is deliberately not a foreign key onto this table's own
 * id. Replies arrive from `GET /comment/{id}/reply`, which can land before the
 * parent's page of `GET /task/{id}/comment` does, and a partial resync must
 * never be blocked by arrival order.
 */
export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** Null for a top-level comment, the parent's id for a threaded reply. */
    parentCommentId: text("parent_comment_id"),
    /** Who wrote it. This is what decides who may edit or delete it. */
    userId: text("user_id"),
    /**
     * ClickUp's flattened `comment_text`, byte for byte.
     *
     * This is what the write path sends back on an edit or a resolve, so it
     * must stay exactly what ClickUp would have sent us. Never the rendered
     * body: posting markdown into someone else's comment is not an edit, it is
     * vandalism.
     */
    text: text("text"),
    /**
     * The rich `comment` array, rendered to markdown at ingest.
     *
     * Null when ClickUp sent no segments and on a comment Rask has not heard
     * back about yet, which is why the UI reads `markdown ?? text` — a locally
     * authored comment is already written in this dialect. Text, not jsonb:
     * nothing queries inside it, and there is no container to make jsonb worth
     * the risk described above `jsonText`.
     */
    markdown: text("markdown"),
    /**
     * ClickUp's `comment` array, kept verbatim.
     *
     * Not for rendering — `markdown` is that. This exists so resolving a
     * comment can put the body back exactly as it arrived. ClickUp's
     * PUT /comment requires `comment_text` and replaces the body with it, so
     * resolving a comment that held a screenshot used to delete the screenshot
     * upstream.
     */
    segments: jsonb<unknown[] | null>("segments"),
    resolved: boolean("resolved").notNull().default(false),
    replyCount: integer("reply_count").notNull().default(0),
    date: ts("date"),
    /**
     * When we last rewrote the body. Local knowledge: ClickUp's v2 comment
     * payload has no edit timestamp, so this is only ever set by our own write
     * path and never overwritten by ingest. It exists so a body that no longer
     * matches what people replied to says so.
     */
    editedAt: ts("edited_at"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [
    index("comments_task_idx").on(t.taskId, t.date),
    // The detail query splits a task's comments into threads by this column.
    index("comments_parent_idx").on(t.parentCommentId, t.date),
  ],
);

// --- Write path -----------------------------------------------------------

export type OutboxOp =
  | "add_tag"
  | "remove_tag"
  | "update_task"
  | "create_task"
  | "create_comment"
  | "update_comment"
  | "delete_comment"
  | "set_custom_field"
  | "create_checklist"
  | "update_checklist"
  | "delete_checklist"
  | "create_checklist_item"
  | "update_checklist_item"
  | "delete_checklist_item";

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
    /**
     * The task this write belongs to. Null for creates until ClickUp assigns
     * one. Comment ops put the task id here too, not the comment id: the task
     * is what gets refetched to repair the mirror after a rejection, and it is
     * what the API needs in order to push the repaired detail to the author.
     */
    entityId: text("entity_id"),
    payload: jsonb<Record<string, unknown>>("payload").notNull(),
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

/**
 * The webhooks Rask has registered with ClickUp.
 *
 * One row per live registration, which in practice means one row. The table
 * exists so a restart re-adopts the webhook it already made instead of adding
 * another one every boot, and so the receiving route has a secret to verify
 * against without the secret ever being in the environment.
 */
export const webhooks = pgTable("webhooks", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  endpoint: text("endpoint").notNull(),
  /**
   * Whose token registered it.
   *
   * `GET /team/{id}/webhook` only answers with webhooks created by the calling
   * token, so this is not bookkeeping — it is the only way to find the thing
   * again. Managing it under any other token reads as "there is no webhook"
   * and registers a second one.
   */
  userId: text("user_id"),
  /** Verifies the X-Signature header on delivery. Encrypted like OAuth tokens. */
  ciphertext: bytea("ciphertext").notNull(),
  nonce: bytea("nonce").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/**
 * Tasks a webhook says have changed, waiting to be read back from ClickUp.
 *
 * ponytail: the table is the queue, exactly like `outbox`. The API process
 * takes the delivery and the worker owns every call to ClickUp, so the hand-off
 * has to cross a process boundary and survive the rolling deploy that restarts
 * the API mid-burst. Doing the fetch inline in the request handler instead
 * would put unbounded outbound HTTP on the one route with no session, and lose
 * whatever was in flight on every restart.
 *
 * Keyed by task id rather than by delivery, and that is the whole design. A
 * ClickUp event says only *which* task changed, never what, so the response to
 * every event is identical: go and read the task. Two events for one task
 * therefore collapse into one row and one request, and the order they arrived
 * in cannot matter, because the fetch returns whatever ClickUp holds at the
 * moment it runs rather than whatever the event described. Duplicates,
 * reordering and bursts all reduce to the same cheap upsert.
 *
 * No foreign key onto `tasks`: a `taskCreated` event routinely names a task the
 * mirror has never heard of, which is the point of hearing about it.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    taskId: text("task_id").primaryKey(),
    /** ClickUp's event name. Only `taskDeleted` is acted on differently. */
    event: text("event").notNull(),
    /** Which registration delivered it. Kept for tracing a bad webhook, not read. */
    webhookId: text("webhook_id"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    /** Rising on each failed read-back. Past the cap the row is dropped and polling repairs it. */
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  },
  // The claim query: due rows, oldest first.
  (t) => [index("webhook_events_claim_idx").on(t.nextAttemptAt, t.receivedAt)],
);

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
