import { describe, expect, test } from "bun:test";
import type { ListView } from "../src/lib/api.ts";
import {
  clickUpViewUrl,
  groupByForField,
  isRenderable,
  viewTypeLabel,
} from "../src/lib/clickup-views.ts";
import { groupTasks } from "../src/lib/grouping.ts";

/**
 * Everything a view decides before anything is rendered: what Rask draws, how
 * it groups, and where a tab it refuses to draw points instead.
 */

function view(over: Partial<ListView> = {}): ListView {
  return {
    id: "gh-1",
    listId: "901516038590",
    name: "Ventura AI list",
    type: "list",
    isDefault: false,
    groupField: "status",
    showClosed: false,
    publicUrl: null,
    ...over,
  };
}

describe("isRenderable", () => {
  test("draws lists and boards", () => {
    // Board is drawn as a list until the board component lands, but the type
    // reaching the route is the whole seam.
    expect(isRenderable("list")).toBe(true);
    expect(isRenderable("board")).toBe(true);
  });

  test("refuses everything ClickUp would draw differently", () => {
    for (const type of [
      "form",
      "conversation",
      "calendar",
      "gantt",
      "timeline",
      "workload",
      "mind_map",
      "map",
      "dashboard",
      "table",
      "box",
      "activity",
      "doc",
      // A type ClickUp has not shipped yet is refused rather than guessed at.
      "whiteboard",
    ]) {
      expect(isRenderable(type)).toBe(false);
    }
  });
});

describe("groupByForField", () => {
  test("maps the fields Rask has a column for", () => {
    expect(groupByForField("status")).toBe("status");
    expect(groupByForField("assignee")).toBe("assignee");
    expect(groupByForField("priority")).toBe("priority");
    expect(groupByForField("dueDate")).toBe("due");
    expect(groupByForField("list")).toBe("list");
  });

  test("falls back to status for a field it cannot group by", () => {
    // Custom fields, dates the list does not show, locations, and whatever
    // ClickUp adds next. Status is what every other Rask view groups by, and
    // the header's grouping control keeps saying so.
    for (const field of [
      "e2ba1c73-1e02-4b5f-9d3a-000000000000",
      "startDate",
      "dateCreated",
      "tag",
      "location",
      null,
      undefined,
    ]) {
      expect(groupByForField(field)).toBe("status");
    }
  });
});

describe("clickUpViewUrl", () => {
  test("sends a form to where it can actually be filled in", () => {
    const url = "https://forms.clickup.com/529/f/gh-91895/C3T1KMW9RPMCKW1539";
    expect(clickUpViewUrl(view({ type: "form", publicUrl: url }), "529")).toBe(url);
  });

  test("addresses everything else by view id", () => {
    // Verified against the live app for a board, a list and a dashboard view:
    // /v/l/{view_id} resolves all three regardless of type.
    expect(clickUpViewUrl(view({ id: "gh-96195", type: "board" }), "529")).toBe(
      "https://app.clickup.com/529/v/l/gh-96195",
    );
  });

  test("addresses a view with no list the same way, which is how ClickUp does", () => {
    // The real 7-529-1: a Workspace-level view, drawn by ClickUp at the very
    // address it was pasted from. Nothing about the link needs the list.
    expect(clickUpViewUrl({ ...view({ id: "7-529-1" }), listId: null }, "529")).toBe(
      "https://app.clickup.com/529/v/l/7-529-1",
    );
  });

  test("points nowhere rather than at half an address", () => {
    expect(clickUpViewUrl(view(), null)).toBeNull();
    // A form still has somewhere to go: its URL carries the workspace already.
    expect(clickUpViewUrl(view({ publicUrl: "https://forms.clickup.com/x" }), null)).toBe(
      "https://forms.clickup.com/x",
    );
  });
});

describe("viewTypeLabel", () => {
  test("names a type the way a sentence would", () => {
    expect(viewTypeLabel("conversation")).toBe("chat");
    expect(viewTypeLabel("mind_map")).toBe("mind map");
    expect(viewTypeLabel("gantt_type")).toBe("Gantt");
  });

  test("makes an unknown type readable instead of blank", () => {
    expect(viewTypeLabel("clickboard")).toBe("clickboard");
    expect(viewTypeLabel("some_new_thing")).toBe("some new thing");
  });
});

describe("grouping by priority", () => {
  const task = (id: string, priority: number | null) =>
    ({
      id,
      customId: null,
      name: id,
      status: "todo",
      statusColor: null,
      statusType: "open",
      priority,
      dueDate: null,
      startDate: null,
      dateUpdated: null,
      dateCreated: null,
      listId: "l",
      spaceId: null,
      parentId: null,
      tags: [],
      url: null,
      listName: null,
      deletedAt: null,
      archived: false,
      assignees: [],
    }) as const;

  test("runs urgent to low, with no priority last", () => {
    const items = groupTasks(
      [task("low", 4), task("none", null), task("urgent", 1), task("normal", 3)],
      "priority",
    );

    expect(items.filter((i) => i.kind === "header").map((i) => i.label)).toEqual([
      "Urgent",
      "Normal",
      "Low",
      "No priority",
    ]);
  });

  test("counts each group", () => {
    const items = groupTasks([task("a", 2), task("b", 2), task("c", null)], "priority");
    expect(items.filter((i) => i.kind === "header").map((i) => [i.label, i.count])).toEqual([
      ["High", 2],
      ["No priority", 1],
    ]);
  });
});
