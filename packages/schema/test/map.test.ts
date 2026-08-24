import { describe, expect, test } from "bun:test";
import { clickUpComment, clickUpTask, clickUpView } from "@rask/clickup-client";
import checklistFixture from "../../clickup-client/test/fixtures/checklist.json" with {
  type: "json",
};
import commentFixture from "../../clickup-client/test/fixtures/comment-with-image.json" with {
  type: "json",
};
import taskFixture from "../../clickup-client/test/fixtures/task.json" with { type: "json" };
import { mapComment, mapTask, viewListId } from "../src/map.ts";

const parse = (overrides: Record<string, unknown> = {}) =>
  clickUpTask.parse({ ...taskFixture, ...overrides });

describe("mapTask", () => {
  test("flattens the status object onto the row", () => {
    const { task } = mapTask(parse());
    expect(task.status).toBe("in progress");
    expect(task.statusColor).toBe("#f2c94c");
    expect(task.statusType).toBe("custom");
  });

  test("turns ClickUp's stringified priority id into 1..4", () => {
    expect(mapTask(parse()).task.priority).toBe(2);
    expect(mapTask(parse({ priority: null })).task.priority).toBeNull();
  });

  test("ignores a priority id outside 1..4 instead of storing nonsense", () => {
    expect(mapTask(parse({ priority: { id: "9", priority: "???" } })).task.priority).toBeNull();
  });

  test("prefers the markdown description over the plain one", () => {
    const { task } = mapTask(parse());
    expect(task.description).toBe("Render UI before `vehicle_state` sync");
  });

  test("falls back to the plain description when markdown is absent", () => {
    const { task } = mapTask(parse({ markdown_description: null }));
    expect(task.description).toBe("Render UI before vehicle_state sync");
  });

  test("renames ClickUp's tag_fg/tag_bg to fg/bg", () => {
    expect(mapTask(parse()).task.tags).toEqual([
      { name: "performance", fg: "#FFFFFF", bg: "#EA4335" },
    ]);
  });

  test("collects assignees and creator into the user directory", () => {
    const mapped = mapTask(parse());
    expect(mapped.assigneeIds).toEqual(["183"]);
    expect(mapped.users.map((u) => u.id)).toEqual(["183", "183"]);
    expect(mapped.users[0]?.email).toBe("jori@example.com");
  });

  test("keeps custom field values and their definitions", () => {
    const mapped = mapTask(parse());
    expect(mapped.customValues).toEqual([
      { fieldId: "0a52c486-5f05-403b-b4fd-c512ff05131c", value: "opt-2" },
    ]);
    expect(mapped.customFields[0]?.type).toBe("drop_down");
  });

  test("skips fields with no value, so unset stays distinct from cleared", () => {
    const withoutValue = structuredClone(taskFixture) as Record<string, unknown>;
    const fields = withoutValue.custom_fields as Array<Record<string, unknown>>;
    delete fields[0]?.value;

    const mapped = mapTask(clickUpTask.parse(withoutValue));
    expect(mapped.customValues).toEqual([]);
    // The definition is still learned, so the UI can render the empty field.
    expect(mapped.customFields).toHaveLength(1);
  });

  test("records an explicitly cleared field as null", () => {
    const cleared = structuredClone(taskFixture) as Record<string, unknown>;
    const [field] = cleared.custom_fields as Array<Record<string, unknown>>;
    if (field) field.value = null;

    expect(mapTask(clickUpTask.parse(cleared)).customValues).toEqual([
      { fieldId: "0a52c486-5f05-403b-b4fd-c512ff05131c", value: null },
    ]);
  });

  test("carries the list, folder and space ids for filtering", () => {
    const { task } = mapTask(parse());
    expect(task.listId).toBe("123");
    expect(task.folderId).toBe("456");
    expect(task.spaceId).toBe("789");
  });

  test("converts every date to a Date or null", () => {
    const { task } = mapTask(parse());
    expect(task.dueDate).toEqual(new Date(1508369194377));
    expect(task.dateUpdated).toEqual(new Date(1567780450202));
    expect(task.dateDone).toBeNull();
  });
});

describe("mapTask attachments", () => {
  test("renames the URL and thumbnail fields onto the mirror's columns", () => {
    const [image] = mapTask(parse()).attachments ?? [];

    expect(image).toEqual({
      id: "0ed173fb-2acb-4479-a3b9-24610aa6b60a.png",
      title: "cold-start.png",
      extension: "png",
      mimetype: "image/png",
      size: 18080,
      date: new Date(1787362173440),
      thumbnailSmall: "https://t529.p.clickup-attachments.com/t529/0ed173fb/image_small.png",
      thumbnailMedium: "https://t529.p.clickup-attachments.com/t529/0ed173fb/image.png",
      thumbnailLarge: "https://t529.p.clickup-attachments.com/t529/0ed173fb/image.png",
      url: "https://t529.p.clickup-attachments.com/t529/0ed173fb/image.png",
      urlWithQuery: "https://t529.p.clickup-attachments.com/t529/0ed173fb/image.png?view=open",
    });
  });

  test("drops files ClickUp has deleted", () => {
    const ids = (mapTask(parse()).attachments ?? []).map((a) => a.id);
    expect(ids).toEqual([
      "0ed173fb-2acb-4479-a3b9-24610aa6b60a.png",
      "dddfb8bc-e190-4d17-866b-73290ae62763.pdf",
    ]);
  });

  test("drops files ClickUp hides from the task", () => {
    const hidden = structuredClone(taskFixture) as Record<string, unknown>;
    const files = hidden.attachments as Array<Record<string, unknown>>;
    if (files[0]) files[0].hidden = true;

    expect((mapTask(clickUpTask.parse(hidden)).attachments ?? []).map((a) => a.id)).toEqual([
      "dddfb8bc-e190-4d17-866b-73290ae62763.pdf",
    ]);
  });

  test("falls back to the plain URL when there is no ?view=open variant", () => {
    const attachments = [{ id: "a.png", url: "https://cdn.example/a.png" }];
    const [only] = mapTask(parse({ attachments })).attachments ?? [];
    expect(only?.urlWithQuery).toBe("https://cdn.example/a.png");
  });

  /*
   * Null and [] are different answers and ingest acts on the difference: null
   * means the endpoint does not report attachments, [] means this task has
   * none. Collapsing them deletes every mirrored file on the next list poll.
   */
  test("is null when the payload never mentioned attachments", () => {
    const { attachments, ...withoutAttachments } = taskFixture;
    expect(mapTask(clickUpTask.parse(withoutAttachments)).attachments).toBeNull();
  });

  test("is an empty array when the task really has none", () => {
    expect(mapTask(parse({ attachments: [] })).attachments).toEqual([]);
  });
});

