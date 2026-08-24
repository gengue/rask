import { describe, expect, test } from "bun:test";
import type { TaskDetail } from "../src/lib/api.ts";
import { stableDetail } from "../src/lib/stable-detail.ts";

/**
 * The 30s poll on an open task, and the SSE push it triggers, hand the panel a
 * freshly parsed object whether or not ClickUp had anything new. Solid keys on
 * identity, so a new object for unchanged bytes rebuilds every comment and
 * re-injects every rendered body. These tests are about identity, not equality:
 * `toBe`, never `toEqual`.
 */
const detail = (over: Partial<TaskDetail> = {}): TaskDetail =>
  ({ id: "abc", name: "Ship it", comments: [], ...over }) as TaskDetail;

describe("stableDetail", () => {
  test("an unchanged detail comes back as the same object", () => {
    const stable = stableDetail();
    const first = stable(detail());

    expect(stable(detail())).toBe(first);
  });

  test("a changed detail is the new object", () => {
    const stable = stableDetail();
    stable(detail());
    const next = detail({ name: "Ship it later" });

    expect(stable(next)).toBe(next);
  });

  test("a change nested in the comments still counts as a change", () => {
    // The whole point of the poll: the task is untouched and the conversation
    // is what moved. Comparing only the shallow fields would swallow it.
    const stable = stableDetail();
    stable(detail());
    const next = detail({ comments: [{ id: "c1" }] as TaskDetail["comments"] });

    expect(stable(next)).toBe(next);
  });

  test("a different task is never the previous object", () => {
    // Two ids collapsing into one would show the wrong task's comments.
    const stable = stableDetail();
    const first = stable(detail());
    const other = detail({ id: "xyz" });

    expect(stable(other)).toBe(other);
    expect(stable(other)).not.toBe(first);
  });

  test("going back to a task re-reads it rather than reviving the old object", () => {
    // One slot, not a map: switching to another task and back is a fresh read,
    // so the panel can never be handed a snapshot that predates the trip. (A
    // close-and-reopen is a different path — the panel unmounts and the next
    // one gets its own closure — so this is the in-mount case.)
    const stable = stableDetail();
    const first = stable(detail());
    stable(detail({ id: "xyz" }));
    const again = detail();

    expect(stable(again)).toBe(again);
    expect(stable(again)).not.toBe(first);
  });
});
