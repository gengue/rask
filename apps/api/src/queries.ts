import {
  comments,
  customFieldDefs,
  type Db,
  folders,
  lists,
  type StatusDef,
  spaces,
  taskAssignees,
  taskCustomValues,
  tasks,
  users,
} from "@rask/schema";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

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
  /** Closed and done tasks are hidden unless asked for. */
  includeClosed?: boolean;
  /** Only rows the mirror touched after this instant. Drives the SSE feed. */
  syncedAfter?: Date;
  limit?: number;
}

export async function listTasks(db: Db, filters: TaskFilters) {
  const where = [];

  if (!filters.syncedAfter) {
    // The change feed must see deletions and archives; normal views must not.
    where.push(isNull(tasks.deletedAt), eq(tasks.archived, false));
  } else {
    where.push(gt(tasks.syncedAt, filters.syncedAfter));
  }

  if (filters.listId) where.push(eq(tasks.listId, filters.listId));
  if (filters.spaceId) where.push(eq(tasks.spaceId, filters.spaceId));
  if (filters.statuses?.length) where.push(inArray(tasks.status, filters.statuses));
  if (filters.tag) {
    // Matches the GIN jsonb_path_ops index on tasks.tags.
    where.push(sql`${tasks.tags} @> ${JSON.stringify([{ name: filters.tag }])}::jsonb`);
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
    .limit(filters.limit ?? 500);
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

  const [taskComments, fields, statuses] = await Promise.all([
    db
      .select({
        id: comments.id,
        text: comments.text,
        date: comments.date,
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
      .orderBy(asc(comments.date)),

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
  ]);

  return { ...task, comments: taskComments, customFields: fields, statuses };
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
      .filter((l) => l.spaceId === space.id && !l.folderId)
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
