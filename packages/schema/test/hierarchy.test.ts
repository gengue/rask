import { describe, expect, test } from "bun:test";
import { clickUpList } from "@rask/clickup-client";
import { mapList } from "../src/map.ts";

/**
 * ClickUp has no such thing as a folderless list.
 *
 * What the UI shows at the top of a Space is a list inside an implicit folder
 * flagged `hidden`, and that folder never comes back from
 * GET /space/{id}/folder. Storing its id points the list at a parent that does
 * not exist, and the list vanishes from the sidebar — which is exactly what
 * happened to three lists in the AI space.
 */
describe("mapList folder resolution", () => {
  const base = { id: "901516038590", name: "AI Tasks" };

  test("treats a hidden folder as no folder", () => {
    const list = clickUpList.parse({
      ...base,
      folder: { id: "901510324892", name: "hidden", hidden: true },
      space: { id: "90157146054" },
    });

    expect(mapList(list, { spaceId: "90157146054", folderId: null }).folderId).toBeNull();
  });

  test("keeps a real folder", () => {
    const list = clickUpList.parse({
      ...base,
      folder: { id: "901517125026", name: "julian-agent", hidden: false },
      space: { id: "90157146054" },
    });

    expect(mapList(list, { spaceId: "90157146054", folderId: "901517125026" }).folderId).toBe(
      "901517125026",
    );
  });

  test("falls back to the folder it was fetched under when the payload omits one", () => {
    const list = clickUpList.parse({ ...base, space: { id: "90157146054" } });

    expect(mapList(list, { spaceId: "90157146054", folderId: "901517125026" }).folderId).toBe(
      "901517125026",
    );
  });

  test("still records the space either way", () => {
    const list = clickUpList.parse({
      ...base,
      folder: { id: "901510324892", hidden: true },
      space: { id: "90157146054" },
    });

    expect(mapList(list, { spaceId: "fallback" }).spaceId).toBe("90157146054");
  });
});
