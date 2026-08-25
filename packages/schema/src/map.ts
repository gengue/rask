import type {
  ClickUpAttachment,
  ClickUpChecklist,
  ClickUpComment,
  ClickUpCustomField,
  ClickUpFolder,
  ClickUpList,
  ClickUpSpace,
  ClickUpTask,
  ClickUpUser,
  ClickUpView,
} from "@rask/clickup-client";
import { renderCommentBody, VIEW_PARENT } from "@rask/clickup-client";
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
    timeSpent: number | null;
    points: number | null;
    url: string | null;
  };
  assigneeIds: string[];
  users: MappedUser[];
  customValues: Array<{ fieldId: string; value: unknown }>;
  customFields: MappedCustomField[];
  /**
   * Null when the payload carried no `attachments` key at all, which is how
   * every list endpoint answers. Only `GET /task/{id}` knows, so anything else
   * has to say "no opinion" rather than "none".
   */
  attachments: MappedAttachment[] | null;
  /** Null for the same reason as `attachments`: only `GET /task/{id}` knows. */
  checklists: MappedChecklist[] | null;
}

export interface MappedChecklist {
  checklist: {
    id: string;
    taskId: string;
    name: string;
    orderindex: number | null;
    creatorId: string | null;
    dateCreated: Date | null;
  };
  items: Array<{
    id: string;
    checklistId: string;
    name: string;
    orderindex: number | null;
    assigneeId: string | null;
    resolved: boolean;
    parentItemId: string | null;
    dateCreated: Date | null;
  }>;
}

export interface MappedAttachment {
  id: string;
  title: string | null;
  extension: string | null;
  mimetype: string | null;
  size: number | null;
  date: Date | null;
  thumbnailSmall: string | null;
  thumbnailMedium: string | null;
  thumbnailLarge: string | null;
  url: string | null;
  urlWithQuery: string | null;
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

/**
 * `url_w_host` is dropped: it is `url` again, sometimes with a `?host=prod`
 * that changes nothing about what comes back. Two columns holding the same
 * string is two chances to read the wrong one.
 */
export function mapAttachment(attachment: ClickUpAttachment): MappedAttachment {
  return {
    id: attachment.id,
    title: attachment.title ?? null,
    extension: attachment.extension ?? null,
    mimetype: attachment.mimetype ?? null,
    size: attachment.size ?? null,
    date: attachment.date ?? null,
    thumbnailSmall: attachment.thumbnail_small ?? null,
    thumbnailMedium: attachment.thumbnail_medium ?? null,
    thumbnailLarge: attachment.thumbnail_large ?? null,
    url: attachment.url ?? null,
    urlWithQuery: attachment.url_w_query ?? attachment.url ?? null,
  };
}

/**
 * A checklist and its items, flattened into the two rows they are stored as.
 *
 * `taskId` comes from the caller rather than the payload: ClickUp echoes
 * `task_id` on a checklist read back from a write, but not consistently, and
 * the task being ingested is the only thing that is certainly right.
 *
 * `assignee` is the one field the vendored spec disagrees with itself about —
 * a user object in one response, a bare id in another — so both are reduced to
 * an id here and the difference stops at this function.
 */
export function mapChecklist(checklist: ClickUpChecklist, taskId: string): MappedChecklist {
  return {
    checklist: {
      id: checklist.id,
      taskId,
      name: checklist.name,
      orderindex: checklist.orderindex ?? null,
      creatorId: checklist.creator ?? null,
      dateCreated: checklist.date_created ?? null,
    },
    items: checklist.items.map((item) => ({
      id: item.id,
      checklistId: checklist.id,
      name: item.name,
      orderindex: item.orderindex ?? null,
      assigneeId: assigneeId(item.assignee),
      resolved: item.resolved ?? false,
      parentItemId: item.parent ?? null,
      dateCreated: item.date_created ?? null,
    })),
  };
}

function assigneeId(assignee: ClickUpChecklist["items"][number]["assignee"]): string | null {
  if (assignee === null || assignee === undefined) return null;
  return typeof assignee === "object" ? String(assignee.id) : String(assignee);
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
      folderId: task.folder && !task.folder.hidden ? task.folder.id : null,
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
      timeSpent: task.time_spent ?? null,
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
    // Deleted and hidden rows keep coming back after ClickUp stops showing
    // them. Mirroring a file the workspace considers gone would put it back on
    // the task, which is worse than not having it.
    attachments:
      task.attachments?.filter((a) => !a.deleted && !a.hidden).map(mapAttachment) ?? null,
    checklists: task.checklists?.map((list) => mapChecklist(list, task.id)) ?? null,
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
    // ClickUp puts every list in a folder. Lists that look folderless in the
    // UI are in an implicit one marked `hidden`, and that folder is never
    // returned by GET /space/{id}/folder — so storing its id points the list at
    // a parent that does not exist and drops it out of the sidebar entirely.
    folderId: list.folder && !list.folder.hidden ? list.folder.id : (fallback.folderId ?? null),
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

/**
 * A view to the row that draws its tab.
 *
 * `listId` comes from the caller. ClickUp does echo the container back as
 * `parent: { id, type }`, but `type` is a numeric enum (6 is a List) that
 * nothing else in this codebase decodes, and the List the views were fetched
 * for is the only thing that is certainly right.
 *
 * `isDefault` also comes from the caller: it lives in a separate `default_view`
 * object on the response, not on the view.
 */
/**
 * The List a view draws its rows from, or null when it draws from many.
 *
 * ClickUp hangs a view off any level of the hierarchy and addresses all four
 * the same way, so `/{team}/v/l/{id}` is as likely to be a Workspace view as a
 * List's. `parent.type` is the only thing on the payload that says which — the
 * built-in ids encode it too (`6-{list}-1`), but a saved view is called
 * `gh-96335` and encodes nothing.
 *
 * Null is not a failure. A Workspace-, Space- or Folder-level view genuinely
 * has no one list: its rows come from every list under the container, each
 * task carrying its own. What null rules out is attributing all of them to one.
 */
export function viewListId(view: ClickUpView): string | null {
  const parent = view.parent;
  return parent && parent.type === VIEW_PARENT.list ? parent.id : null;
}

export function mapView(view: ClickUpView, listId: string, defaultViewId: string | null) {
  return {
    id: view.id,
    listId,
    name: view.name,
    type: view.type,
    orderindex: view.orderindex ?? null,
    isDefault: view.id === defaultViewId,
    // Absent on forms and conversations, which hold no tasks to group.
    groupField: view.grouping?.field ?? null,
    showClosed: view.filters?.show_closed ?? false,
    publicUrl: view.public_url ?? null,
  };
}

/**
 * `parentCommentId` comes from the caller, not the payload: replies are read
 * from `GET /comment/{id}/reply`, and ClickUp does not echo the parent back on
 * them. The fetch context is the only place that knows.
 */
export function mapComment(comment: ClickUpComment, taskId: string, parentCommentId?: string) {
  return {
    id: comment.id,
    taskId,
    parentCommentId: parentCommentId ?? null,
    userId: comment.user ? String(comment.user.id) : null,
    text: comment.comment_text ?? comment.comment?.map((c) => c.text ?? "").join("") ?? null,
    // What the flat text threw away: images, files, links, lists, emphasis, and
    // the ids behind the @mentions. See renderCommentBody for why markdown.
    markdown: renderCommentBody(comment.comment),
    // Kept whole for the write path; see the column comment.
    segments: comment.comment ?? null,
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
