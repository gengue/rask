import { describe, expect, test } from "bun:test";
import { clickUpTaskUrl, raskTaskUrl, taskMenuItems } from "../src/lib/task-menu.ts";

/**
 * What the right-click menu offers, as a plain function of the task.
 *
 * The menu itself is a popover in the shell and cannot be asserted here — see
 * the note in `select-rows.test.ts` about `bun test` and the Solid server
 * build. What can be: which entries a given task earns, and the two addresses
 * they copy, both of which are strings other people paste into other apps.
 */

describe("task URLs", () => {
  test("the ClickUp address is the one ClickUp itself uses", () => {
    expect(clickUpTaskUrl("86a1b2c3")).toBe("https://app.clickup.com/t/86a1b2c3");
  });

  test("Rask's own link reuses the /t/ shape its catch-all route already resolves", () => {
    expect(raskTaskUrl("https://rask.example", "86a1b2c3")).toBe("https://rask.example/t/86a1b2c3");
  });

  test("a trailing slash on the origin does not double up", () => {
    expect(raskTaskUrl("https://rask.example/", "86a1b2c3")).toBe(
      "https://rask.example/t/86a1b2c3",
    );
  });
});

describe("taskMenuItems", () => {
  test("offers the whole set for a task ClickUp knows about", () => {
    expect(taskMenuItems({ id: "86a1b2c3" }).map((item) => item.id)).toEqual([
      "open",
      "copy-id",
      "copy-link",
      "copy-clickup",
      "status",
      "priority",
      "archive",
      "delete",
    ]);
  });

  test("a task that has not reached ClickUp yet has no address to copy and nothing to delete", () => {
    // Every entry dropped here needs a ClickUp id: two of them are links that
    // would 404, and the other two are writes the outbox refuses with a 409.
    // Copy Task ID stays: the local placeholder id is a real address inside
    // this app even before ClickUp has one.
    expect(taskMenuItems({ id: "tmp_9f2b" }).map((item) => item.id)).toEqual([
      "open",
      "copy-id",
      "status",
      "priority",
    ]);
  });

  test("the entries that also have a keystroke say so", () => {
    const hints = Object.fromEntries(
      taskMenuItems({ id: "86a1b2c3" }).map((item) => [item.id, item.hint]),
    );
    expect(hints.open).toBe("o");
    expect(hints.status).toBe("s");
    expect(hints.priority).toBe("p");
    expect(hints.archive).toBeUndefined();
  });
});