describe("mapTask checklists", () => {
  const withChecklist = () => parse({ checklists: [checklistFixture] });

  test("splits a checklist into its row and its items", () => {
    const [mapped] = mapTask(withChecklist()).checklists ?? [];

    expect(mapped?.checklist).toEqual({
      id: "f66e2c95-ab84-463b-8b5d-3754a97ec1e7",
      taskId: "9hz",
      name: "Release steps",
      orderindex: 1,
      creatorId: "82591240",
      dateCreated: new Date(1787165200145),
    });
    expect(mapped?.items.map((item) => item.name)).toEqual([
      "Tag the release",
      "Run the migrations",
      "Announce it in the channel",
    ]);
  });

  /*
   * The spec types this field as a user object in the CreateChecklistItem
   * response and as a bare id in the EditChecklistItem one, and both really do
   * come back. Reducing them here is what keeps the difference out of the rest
   * of the codebase.
   */
  test("reduces an item assignee to an id whichever shape ClickUp used", () => {
    const [mapped] = mapTask(withChecklist()).checklists ?? [];

    expect(mapped?.items.map((item) => item.assigneeId)).toEqual([null, "183", "183"]);
  });

  test("keeps a nested item's parent, which is how nesting is stored", () => {
    const [mapped] = mapTask(withChecklist()).checklists ?? [];

    expect(mapped?.items[2]?.parentItemId).toBe("b851599b-ac59-4e52-b15a-ec2a18921647");
  });

  /* Same null-versus-[] distinction as attachments, and the same consequence. */
  test("is null when the payload never mentioned checklists", () => {
    const { checklists, ...withoutChecklists } = taskFixture;
    expect(mapTask(clickUpTask.parse(withoutChecklists)).checklists).toBeNull();
  });

  test("is an empty array when the task really has none", () => {
    expect(mapTask(parse({ checklists: [] })).checklists).toEqual([]);
  });
});

describe("mapComment", () => {
  const comment = clickUpComment.parse(commentFixture);

  test("keeps ClickUp's flat text untouched, because that is what goes back out", () => {
    // The write path resends this on an edit or a resolve. If it ever held the
    // rendered body, resolving a comment would post markdown into it.
    expect(mapComment(comment, "t1").text).toBe(
      "@Soledad Cruz I created a new version\nimage.png\n",
    );
  });

  test("renders the rich body alongside it", () => {
    expect(mapComment(comment, "t1").markdown).toBe(
      "@[Soledad Cruz](clickup://user/2465931) I created a new version\n" +
        "![image.png](https://t529.p.clickup-attachments.com/t529/" +
        "0ed173fb-2acb-4479-a3b9-24610aa6b60a/image.png?view=open)",
    );
  });

  test("leaves markdown null when ClickUp sent no segments", () => {
    // The UI reads `markdown ?? text`, so null means the flat text is all there is.
    const plain = clickUpComment.parse({ id: "c1", comment_text: "plain", reply_count: 0 });
    expect(mapComment(plain, "t1").markdown).toBeNull();
  });

  test("takes the parent from the caller, since a reply does not carry one", () => {
    expect(mapComment(comment, "t1", "c0").parentCommentId).toBe("c0");
  });
});

/**
 * Which List a view's rows belong to, which is the one thing that decides
 * whether Rask can route the view at all.
 *
 * The four parent types are ClickUp's hierarchy levels, observed against the
 * Ventura workspace and documented nowhere: a view hangs off a Space (4), a
 * Folder (5), a List (6) or the Workspace itself (7), and all four are drawn
 * at the same `/{team}/v/l/{id}` address.
 */
describe("viewListId", () => {
  const view = (parent: unknown) =>
    clickUpView.parse({ id: "gh-1", name: "View", type: "list", parent });

  test("a List view names its list", () => {
    expect(viewListId(view({ id: "5345534", type: 6 }))).toBe("5345534");
  });

  test("a Workspace view names none: its rows come from every list under it", () => {
    // The real 7-529-1, whose rows span Bugs, MyVentura, vMeets and more.
    expect(viewListId(view({ id: "529", type: 7 }))).toBeNull();
  });

  test("a Folder view names none", () => {
    expect(viewListId(view({ id: "90150139071", type: 5 }))).toBeNull();
  });

  test("a Space view names none", () => {
    expect(viewListId(view({ id: "90020068902", type: 4 }))).toBeNull();
  });

  test("a view with no parent at all is not attributed to one", () => {
    // ClickUp has never omitted it, but guessing a list here would file every
    // task in the view under whatever id happened to be in hand.
    expect(viewListId(view(null))).toBeNull();
    expect(viewListId(view({ id: "5345534", type: null }))).toBeNull();
  });
});
