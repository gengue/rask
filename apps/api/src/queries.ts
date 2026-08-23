import {
  checklistItems,
  comments,
  customFieldDefs,
  type Db,
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
} from "@rask/schema";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";

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

/** Correlated aggregate: one extra index scan per row, no N+1, no GROUP BY. */
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
  where ta.task_id = ${tasks.id}
)`;

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
  const where = [];

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
      or(isNull(tasks.statusType), sql`${tasks.statusType} not in ('closed', 'done')`) ?? sql`true`,
    );
  }
  if (filters.assigneeId) {
    where.push(sql`exists (
      select 1 from ${taskAssignees} ta
      where ta.task_id = ${tasks.id} and ta.user_id = ${filters.assigneeId}
    )`);
  }

  return db
    .select(taskColumns)
    .from(tasks)
    .leftJoin(lists, eq(lists.id, tasks.listId))
    .where(and(...where))
    .orderBy(
      // Overdue and soon-due first, then newest activity. Nulls last so a task
      // with no due date never outranks one that is actually due.
      sql`${tasks.dueDate} asc nulls last`,
      desc(tasks.dateUpdated),
    )
    .limit((filters.limit ?? 500) + 1);
}

export async function getTaskDetail(db: Db, taskId: string) {
  const [task] = await db
    .select({
      ...taskColumns,
      description: tasks.description,
      creatorId: tasks.creatorId,
      folderId: tasks.folderId,
      timeEstimate: tasks.timeEstimate,
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

      db
        .select({
          id: customFieldDefs.id,
          name: customFieldDefs.name,
          type: customFieldDefs.type,
          typeConfig: customFieldDefs.typeConfig,
          value: taskCustomValues.value,
        })
        .from(taskCustomValues)
        .innerJoin(customFieldDefs, eq(customFieldDefs.id, taskCustomValues.fieldId))
        .where(eq(taskCustomValues.taskId, taskId))
        .orderBy(asc(customFieldDefs.name)),

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
  assignees: assigneesJson.as("assignees"),
};

/**
 * Enough of a task to render one line of it and link to it.
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
    .orderBy(asc(tasks.orderindex), asc(tasks.dateCreated));
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
      .orderBy(asc(taskChecklists.orderindex), asc(taskChecklists.dateCreated)),

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
    .orderBy(asc(comments.date));

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
  listId: string;
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

export interface HierarchyNode {
  id: string;
  name: string;
  folders: Array<{ id: string; name: string; lists: Array<{ id: string; name: string }> }>;
  lists: Array<{ id: string; name: string }>;
}

export async function getHierarchy(db: Db): Promise<HierarchyNode[]> {
  const [allSpaces, allFolders, allLists] = await Promise.all([
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
  ]);

  // A list whose folder is not in the tree — hidden, archived, or simply not
  // mirrored yet — belongs at the space level. Without this it belongs nowhere
  // and disappears from the sidebar, which is how three lists in the AI space
  // went missing.
  const knownFolders = new Set(allFolders.map((folder) => folder.id));

  return allSpaces.map((space) => ({
    id: space.id,
    name: space.name,
    folders: allFolders
      .filter((f) => f.spaceId === space.id)
      .map((folder) => ({
        id: folder.id,
        name: folder.name,
        lists: allLists
          .filter((l) => l.folderId === folder.id)
          .map((l) => ({ id: l.id, name: l.name })),
      })),
    lists: allLists
      .filter((l) => l.spaceId === space.id && (!l.folderId || !knownFolders.has(l.folderId)))
      .map((l) => ({ id: l.id, name: l.name })),
  }));
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
 * ponytail: a plain ILIKE with no index. At 17k tasks that is a 38ms sequential
 * scan, which is under the threshold where typing feels laggy, and the cost is
 * linear. Past roughly 60k tasks it needs `create extension pg_trgm` and a GIN
 * index on `name gin_trgm_ops`; the query does not change.
 *
 * Matches are ranked by where the hit lands: a title that starts with the query
 * beats one that merely contains it, and recent activity breaks ties.
 */
export async function searchTasks(db: Db, query: string, limit = 12) {
  const term = query.trim();
  if (term.length < 2) return [];

  const like = `%${term}%`;
  const prefix = `${term}%`;

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
    .where(
      and(
        isNull(tasks.deletedAt),
        eq(tasks.archived, false),
        or(ilike(tasks.name, like), ilike(tasks.customId, like)) ?? sql`false`,
      ),
    )
    .orderBy(
      sql`case when ${tasks.customId} ilike ${prefix} then 0
                when ${tasks.name} ilike ${prefix} then 1
                else 2 end`,
      desc(tasks.dateUpdated),
    )
    .limit(limit);
}

/** What an id lifted out of a ClickUp URL turned out to be. */
export type ResolvedRef =
  | { kind: "task"; taskId: string; listId: string }
  | { kind: "view"; viewId: string; listId: string; name: string }
  | { kind: "list"; listId: string; name: string }
  | { kind: "folder"; folderId: string; name: string }
  | { kind: "space"; spaceId: string; name: string };

/**
 * Identifies ids pulled out of a ClickUp URL against the mirror.
 *
 * The caller passes candidates most-specific first and gets back the first one
 * that is anything at all. Four indexed lookups run in parallel rather than a
 * union, because a task id and a list id share no shape and there is nothing to
 * decide before asking.
 */
export async function resolveRefs(db: Db, ids: string[]): Promise<ResolvedRef | null> {
  if (ids.length === 0) return null;

  // Custom ids are conventionally uppercase (TK-51829) but a hand-edited URL
  // may not be, and the column is indexed by value, not by upper(value).
  const upper = ids.map((id) => id.toUpperCase());

  const [taskRows, viewRows, listRows, folderRows, spaceRows] = await Promise.all([
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
  }

  return null;
}
