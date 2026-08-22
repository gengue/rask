import { describe, expect, test } from "bun:test";
import { clickUpComment, clickUpTask } from "@rask/clickup-client";
import commentFixture from "../../clickup-client/test/fixtures/comment-with-image.json" with {
  type: "json",
};
import taskFixture from "../../clickup-client/test/fixtures/task.json" with { type: "json" };
import { mapComment, mapTask } from "../src/map.ts";

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
