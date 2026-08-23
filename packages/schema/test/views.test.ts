import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clickUpView } from "@rask/clickup-client";
import { asc, eq } from "drizzle-orm";
import viewsFixture from "../../clickup-client/test/fixtures/list-views.json" with { type: "json" };
import { replaceListViews } from "../src/ingest.ts";
import { mapView } from "../src/map.ts";
import { listViews } from "../src/schema.ts";
import { createTestDb } from "../src/test-db.ts";

/**
 * View ingest against a real database.
 *
 * The interesting part is the delete: `GET /list/{id}/view` answers with the
 * whole set, so a view missing from a fresh read has been deleted in ClickUp
 * and has to leave the tab bar. Getting that predicate wrong either strands
 * dead tabs or wipes another list's views, and neither is visible in a unit
 * test over the mapper alone.
 */

const db = createTestDb();

const LIST = "views-test-list";
const OTHER_LIST = "views-test-other-list";

const parsed = viewsFixture.views.map((view) => clickUpView.parse(view));

function view(id: string, over: Record<string, unknown> = {}) {
  return clickUpView.parse({ ...viewsFixture.views[0], id, ...over });
}

async function stored(listId = LIST) {
  return db
    .select({
      id: listViews.id,
      name: listViews.name,
      type: listViews.type,
      orderindex: listViews.orderindex,
      isDefault: listViews.isDefault,
      groupField: listViews.groupField,
      showClosed: listViews.showClosed,
      publicUrl: listViews.publicUrl,
    })
    .from(listViews)
    .where(eq(listViews.listId, listId))
    .orderBy(asc(listViews.orderindex));
}

beforeEach(async () => {
  await db.delete(listViews).where(eq(listViews.listId, LIST));
  await db.delete(listViews).where(eq(listViews.listId, OTHER_LIST));
});

afterEach(async () => {
  await db.delete(listViews).where(eq(listViews.listId, LIST));
  await db.delete(listViews).where(eq(listViews.listId, OTHER_LIST));
});

describe("mapView", () => {
  test("keeps what draws a tab and drops the filter rules", () => {
    const row = mapView(view("gh-1"), LIST, "gh-1");

    expect(row).toEqual({
      id: "gh-1",
      listId: LIST,
      name: "Ventura AI",
      type: "board",
      orderindex: 2,
      isDefault: true,
      groupField: "status",
      showClosed: false,
      publicUrl: null,
    });
    expect(Object.keys(row)).not.toContain("filters");
  });

  test("reads no grouping off a view that holds no tasks", () => {
    const form = clickUpView.parse(viewsFixture.views[4]);
    const row = mapView(form, LIST, null);

    expect(form.type).toBe("form");
    expect(row.groupField).toBeNull();
    expect(row.publicUrl).toContain("forms.clickup.com");
  });
});

describe("replaceListViews", () => {
  test("stores every tab, default included", async () => {
    await replaceListViews(db, LIST, { views: parsed, defaultViewId: "gh-84055" });

    const rows = await stored();
    expect(rows.map((row) => row.id)).toEqual([
      "gh-96195",
      "gh-84055",
      "gh-96335",
      "6-901516038590-8",
      "gh-91895",
      "gh-96215",
    ]);
    expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual(["gh-84055"]);
  });

  test("drops a view that is no longer in ClickUp's answer", async () => {
    await replaceListViews(db, LIST, { views: parsed, defaultViewId: null });
    await replaceListViews(db, LIST, {
      views: parsed.filter((v) => v.id !== "gh-96335"),
      defaultViewId: null,
    });

    expect((await stored()).map((row) => row.id)).not.toContain("gh-96335");
  });

  test("empties the list when ClickUp answers with nothing", async () => {
    await replaceListViews(db, LIST, { views: parsed, defaultViewId: null });
    await replaceListViews(db, LIST, { views: [], defaultViewId: null });

    expect(await stored()).toEqual([]);
  });

  test("leaves another list's views alone", async () => {
    await replaceListViews(db, OTHER_LIST, { views: parsed, defaultViewId: null });
    await replaceListViews(db, LIST, { views: [], defaultViewId: null });

    expect(await stored(OTHER_LIST)).toHaveLength(parsed.length);
  });

  test("re-reading the same answer changes nothing", async () => {
    await replaceListViews(db, LIST, { views: parsed, defaultViewId: "gh-84055" });
    const first = await stored();
    await replaceListViews(db, LIST, { views: parsed, defaultViewId: "gh-84055" });

    expect(await stored()).toEqual(first);
  });

  test("follows a rename, a reorder and a move of the default tab", async () => {
    await replaceListViews(db, LIST, {
      views: [view("gh-1"), view("gh-2", { orderindex: 3 })],
      defaultViewId: "gh-1",
    });
    await replaceListViews(db, LIST, {
      views: [view("gh-1", { name: "Renamed", orderindex: 9 }), view("gh-2", { orderindex: 3 })],
      defaultViewId: "gh-2",
    });

    expect(await stored()).toEqual([
      expect.objectContaining({ id: "gh-2", orderindex: 3, isDefault: true }),
      expect.objectContaining({ id: "gh-1", orderindex: 9, name: "Renamed", isDefault: false }),
    ]);
  });
});
