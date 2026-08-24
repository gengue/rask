import { describe, expect, test } from "bun:test";
import type { CommentThread, Task, TaskDetail } from "../src/lib/api.ts";
import { withLiveTask } from "../src/lib/api.ts";

function task(extra: Partial<Task> = {}): Task {
  return {
    id: "T",
    customId: null,
    name: "Task",
    status: "open",
    statusColor: "#f2c94c",
    statusType: "custom",
    priority: null,
    dueDate: null,
    startDate: null,
    dateUpdated: null,
    dateCreated: null,
    listId: "L",
    spaceId: null,
    parentId: null,
    tags: [],
    url: null,
    listName: "List",
    deletedAt: null,
    archived: false,
    assignees: [],
    ...extra,
  };
}

function comment(id: string): CommentThread {
  return {
    id,
    parentCommentId: null,
    text: id,
    html: null,
    userId: null,
    username: null,
    email: null,
    date: null,
    resolved: false,
    assigneeId: null,
    reactions: [],
    replies: [],
  };
}

function detail(extra: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...task(),
    description: null,
    creatorId: null,
    folderId: null,
    timeEstimate: null,
    points: null,
    dateClosed: null,
    comments: [],
    customFields: [],
    statuses: [],
    attachments: [],
    checklists: [],
    subtasks: [],
    parent: null,
    ...extra,
  };
}

describe("withLiveTask", () => {
  test("the collection row wins on the Task half", () => {
    const merged = withLiveTask(
      detail({ status: "open" }),
      task({ status: "done", name: "Renamed" }),
    );
    expect(merged.status).toBe("done");
    expect(merged.name).toBe("Renamed");
  });

  /*
   * The change feed pushes whole details through the task collection, so a row
   * for an open task carries a snapshot of its conversation from whenever the
   * server last refreshed it. A comment posted since then only exists in the
   * fetched detail, and letting the row win puts the panel back in time.
   */
  test("the fetched detail wins on everything a row has no business carrying", () => {
    const stale = { ...task(), ...detail({ comments: [comment("old")], description: "old" }) };
    const merged = withLiveTask(
      detail({ comments: [comment("old"), comment("new")], description: "new" }),
      stale,
    );
    expect(merged.comments.map((c) => c.id)).toEqual(["old", "new"]);
    expect(merged.description).toBe("new");
  });
});
