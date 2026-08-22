import type {
  ClickUpComment,
  ClickUpCustomField,
  ClickUpFolder,
  ClickUpList,
  ClickUpSpace,
  ClickUpTask,
  ClickUpUser,
} from "@rask/clickup-client";
import type { StatusDef, TaskTag } from "./schema.ts";

/**
 * ClickUp payloads to mirror rows. Pure functions, no database: the ugly parts
 * of ClickUp's wire format get pinned down here and tested in isolation.
 */

export interface MappedTask {
  task: {
    id: string;
    customId: string | null;
    listId: string;
    folderId: string | null;
    spaceId: string | null;
    name: string;
    description: string | null;
    textContent: string | null;
    status: string | null;
    statusColor: string | null;
    statusType: string | null;
    orderindex: string | null;
    parentId: string | null;
    priority: number | null;
    dueDate: Date | null;
    startDate: Date | null;
    dateCreated: Date | null;
    dateUpdated: Date | null;
    dateClosed: Date | null;
    dateDone: Date | null;
    creatorId: string | null;
    archived: boolean;
    tags: TaskTag[];
    timeEstimate: number | null;
    points: number | null;
    url: string | null;
  };
  assigneeIds: string[];
  users: MappedUser[];
  customValues: Array<{ fieldId: string; value: unknown }>;
  customFields: MappedCustomField[];
}

export interface MappedUser {
  id: string;
  username: string | null;
  email: string | null;
  color: string | null;
  initials: string | null;
  profilePicture: string | null;
}

export interface MappedCustomField {
  id: string;
  name: string;
  type: string;
  typeConfig: unknown;
  required: boolean;
}

export function mapUser(user: ClickUpUser): MappedUser {
  return {
    id: String(user.id),
    username: user.username ?? null,
    email: user.email ?? null,
    color: user.color ?? null,
    initials: user.initials ?? null,
    profilePicture: user.profilePicture ?? null,
  };
}

export function mapCustomField(field: ClickUpCustomField): MappedCustomField {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    typeConfig: field.type_config ?? null,
    required: field.required ?? false,
  };
}

export function mapTask(task: ClickUpTask): MappedTask {
  const users = [...task.assignees.map(mapUser), ...(task.creator ? [mapUser(task.creator)] : [])];

  return {
    task: {
      id: task.id,
      customId: task.custom_id ?? null,
      // A task always belongs to a list. If ClickUp omits it we would be
      // inventing a parent, so let the caller supply the list it was fetched from.
      listId: task.list?.id ?? "",
      folderId: task.folder?.id ?? null,
      spaceId: task.space?.id ?? null,
      name: task.name,
      description: task.markdown_description ?? task.description ?? null,
      textContent: task.text_content ?? null,
      status: task.status?.status ?? null,
      statusColor: task.status?.color ?? null,
      statusType: task.status?.type ?? null,
      orderindex: task.orderindex ?? null,
      parentId: task.parent ?? null,
      priority: mapPriority(task.priority),
      dueDate: task.due_date ?? null,
      startDate: task.start_date ?? null,
      dateCreated: task.date_created ?? null,
      dateUpdated: task.date_updated ?? null,
      dateClosed: task.date_closed ?? null,
      dateDone: task.date_done ?? null,
      creatorId: task.creator ? String(task.creator.id) : null,
      archived: task.archived ?? false,
      tags: task.tags.map((tag) => ({
        name: tag.name,
        fg: tag.tag_fg ?? null,
        bg: tag.tag_bg ?? null,
      })),
      timeEstimate: task.time_estimate ?? null,
      points: task.points ?? null,
      url: task.url ?? null,
    },
    assigneeIds: task.assignees.map((a) => String(a.id)),
    users,
    // A field with no value set comes back with `value` absent. Storing that as
    // null would be indistinguishable from a field the user explicitly cleared.
    customValues: task.custom_fields
      .filter((f) => f.value !== undefined)
      .map((f) => ({ fieldId: f.id, value: f.value ?? null })),
    customFields: task.custom_fields.map(mapCustomField),
  };
}

/** ClickUp sends priority as an object with a stringified id: 1 urgent .. 4 low. */
function mapPriority(priority: ClickUpTask["priority"]): number | null {
  if (!priority) return null;
  const n = Number(priority.id);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

export function mapSpace(space: ClickUpSpace, teamId: string) {
  return {
    id: space.id,
    teamId,
    name: space.name,
    private: space.private ?? false,
    archived: space.archived ?? false,
    statuses: space.statuses.map(mapStatus),
  };
}

export function mapFolder(folder: ClickUpFolder, spaceId: string) {
  return {
    id: folder.id,
    spaceId: folder.space?.id ?? spaceId,
    name: folder.name,
    orderindex: folder.orderindex ?? null,
    hidden: folder.hidden ?? false,
    archived: folder.archived ?? false,
  };
}

export function mapList(
  list: ClickUpList,
  fallback: { spaceId: string; folderId?: string | null },
) {
  return {
    id: list.id,
    spaceId: list.space?.id ?? fallback.spaceId,
    folderId: list.folder?.id ?? fallback.folderId ?? null,
    name: list.name,
    orderindex: list.orderindex ?? null,
    content: list.content ?? null,
    taskCount: list.task_count ?? null,
    archived: list.archived ?? false,
    // Only meaningful when the list overrides its Space. Otherwise the Space's
    // set applies and duplicating it here would be a second thing to keep in sync.
    statuses: list.override_statuses && list.statuses ? list.statuses.map(mapStatus) : null,
  };
}

export function mapComment(comment: ClickUpComment, taskId: string) {
  return {
    id: comment.id,
    taskId,
    userId: comment.user ? String(comment.user.id) : null,
    text: comment.comment_text ?? comment.comment?.map((c) => c.text ?? "").join("") ?? null,
    resolved: comment.resolved ?? false,
    replyCount: comment.reply_count,
    date: comment.date ?? null,
  };
}

function mapStatus(status: {
  id?: string | null;
  status: string;
  color?: string | null;
  type?: string | null;
  orderindex?: number | null;
}): StatusDef {
  return {
    id: status.id ?? null,
    status: status.status,
    color: status.color ?? null,
    type: status.type ?? null,
    orderindex: status.orderindex ?? null,
  };
}
