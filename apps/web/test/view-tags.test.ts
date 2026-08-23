import { describe, expect, test } from "bun:test";
import { uniqueTags } from "../src/lib/view.ts";

/**
 * My Tasks spans every Space, so its tag menu is the union of theirs. Offering
 * only the first row's Space hid `ventura ai` — 118 tasks — behind a tag used
 * once, which is the failure this collapses.
 */
describe("uniqueTags", () => {
  test("offers a name shared by two Spaces once, keeping the first colour", () => {
    const tags = uniqueTags([
      { name: "urgent", bg: "#f00", fg: "#fff" },
      { name: "urgent", bg: "#00f", fg: "#fff" },
    ]);

    expect(tags).toHaveLength(1);
    expect(tags[0]?.bg).toBe("#f00");
  });

  test("sorts by name, so a menu is not ordered by which Space answered first", () => {
    const tags = uniqueTags([
      { name: "venturaos", bg: null, fg: null },
      { name: "ventura ai", bg: null, fg: null },
      { name: "ventura-ai", bg: null, fg: null },
    ]);

    expect(tags.map((tag) => tag.name)).toEqual(["ventura ai", "ventura-ai", "venturaos"]);
  });
});
