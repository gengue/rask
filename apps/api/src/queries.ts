import { DOC_PARENT, flattenMentions } from "@rask/clickup-client";
import {
  checklistItems,
  commentMentions,
  comments,
  customFieldDefs,
  type Db,
  docs,
  folders,
  lists,
  listViews,
  type StatusDef,
  spaces,
  taskAssignees,
  taskAttachments,
  taskChecklists,
  taskCustomValues,
  tasks,
  users,
  viewMemberships,
} from "@rask/schema";
import { and, asc, desc, eq, gt, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { type Clause, filterConditions, textCondition } from "./filters.ts";

/**
 * Read models for the UI.
 *
 * Everything the list view renders is fetched in one round trip, assignees
 * included. A list of 500 tasks that fires 500 assignee queries is the exact
 * slowness Rask exists to avoid.
 */

export interface Assignee {
  id: string;
  username: string | null;
  initials: string | null;
  color: string | null;
  avatar: string | null;
}

/**
 * Correlated aggregate: one extra index scan per row, no N+1, no GROUP BY.
 *
 * The correlation is written `"tasks"."id"` and has to stay that way. Drizzle
 * only qualifies a bare `${tasks.id}` when the outer query has a join, and this
 * subquery joins `users` — which has an `id` of its own. Unqualified, the
 * predicate silently rebinds to `users.id`, so `ta.task_id = u.id` matches
 * nothing and every row comes back with no assignees at all. The task list
 * happens to join `lists`, so it was right; the subtask list joins nothing and
 * had drawn "Unassigned" next to every subtask since the panel shipped.
 */
const assigneesJson = sql<Assignee[]>`(
  select coalesce(
    json_agg(
      json_build_object(
        'id', u.id,
        'username', u.username,
        'initials', u.initials,
        'color', u.color,
        'avatar', u.profile_picture
      )
      order by u.username
    ),
    '[]'::json
  )
  from ${taskAssignees} ta
  join ${users} u on u.id = ta.user_id
  where ta.task_id = ${tasks}.${sql.identifier("id")}
)`;

/**
 * The values of the Custom Fields a filter mentions, as `{fieldId: rawJson}`.
 *
 * Null — not `{}` — when the query asked for none, and the difference carries
 * meaning: the browser evaluates the same filter locally, and a row that has no
 * values because nobody asked for any must not be shown to satisfy a
 * `NOT ANY` clause it was never tested against.
 *
 * The values stay as the JSON text the column holds rather than being decoded,
 * so the comparison the browser makes is the same string comparison this file
 * hands to Postgres.
 */
function customValuesJson(fieldIds: readonly string[]): SQL<Record<string, string> | null> {
  if (fieldIds.length === 0) return sql<Record<string, string> | null>`null::json`;
  const wanted = sql.join(
    fieldIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql<Record<string, string> | null>`(
    select coalesce(json_object_agg(v.field_id, v.value), '{}'::json)
    from ${taskCustomValues} v
    where v.task_id = ${tasks.id} and v.field_id in (${wanted})
  )`;
}

const taskColumns = {
  id: tasks.id,
  customId: tasks.customId,
  name: tasks.name,
  status: tasks.status,
  statusColor: tasks.statusColor,
  statusType: tasks.statusType,
  priority: tasks.priority,
  dueDate: tasks.dueDate,
  startDate: tasks.startDate,
  dateUpdated: tasks.dateUpdated,
  dateCreated: tasks.dateCreated,
  listId: tasks.listId,
  spaceId: tasks.spaceId,
  parentId: tasks.parentId,
  tags: tasks.tags,
  url: tasks.url,
  listName: lists.name,
  deletedAt: tasks.deletedAt,
  archived: tasks.archived,
  assignees: assigneesJson.as("assignees"),
};

export type TaskRow = Awaited<ReturnType<typeof listTasks>>[number];

export interface TaskFilters {
  listId?: string;
  spaceId?: string;
  assigneeId?: string;
  statuses?: string[];
  tag?: string;
  /**
   * The filter the user built, in ClickUp's `{field, op, values}` vocabulary.
   *
   * ANDed with everything above. The plain parameters stay because they are the
   * documented shape of `GET /api/tasks` and because "this list" and "closed
   * tasks too" are properties of the view rather than of the filter — a list is
   * where you are, not something you filtered down to.
   */
  clauses?: Clause[];
  /**
   * Custom Field ids whose values should ride along on each row.
   *
   * Only the fields the active filter mentions. The browser evaluates the same
   * filter over the rows it holds so an edit under the cursor takes effect
   * without a round trip, and a Custom Field is the one thing it cannot answer
   * from a task alone.
   */
  fieldIds?: string[];
  /**
   * An explicit set of tasks, in place of a predicate.
   *
   * This is how a view is read: ClickUp decided which tasks pass the view's
   * filters, and the mirror is asked for exactly those rows rather than for a
   * query that tries to mean the same thing.
   */
  taskIds?: string[];
  /** Closed and done tasks are hidden unless asked for. */
  includeClosed?: boolean;
  /** Only rows the mirror touched after this instant. Drives the SSE feed. */
  syncedAfter?: Date;
  /**
   * Only tasks ClickUp changed after this instant, newest change first. Drives
   * the inbox.
   *
   * ClickUp's clock, not ours: `synced_at` says when we heard, which moves for
   * a nightly resync that changed nothing and would read as activity that
   * never happened. `date_updated` is the moment a person did something.
   */
  updatedSince?: Date;
  limit?: number;
}

/**
 * One row more than asked for.
 *
 * The caller drops the extra and reports "there is more" from its presence.
 * A COUNT(*) would answer the same question and cost a second scan; this costs
 * one row.
 */
export async function listTasks(db: Db, filters: TaskFilters) {
  const where: Array<SQL | undefined> = [];

  if (!filters.syncedAfter) {
    // The change feed must see deletions and archives; normal views must not.
    where.push(isNull(tasks.deletedAt), eq(tasks.archived, false));
  } else {
    where.push(gt(tasks.syncedAt, filters.syncedAfter));
  }

  if (filters.taskIds) {
    // An empty set is a real answer — a view whose filters match nothing — and
    // `in ()` is not valid SQL, so say false rather than dropping the clause.
    where.push(filters.taskIds.length > 0 ? inArray(tasks.id, filters.taskIds) : sql`false`);
  }
  if (filters.listId) where.push(eq(tasks.listId, filters.listId));
  if (filters.spaceId) where.push(eq(tasks.spaceId, filters.spaceId));
  if (filters.statuses?.length) where.push(inArray(tasks.status, filters.statuses));
  if (filters.tag) {
    // Built server-side from a plain text parameter rather than a stringified
    // literal: a JSON string bound as a parameter arrives as a jsonb *string*,
    // and containment against a string matches nothing. Uses the GIN
    // jsonb_path_ops index on tasks.tags.
    where.push(
      sql`${tasks.tags} @> jsonb_build_array(jsonb_build_object('name', ${filters.tag}::text))`,
    );
  }
  if (!filters.includeClosed) {
    where.push(
      /*
       * Spelled out rather than built from CLOSED_STATUS_TYPES on purpose. This
       * predicate has to match `tasks_open_by_list_v2_idx` textually for the
       * planner to use the partial index; bound parameters would not match, and
       * the list query goes from 0.15ms back to 40ms. Change one, change both.
       */
      or(isNull(tasks.statusType), sql`${tasks.statusType} not in ('closed', 'done')`) ?? sql`true`,
    );
  }
  if (filters.assigneeId) {
    where.push(sql`exists (
      select 1 from ${taskAssignees} ta
      where ta.task_id = ${tasks.id} and ta.user_id = ${filters.assigneeId}
    )`);
  }

  if (filters.updatedSince) where.push(gt(tasks.dateUpdated, filters.updatedSince));

  where.push(...filterConditions(filters.clauses ?? []));

  return db
    .select({ ...taskColumns, customValues: customValuesJson(filters.fieldIds ?? []) })
    .from(tasks)
    .leftJoin(lists, eq(lists.id, tasks.listId))
    .where(and(...where))
    .orderBy(
      /*
       * The inbox asks a different question and needs a different order.
       *
       * Everywhere else "what should I do next" wins, so due date leads. The
       * inbox asks "what happened", and there the answer is chronological —
       * and it has to be, because the limit truncates: ordered by due date, a
       * page of 500 would drop the most recent changes rather than the oldest
       * ones, and the feed would silently miss exactly what it exists to show.
       */
      ...(filters.updatedSince
        ? [desc(tasks.dateUpdated)]
        : [
            // Overdue and soon-due first, then newest activity. Nulls last so a
            // task with no due date never outranks one that is actually due.
            sql`${tasks.dueDate} asc nulls last`,
            desc(tasks.dateUpdated),
          ]),
    )
    .limit((filters.limit ?? 500) + 1);
}

/**
 * Why a task is in your inbox, when the reason is something somebody said.
 *
 * Three signals, strongest first, and they are three because they fail in
 * different places rather than because more is better:
 *
 *  - `mention` is the one you were addressed by name in. It reads
 *    `comment_mentions`, which ClickUp fills in about nine times in ten.
 *  - `assigned` is ClickUp's own "this comment is for you". No parsing, no gap.
 *  - `comment` is anything said on a task you are assigned to. The blunt one,
 *    and the reason the mention gap mostly does not matter: a mention you were
 *    never told about usually lands on a task that is already yours.
 *
 * Your own comments are excluded throughout. Being notified about what you just
 * wrote is how a feed teaches somebody to stop reading it.
 */
export type CommentReasonKind = "mention" | "assigned" | "comment";

export interface CommentReason {
  taskId: string;
  commentId: string;
  kind: CommentReasonKind;
  authorId: string | null;
  authorName: string | null;
  authorAvatar: string | null;
  excerpt: string;
  /** When the comment on the row was written. */
  at: Date | null;
  /**
   * When the newest notable comment on this task was written, ranked or not.
   *
   * Separate from `at` because the row shows the *strongest* reason and unread
   * is about the *latest* one. A mention from Tuesday followed by an "ok" this
   * morning still shows Tuesday's line — and is still something that happened
   * since you last looked. Reading unread off `at` marks that task read while
   * the conversation is moving.
   */
  latestAt: Date | null;
}

/** How much of a comment the feed shows before you have to open the task. */
const EXCERPT_CHARS = 160;

/**
 * The newest notable comment per task, strongest reason first.
 *
 * Ranked by kind before date on purpose. A mention followed by somebody else's
 * "ok" is still a mention, and showing the "ok" would bury the only line in the
 * thread written at you. Within one kind the newest wins, which is what makes
 * the row read as the latest thing that happened.
 */
export async function notableComments(
  db: Db,
  userId: string,
  since: Date,
  limit = 500,
): Promise<CommentReason[]> {
  const mine = sql`exists (
    select 1 from ${taskAssignees} ta
    where ta.task_id = ${comments.taskId} and ta.user_id = ${userId}
  )`;

  const mentioned = sql`exists (
    select 1 from ${commentMentions} cm
    where cm.comment_id = ${comments.id} and cm.user_id = ${userId}
  )`;

  const kind = sql<CommentReasonKind>`case
    when ${mentioned} then 'mention'
    when ${comments.assigneeId} = ${userId} then 'assigned'
    else 'comment'
  end`;

  // 1, 2, 3 rather than the words, so the ordering is the ranking and Postgres
  // is not sorting strings that happen to be alphabetical by accident.
  const rank = sql`case
    when ${mentioned} then 1
    when ${comments.assigneeId} = ${userId} then 2
    else 3
  end`;

  const rows = await db
    .selectDistinctOn([comments.taskId], {
      taskId: comments.taskId,
      commentId: comments.id,
      kind,
      authorId: comments.userId,
      authorName: users.username,
      authorAvatar: users.profilePicture,
      body: sql<string | null>`coalesce(${comments.markdown}, ${comments.text})`,
      at: comments.date,
      // Computed before DISTINCT ON picks a row, so it is the maximum across
      // everything notable on the task rather than across the one row kept.
      latestAt: sql<Date | null>`max(${comments.date}) over (partition by ${comments.taskId})`,
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.userId))
    .where(
      and(
        gt(comments.date, since),
        // `is distinct from` rather than `<>`: a comment with no author is
        // somebody, just not somebody ClickUp named, and `null <> $1` is null.
        sql`${comments.userId} is distinct from ${userId}`,
        or(mentioned, eq(comments.assigneeId, userId), mine),
      ),
    )
    .orderBy(comments.taskId, rank, desc(comments.date))
    .limit(limit);

  return rows.map((row) => ({
    taskId: row.taskId,
    commentId: row.commentId,
    kind: row.kind,
    authorId: row.authorId,
    authorName: row.authorName,
    authorAvatar: row.authorAvatar,
    // Flattened, because the stored markdown spells a mention
    // `@[Name](clickup://user/123)` and one line of a feed has no room to
    // render it. Trimmed here rather than in the browser so the payload is a
    // feed's worth of text and not a workspace's.
    excerpt: excerpt(row.body),
    at: row.at,
    latestAt: row.latestAt,
  }));
}

function excerpt(body: string | null): string {
  const flat = flattenMentions(body ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}\u2026` : flat;
}

export async function getTaskDetail(db: Db, taskId: string) {
  const [task] = await db
    .select({
      ...taskColumns,
      description: tasks.description,
      creatorId: tasks.creatorId,
      folderId: tasks.folderId,
      timeEstimate: tasks.timeEstimate,
      timeSpent: tasks.timeSpent,
      points: tasks.points,
      dateClosed: tasks.dateClosed,
    })
    .from(tasks)
    .leftJoin(lists, eq(lists.id, tasks.listId))
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!task) return null;

  const [taskComments, fields, statuses, attachments, checklists, subtasks, parent] =
    await Promise.all([
      listComments(db, taskId),

      /*
       * Every definition, left-joined to this task's values — not the values
       * inner-joined to their definitions, which is what this was.
       *
       * A row in `task_custom_values` only exists once somebody has set the
       * field, so driving from there meant a task showed exactly the fields it
       * already had. The panel's own promise — "expanded, the blanks come too,
       * because that is the only way to set one" — could not be kept: there
       * were no blanks, and a task nobody had touched offered nothing to fill
       * in. Every field is a blank until it isn't.
       */
      db
        .select({
          id: customFieldDefs.id,
          name: customFieldDefs.name,
          type: customFieldDefs.type,
          typeConfig: customFieldDefs.typeConfig,
          value: taskCustomValues.value,
        })
        .from(customFieldDefs)
        .leftJoin(
          taskCustomValues,
          and(
            eq(taskCustomValues.fieldId, customFieldDefs.id),
            eq(taskCustomValues.taskId, taskId),
          ),
        )
        // Same reason as the comments below: names are not unique, ids are.
        .orderBy(asc(customFieldDefs.name), asc(customFieldDefs.id)),

      statusesForList(db, task.listId),

      listAttachments(db, taskId),

      listChecklists(db, taskId),

      listSubtasks(db, taskId),

      task.parentId ? findTaskRef(db, task.parentId) : null,
    ]);

  return {
    ...task,
    comments: taskComments,
    customFields: fields,
    statuses,
    attachments,
    checklists,
    subtasks,
    parent,
  };
}

export interface TaskRef {
  id: string;
  customId: string | null;
  name: string;
  status: string | null;
  statusColor: string | null;
  statusType: string | null;
  listId: string;
  dueDate: Date | null;
  timeEstimate: number | null;
  timeSpent: number | null;
  assignees: Assignee[];
}

const taskRefColumns = {
  id: tasks.id,
  customId: tasks.customId,
  name: tasks.name,
  status: tasks.status,
  statusColor: tasks.statusColor,
  statusType: tasks.statusType,
  listId: tasks.listId,
  dueDate: tasks.dueDate,
  timeEstimate: tasks.timeEstimate,
  timeSpent: tasks.timeSpent,
  assignees: assigneesJson.as("assignees"),
};

/**
 * Enough of a task to render one line of it and link to it.
 *
 * Due date, estimate and tracked time ride along because the subtask list can
 * be asked to show them. They are three scalars on a row the query was already
 * reading, so which of them a reader wants stays the browser's business rather
 * than a second endpoint or a second round trip.
 *
 * Deliberately not `getTaskDetail`: a parent with four subtasks would otherwise
 * fetch four descriptions, four comment threads and four checklists to draw
 * four rows.
 */
export async function findTaskRef(db: Db, taskId: string): Promise<TaskRef | null> {
  const [row] = await db.select(taskRefColumns).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row ?? null;
}

/**
 * A task's subtasks.
 *
 * Closed ones are included. A parent's own detail is where you go to find out
 * whether the pieces are done, so hiding the done ones would answer the
 * opposite of the question being asked — unlike a list view, where closed rows
 * are noise.
 */
export async function listSubtasks(db: Db, taskId: string): Promise<TaskRef[]> {
  return db
    .select(taskRefColumns)
    .from(tasks)
    .where(and(eq(tasks.parentId, taskId), isNull(tasks.deletedAt), eq(tasks.archived, false)))
    .orderBy(asc(tasks.orderindex), asc(tasks.dateCreated), asc(tasks.id));
}

export interface ChecklistItemRow {
  id: string;
  name: string;
  resolved: boolean;
  assigneeId: string | null;
  parentItemId: string | null;
}

export interface ChecklistRow {
  id: string;
  name: string;
  items: ChecklistItemRow[];
}

/**
 * A task's checklists with their items, in ClickUp's own order.
 *
 * Two queries and a group in memory rather than a json_agg: a task has a
 * handful of checklists holding a handful of items each, and the flat rows are
 * what the tests read.
 *
 * Items are ordered by `orderindex` with the id as a tiebreak. A locally
 * created item has no orderindex yet — ClickUp assigns it — and nulls sort last,
 * which puts a just-typed item at the bottom of its list, where it was typed.
 */
export async function listChecklists(db: Db, taskId: string): Promise<ChecklistRow[]> {
  const [lists, items] = await Promise.all([
    db
      .select({ id: taskChecklists.id, name: taskChecklists.name })
      .from(taskChecklists)
      .where(eq(taskChecklists.taskId, taskId))
      .orderBy(
        asc(taskChecklists.orderindex),
        asc(taskChecklists.dateCreated),
        asc(taskChecklists.id),
      ),

    db
      .select({
        id: checklistItems.id,
        checklistId: checklistItems.checklistId,
        name: checklistItems.name,
        resolved: checklistItems.resolved,
        assigneeId: checklistItems.assigneeId,
        parentItemId: checklistItems.parentItemId,
      })
      .from(checklistItems)
      .innerJoin(taskChecklists, eq(taskChecklists.id, checklistItems.checklistId))
      .where(eq(taskChecklists.taskId, taskId))
      .orderBy(sql`${checklistItems.orderindex} asc nulls last`, asc(checklistItems.id)),
  ]);

  return lists.map((list) => ({
    id: list.id,
    name: list.name,
    items: items
      .filter((item) => item.checklistId === list.id)
      .map(({ checklistId: _checklistId, ...item }) => item),
  }));
}

export interface AttachmentRow {
  id: string;
  title: string | null;
  extension: string | null;
  mimetype: string | null;
  size: number | null;
  date: Date | null;
  thumbnailSmall: string | null;
  thumbnailMedium: string | null;
  url: string | null;
  urlWithQuery: string | null;
}

/**
 * A task's files, oldest first, the order they were added in.
 *
 * `thumbnailLarge` stays in the mirror and out of the response: it is a 1600px
 * render nothing shows, and a URL the client has no use for is payload for
 * nothing.
 */
export async function listAttachments(db: Db, taskId: string): Promise<AttachmentRow[]> {
  return db
    .select({
      id: taskAttachments.id,
      title: taskAttachments.title,
      extension: taskAttachments.extension,
      mimetype: taskAttachments.mimetype,
      size: taskAttachments.size,
      date: taskAttachments.date,
      thumbnailSmall: taskAttachments.thumbnailSmall,
      thumbnailMedium: taskAttachments.thumbnailMedium,
      url: taskAttachments.url,
      urlWithQuery: taskAttachments.urlWithQuery,
    })
    .from(taskAttachments)
    .where(eq(taskAttachments.taskId, taskId))
    .orderBy(asc(taskAttachments.date), asc(taskAttachments.id));
}

export interface CommentRow {
  id: string;
  parentCommentId: string | null;
  text: string | null;
  /** The rich body rendered to markdown, or null when ClickUp sent none. */
  markdown: string | null;
  date: Date | null;
  editedAt: Date | null;
  resolved: boolean;
  replyCount: number;
  userId: string | null;
  username: string | null;
  initials: string | null;
  color: string | null;
  avatar: string | null;
}

export interface CommentThread extends CommentRow {
  replies: CommentRow[];
}

/**
 * A task's conversation, threaded.
 *
 * One query for the whole tree rather than one per thread: a task has tens of
 * comments, not thousands, and the nesting is a single level, so grouping in
 * memory costs less than the round trips would.
 *
 * A reply whose parent is not mirrored yet is promoted to the top level rather
 * than dropped. Comments are paginated and threads are not, so that ordering
 * is reachable, and a comment that exists but is invisible is worse than one
 * shown in the wrong place.
 */
export async function listComments(db: Db, taskId: string): Promise<CommentThread[]> {
  const rows = await db
    .select({
      id: comments.id,
      parentCommentId: comments.parentCommentId,
      text: comments.text,
      markdown: comments.markdown,
      /**
       * Whether an inline edit can round-trip.
       *
       * ClickUp's PUT replaces the body and all we could send back for a rich
       * comment is its flattened text, so a screenshot or a table would be
       * deleted by the act of editing. Those keep their Open in ClickUp link
       * instead of an edit control.
       */
      editable: sql<boolean>`(
        ${comments.segments} is null
        or not exists (
          select 1 from jsonb_array_elements(${comments.segments}) seg
          where seg ? 'type' and seg ->> 'type' <> 'tag'
        )
      )`.as("editable"),
      date: comments.date,
      editedAt: comments.editedAt,
      resolved: comments.resolved,
      replyCount: comments.replyCount,
      userId: comments.userId,
      username: users.username,
      initials: users.initials,
      color: users.color,
      avatar: users.profilePicture,
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.userId))
    .where(eq(comments.taskId, taskId))
    /*
     * The id breaks the tie, so the order is the same on every read.
     *
     * Two comments can share a `date` — a bot posting a batch lands them in the
     * same millisecond — and Postgres is then free to return them in either
     * order. The open panel compares the detail it is handed against the one it
     * is already showing and renders nothing when they match; an order that
     * flaps makes every one of those comparisons a difference, and the panel
     * rebuilds every 30s with nothing to show for it.
     */
    .orderBy(asc(comments.date), asc(comments.id));

  const threads = new Map<string, CommentThread>();
  for (const row of rows) {
    if (!row.parentCommentId) threads.set(row.id, { ...row, replies: [] });
  }
  for (const row of rows) {
    if (!row.parentCommentId) continue;
    const parent = threads.get(row.parentCommentId);
    if (parent) parent.replies.push(row);
    else threads.set(row.id, { ...row, replies: [] });
  }

  return [...threads.values()].sort(byDate);
}

function byDate(a: { date: Date | null }, b: { date: Date | null }): number {
  return (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0);
}

export interface ListViewRow {
  id: string;
  /**
   * The List the view hangs off, or null when it hangs off something bigger.
   *
   * Every mirrored view has one — `list_views` is keyed by it. Null only ever
   * comes from a view read straight from ClickUp, which is how Workspace-,
   * Space- and Folder-level views arrive: they have no List, so there is none
   * to attribute their rows to and nothing to register for polling.
   */
  listId: string | null;
  name: string;
  type: string;
  isDefault: boolean;
  groupField: string | null;
  showClosed: boolean;
  publicUrl: string | null;
}

const listViewColumns = {
  id: listViews.id,
  listId: listViews.listId,
  name: listViews.name,
  type: listViews.type,
  isDefault: listViews.isDefault,
  groupField: listViews.groupField,
  showClosed: listViews.showClosed,
  publicUrl: listViews.publicUrl,
};

/**
 * A List's tabs, in the order ClickUp draws them.
 *
 * Three rules, and `orderindex` is only the last of them. That is not what the
 * field looks like, which is why this is spelled out: sorting the views of list
 * 901516038590 by orderindex alone gives Board, Ventura AI, All, … and ClickUp
 * draws Channel, All, Board, Ventura AI, ….
 *
 *  1. The chat view leads. ClickUp lifts it out of the row entirely, labels it
 *     "Channel" and puts a divider after it.
 *  2. The default view is next, wherever its orderindex falls. On list
 *     5345534 the default is a dashboard at orderindex 90, behind sixty other
 *     views, and ClickUp still draws it first.
 *  3. Everything else by orderindex, which is one sequence across the saved
 *     views and the built-in ones. The id breaks ties — ClickUp has its own
 *     tiebreak and it is not the id, but a tab bar that reshuffles between two
 *     reads of the same list is worse than one whose ties are in the wrong
 *     order.
 *
 * All three are observed rather than documented: the published schema for
 * GetListViews does not mention `required_views` or `default_view` at all.
 */
export async function listViewsFor(db: Db, listId: string): Promise<ListViewRow[]> {
  return db
    .select(listViewColumns)
    .from(listViews)
    .where(eq(listViews.listId, listId))
    .orderBy(
      sql`(${listViews.type} = 'conversation') desc`,
      desc(listViews.isDefault),
      sql`${listViews.orderindex} asc nulls last`,
      asc(listViews.id),
    );
}

export async function findListView(db: Db, viewId: string): Promise<ListViewRow | null> {
  const [row] = await db
    .select(listViewColumns)
    .from(listViews)
    .where(eq(listViews.id, viewId))
    .limit(1);
  return row ?? null;
}

export interface ViewMembership {
  taskIds: string[];
  truncated: boolean;
  syncedAt: Date;
}

/** The last walk's answer for this view under this person's token, if any. */
export async function findViewMembership(
  db: Db,
  viewId: string,
  userId: string,
): Promise<ViewMembership | null> {
  const [row] = await db
    .select({
      taskIds: viewMemberships.taskIds,
      truncated: viewMemberships.truncated,
      syncedAt: viewMemberships.syncedAt,
    })
    .from(viewMemberships)
    .where(and(eq(viewMemberships.viewId, viewId), eq(viewMemberships.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function saveViewMembership(
  db: Db,
  row: { viewId: string; userId: string; taskIds: string[]; truncated: boolean },
): Promise<void> {
  const syncedAt = new Date();
  await db
    .insert(viewMemberships)
    .values({ ...row, syncedAt })
    .onConflictDoUpdate({
      target: [viewMemberships.viewId, viewMemberships.userId],
      set: { taskIds: row.taskIds, truncated: row.truncated, syncedAt },
    });
}

/** A list's own status set if it overrides, otherwise its Space's. */
export async function statusesForList(db: Db, listId: string): Promise<StatusDef[]> {
  const [row] = await db
    .select({ listStatuses: lists.statuses, spaceStatuses: spaces.statuses })
    .from(lists)
    .leftJoin(spaces, eq(spaces.id, lists.spaceId))
    .where(eq(lists.id, listId))
    .limit(1);

  return row?.listStatuses ?? row?.spaceStatuses ?? [];
}

/** A Doc as the tree shows it: a name and somewhere to click. */
export interface DocRef {
  id: string;
  name: string;
}

export interface ListNode {
  id: string;
  name: string;
  /** Docs written inside this List. Usually none; the node stays a leaf then. */
  docs: DocRef[];
}

export interface HierarchyNode {
  id: string;
  name: string;
  folders: Array<{ id: string; name: string; lists: ListNode[]; docs: DocRef[] }>;
  lists: ListNode[];
  docs: DocRef[];
}

export interface Hierarchy {
  spaces: HierarchyNode[];
  /**
   * Docs that hang off the Workspace itself rather than any Space.
   *
   * ClickUp's own sidebar keeps these outside the tree too, and there are more
   * of them than every other kind put together in the workspace this was built
   * against — 73 against 4 at Space level. Dropping them because the tree has
   * no node for them would hide most of the Docs somebody has.
   */
  docs: DocRef[];
}

export async function getHierarchy(db: Db): Promise<Hierarchy> {
  const [allSpaces, allFolders, allLists, allDocs] = await Promise.all([
    db
      .select({ id: spaces.id, name: spaces.name })
      .from(spaces)
      .where(eq(spaces.archived, false))
      .orderBy(asc(spaces.name)),
    db
      .select({ id: folders.id, name: folders.name, spaceId: folders.spaceId })
      .from(folders)
      .where(and(eq(folders.archived, false), eq(folders.hidden, false)))
      .orderBy(asc(folders.orderindex), asc(folders.name)),
    db
      .select({
        id: lists.id,
        name: lists.name,
        spaceId: lists.spaceId,
        folderId: lists.folderId,
      })
      .from(lists)
      .where(eq(lists.archived, false))
      .orderBy(asc(lists.orderindex), asc(lists.name)),
    db
      .select({ id: docs.id, name: docs.name, parentId: docs.parentId, type: docs.parentType })
      .from(docs)
      .where(eq(docs.archived, false))
      .orderBy(asc(docs.name)),
  ]);

  /*
   * Docs by parent, so each node can take its own without rescanning the list.
   *
   * Task-parented Docs are deliberately left out of the tree. They are the
   * majority by count and they already have a home — the Docs section of the
   * task panel — and hanging them off the List their task lives in would
   * scatter a hundred rows through the sidebar under names nobody recognises.
   */
  const byParent = new Map<string, DocRef[]>();
  for (const doc of allDocs) {
    if (doc.type === DOC_PARENT.task || !doc.parentId) continue;
    const key = `${doc.type}:${doc.parentId}`;
    const bucket = byParent.get(key) ?? [];
    bucket.push({ id: doc.id, name: doc.name });
    byParent.set(key, bucket);
  }
  const docsOf = (type: number, id: string): DocRef[] => byParent.get(`${type}:${id}`) ?? [];
  const listNode = (l: { id: string; name: string }): ListNode => ({
    id: l.id,
    name: l.name,
    docs: docsOf(DOC_PARENT.list, l.id),
  });

  // A list whose folder is not in the tree — hidden, archived, or simply not
  // mirrored yet — belongs at the space level. Without this it belongs nowhere
  // and disappears from the sidebar, which is how three lists in the AI space
  // went missing.
  const knownFolders = new Set(allFolders.map((folder) => folder.id));

  return {
    spaces: allSpaces.map((space) => ({
      id: space.id,
      name: space.name,
      folders: allFolders
        .filter((f) => f.spaceId === space.id)
        .map((folder) => ({
          id: folder.id,
          name: folder.name,
          lists: allLists.filter((l) => l.folderId === folder.id).map(listNode),
          docs: docsOf(DOC_PARENT.folder, folder.id),
        })),
      lists: allLists
        .filter((l) => l.spaceId === space.id && (!l.folderId || !knownFolders.has(l.folderId)))
        .map(listNode),
      docs: docsOf(DOC_PARENT.space, space.id),
    })),
    /*
     * Everything (7) sits beside the Workspace (12) here. Both mean "not filed
     * under a Space", they are two of ClickUp's words for nearly the same
     * place, and splitting the sidebar into two indistinguishable sections
     * would be a distinction the reader cannot act on.
     */
    docs: allDocs
      .filter((d) => d.type === DOC_PARENT.workspace || d.type === DOC_PARENT.everything)
      .map((d) => ({ id: d.id, name: d.name })),
  };
}

export interface FilterFieldOption {
  /** ClickUp's own key for the option, which is what a filter clause carries. */
  value: string;
  label: string;
  color: string | null;
}

export interface FilterField {
  id: string;
  name: string;
  type: string;
  options: FilterFieldOption[];
}

/**
 * The Custom Fields of one List that a filter can name, with their options.
 *
 * Only `drop_down`. The other twelve types in this workspace are not worth a
 * facet: `formula` and the two progress types are computed and have no stable
 * value to match, `number`, `date`, `currency`, `text`, `short_text` and `url`
 * are free-form and want a comparison UI rather than a list of choices,
 * `checkbox` is two values that nobody has set on more than a handful of rows,
 * `users` duplicates the assignee facet, and `location` is a map pin. `labels`
 * would belong here — it is the multi-select twin of `drop_down` and
 * `clauseCondition` would need no change — except that the one `labels` field
 * in the workspace has no values mirrored at all, so there is nothing to
 * verify against and nothing for anyone to pick.
 *
 * The options live in `type_config`, and its shape is ClickUp's: `drop_down`
 * options carry `name`, `labels` options carry `label`, and both are keyed by
 * `orderindex` — which is also what `task_custom_values.value` stores, so that
 * is what a clause matches on. Read through Drizzle rather than raw SQL because
 * some rows hold `type_config` double-encoded and the column type unwraps them.
 *
 * ponytail: no list-scope join table, the one `custom_field_defs` said would be
 * needed the day list-level filtering arrived. It is not. Asking each of the 35
 * `drop_down` definitions whether any task in this list uses it is 28.7ms on
 * the 5,696-task Bugs list — the same question as a `select distinct` over the
 * join, which measures 189.8ms, because an `exists` stops at the first hit and
 * a distinct does not. A table would be a third thing for ingest to keep in
 * step, for a query nothing but an open menu ever runs.
 *
 * Derived from `listDisplayFields` rather than run as its own query, so the
 * "used in this list" probe is written once; the drop_down restriction is one
 * `filter` over a result the ponytail note above already priced.
 */
export async function listFilterFields(db: Db, listId: string): Promise<FilterField[]> {
  const fields = await listDisplayFields(db, listId);
  return fields
    .filter((field) => field.usedHere && field.type === "drop_down")
    .map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      options: optionsOf(field.typeConfig),
    }));
}

export interface DisplayField {
  id: string;
  name: string;
  type: string;
  /** ClickUp's own shape, verbatim — `formatFieldValue` in apps/web reads it. */
  typeConfig: unknown;
  /** Whether some task in this List already carries a value for it. */
  usedHere: boolean;
}

/**
 * Every Custom Field the workspace knows, flagged by whether this List uses it.
 *
 * Not "every field with a value here", which is what this asked at first and
 * what made the column picker read "No matches" on 243 of the 249 lists in the
 * workspace. A field is offered by ClickUp on every task in its scope whether
 * or not anybody has filled it in, and a picker that waits for a value before
 * it will offer the column is a picker you cannot use to start filling one in.
 *
 * The `exists` probe stays, demoted from a filter to a flag: `listFilterFields`
 * needs it — a facet whose every option matches nothing is worse than no facet
 * — and the picker sorts on it, so the fields this list actually uses come
 * first and the rest are a search away.
 *
 * ponytail: the flag is the whole notion of scope we have. ClickUp scopes a
 * field to a Space, a Folder or a List, and `task.custom_fields` says which
 * apply to each task — `packages/schema/src/map.ts` drops the ones with no
 * value, so the mirror cannot answer "applies here" for a field nobody has
 * filled in, and this offers the workspace's fields rather than none. The
 * upgrade is to keep that applicability at ingest; the day a workspace has
 * enough fields for the picker to feel long is the day to do it.
 */
export async function listDisplayFields(db: Db, listId: string): Promise<DisplayField[]> {
  const rows = await db
    .select({
      id: customFieldDefs.id,
      name: customFieldDefs.name,
      type: customFieldDefs.type,
      typeConfig: customFieldDefs.typeConfig,
      /*
       * `${customFieldDefs}.${sql.identifier("id")}`, not `${customFieldDefs.id}`.
       *
       * The outer query joins nothing, so Drizzle writes the bare form as
       * `"id"` — and the subquery joins `tasks`, which has an `id` of its own.
       * Unqualified it bound to `t.id`, making the predicate `v.field_id =
       * t.id`, which matches nothing, so every field came back unused and the
       * filter menu lost all its facets. Same trap as `assigneesJson` above.
       */
      usedHere: sql<boolean>`exists (
        select 1 from ${taskCustomValues} v
        join ${tasks} t on t.id = v.task_id
        where v.field_id = ${customFieldDefs}.${sql.identifier("id")} and t.list_id = ${listId}
      )`,
    })
    .from(customFieldDefs)
    .orderBy(asc(customFieldDefs.name), asc(customFieldDefs.id));

  // Used-here first, name order kept within each group — Array.sort is stable,
  // so the ordering above carries through rather than being re-stated here.
  return rows.sort((a, b) => Number(b.usedHere) - Number(a.usedHere));
}

interface RawOption {
  name?: unknown;
  label?: unknown;
  color?: unknown;
  orderindex?: unknown;
}

function optionsOf(typeConfig: unknown): FilterFieldOption[] {
  const raw = (typeConfig as { options?: unknown } | null)?.options;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry, index): FilterFieldOption[] => {
    const option = entry as RawOption;
    const order = typeof option.orderindex === "number" ? option.orderindex : index;
    const label = typeof option.name === "string" ? option.name : option.label;
    if (typeof label !== "string") return [];
    return [
      {
        value: String(order),
        label,
        color: typeof option.color === "string" ? option.color : null,
      },
    ];
  });
}

/** Workspace directory, for the assignee filter and the command palette. */
export async function listMembers(db: Db) {
  return db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      initials: users.initials,
      color: users.color,
      avatar: users.profilePicture,
    })
    .from(users)
    .orderBy(asc(users.username));
}

/**
 * Workspace-wide task search, for the command palette.
 *
 * The ponytail comment that used to sit here said this was a plain ILIKE with
 * no index and that 60,000 tasks was where it would need one. The mirror is at
 * 147,242 and the indexes landed; what it did not anticipate is that the answer
 * differs per column. Names and custom ids get trigram, because people type the
 * middle of a word and the number out of `TK-51829`. Descriptions get
 * `tsvector`, because they are prose: 334ms unindexed, 15-24ms with a trigram
 * index, 2.5-11ms with full text — and the trigram index over prose is no
 * smaller. `textCondition` holds the split.
 *
 * Comments are not searched, and that is a decision rather than an omission.
 * They are only mirrored when somebody opens a task — the list poll does not
 * carry them — so the mirror holds 50 comments against 147,242 tasks. Searching
 * them would answer "not found" for every conversation nobody has opened, which
 * is a new lie in place of the one this change removes. The prerequisite is
 * pulling comments during list sync, which is the worker's ground, not this
 * file's.
 *
 * Matches are ranked by where the hit lands, and recent activity breaks ties. A
 * description-only hit sorts last: the query matched something, but not
 * anything the row on screen is showing. An exact id match sorts first of all:
 * the ClickUp id is the address — the URL bar, the mobile app and every "paste
 * me this task" conversation hand it to you — and someone typing all of it
 * wants that row, not a name that happens to contain the same letters.
 */
export async function searchTasks(db: Db, query: string, limit = 12) {
  const term = query.trim();
  if (term.length < 2) return [];

  const matches = textCondition(term);
  if (!matches) return [];

  const prefix = `${term}%`;
  const like = `%${term}%`;

  return db
    .select({
      id: tasks.id,
      customId: tasks.customId,
      name: tasks.name,
      status: tasks.status,
      statusColor: tasks.statusColor,
      statusType: tasks.statusType,
      listId: tasks.listId,
      listName: lists.name,
    })
    .from(tasks)
    .leftJoin(lists, eq(lists.id, tasks.listId))
    .where(and(isNull(tasks.deletedAt), eq(tasks.archived, false), matches))
    .orderBy(
      // lower() on the id arm: the match beside it is ILIKE, and a pasted
      // upper-case id should rank first, not lose to a name with the letters.
      sql`case when lower(${tasks.id}) = lower(${term}) then 0
                when ${tasks.customId} ilike ${prefix} then 1
                when ${tasks.name} ilike ${prefix} then 2
                when ${tasks.name} ilike ${like} then 3
                else 4 end`,
      desc(tasks.dateUpdated),
    )
    .limit(limit);
}

/** What an id lifted out of a ClickUp URL turned out to be. */
export type ResolvedRef =
  | { kind: "task"; taskId: string; listId: string }
  | { kind: "view"; viewId: string; listId: string | null; name: string }
  | { kind: "list"; listId: string; name: string }
  | { kind: "folder"; folderId: string; name: string }
  | { kind: "space"; spaceId: string; name: string }
  | { kind: "doc"; docId: string; name: string };

/**
 * Identifies ids pulled out of a ClickUp URL against the mirror.
 *
 * The caller passes candidates most-specific first and gets back the first one
 * that is anything at all. The lookups run in parallel rather than as a union,
 * because a task id and a list id share no shape and there is nothing to decide
 * before asking.
 */
export async function resolveRefs(db: Db, ids: string[]): Promise<ResolvedRef | null> {
  if (ids.length === 0) return null;

  // Custom ids are conventionally uppercase (TK-51829) but a hand-edited URL
  // may not be, and the column is indexed by value, not by upper(value).
  const upper = ids.map((id) => id.toUpperCase());

  const [taskRows, viewRows, listRows, folderRows, spaceRows, docRows] = await Promise.all([
    db
      .select({ id: tasks.id, customId: tasks.customId, listId: tasks.listId })
      .from(tasks)
      .where(
        and(
          isNull(tasks.deletedAt),
          or(
            inArray(tasks.id, ids),
            inArray(tasks.customId, ids),
            inArray(tasks.customId, upper),
          ) ?? sql`false`,
        ),
      ),
    db
      .select({ id: listViews.id, name: listViews.name, listId: listViews.listId })
      .from(listViews)
      .where(inArray(listViews.id, ids)),
    db.select({ id: lists.id, name: lists.name }).from(lists).where(inArray(lists.id, ids)),
    db.select({ id: folders.id, name: folders.name }).from(folders).where(inArray(folders.id, ids)),
    db.select({ id: spaces.id, name: spaces.name }).from(spaces).where(inArray(spaces.id, ids)),
    db.select({ id: docs.id, name: docs.name }).from(docs).where(inArray(docs.id, ids)),
  ]);

  for (const id of ids) {
    const key = id.toUpperCase();
    const task = taskRows.find((row) => row.id === id || row.customId?.toUpperCase() === key);
    if (task) return { kind: "task", taskId: task.id, listId: task.listId };

    // Before the list, because a built-in view's id ("6-{list}-1") is a
    // different string from its list's and only one of the two can match.
    const view = viewRows.find((row) => row.id === id);
    if (view) return { kind: "view", viewId: view.id, listId: view.listId, name: view.name };

    const list = listRows.find((row) => row.id === id);
    if (list) return { kind: "list", listId: list.id, name: list.name };

    const folder = folderRows.find((row) => row.id === id);
    if (folder) return { kind: "folder", folderId: folder.id, name: folder.name };

    const space = spaceRows.find((row) => row.id === id);
    if (space) return { kind: "space", spaceId: space.id, name: space.name };

    // Last, because a Doc id ("gh-84875") has the same shape as a view's and a
    // view is the commoner paste. Nothing can be both: the ids come from
    // different ClickUp id spaces.
    const doc = docRows.find((row) => row.id === id);
    if (doc) return { kind: "doc", docId: doc.id, name: doc.name };
  }

  return null;
}
