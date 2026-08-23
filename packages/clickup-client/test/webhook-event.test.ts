import { describe, expect, test } from "bun:test";
import { webhookEvent } from "../src/schemas.ts";
import { signWebhookBody, verifyWebhookSignature } from "../src/webhook-signature.ts";
import createdFixture from "./fixtures/webhook-task-created.json" with { type: "json" };
import deletedFixture from "./fixtures/webhook-task-deleted.json" with { type: "json" };

/**
 * Real deliveries, captured off the wire.
 *
 * Both fixtures are bodies ClickUp actually posted to a temporary webhook
 * scoped to one list, on 2026-08-23. Only the person's name and email in
 * `history_items[].user` are replaced; every key, every type and the whole
 * shape are as they arrived.
 *
 * They are here because the docs describe a task event as an event name and an
 * id, and that is not what turns up.
 */
describe("a real delivery", () => {
  test("parses, and carries the five keys ClickUp actually sends", () => {
    const parsed = webhookEvent.parse(createdFixture);

    expect(parsed.event).toBe("taskCreated");
    expect(parsed.task_id).toBe("86cb8rm0t");
    expect(parsed.webhook_id).toBe("d8f7fbeb-7f3d-43b6-8104-bd24ba2ab535");
    // Undocumented, always present. Absent from the schema until a real
    // delivery showed it.
    expect(parsed.team_id).toBe("529");
    expect(Object.keys(createdFixture).sort()).toEqual([
      "event",
      "history_items",
      "task_id",
      "team_id",
      "webhook_id",
    ]);
  });

  test("carries a before/after diff, which is why the docs' summary misleads", () => {
    // "Only ever an id" was wrong. Recording what is really there so the next
    // person deciding whether to skip the GET can see what they would be
    // working with.
    const [first] = createdFixture.history_items;
    expect(first?.field).toBe("status");
    expect(first?.before).toMatchObject({ status: null });
    expect(first?.after).toMatchObject({ status: "to do" });
    expect(first?.user?.id).toBe(2462555);
  });

  test("describes only the fields that changed, which is why Rask re-reads", () => {
    // The reason the diff is not applied directly: a taskCreated event carries
    // a status change and a creation marker, and says nothing about the task's
    // name, list, assignees or dates. Applying it would mirror a task that is
    // mostly holes.
    const fields = createdFixture.history_items.map((item) => item.field).sort();
    expect(fields).toEqual(["status", "task_creation"]);
    expect(JSON.stringify(createdFixture)).not.toContain("assignee");
  });

  test("a deletion carries no history at all", () => {
    const parsed = webhookEvent.parse(deletedFixture);
    expect(parsed.event).toBe("taskDeleted");
    expect(parsed.task_id).toBe("86cb8rm0t");
    // Nothing to read back afterwards either, which is why the ingest path
    // treats this event and a 404 on read-back as the same outcome.
    expect(parsed.history_items).toEqual([]);
  });

  test("verifies under the signature scheme, on the exact bytes", () => {
    /*
     * The live secret is not here — that webhook is deleted and its secret was
     * never worth committing — so the body is re-signed with a throwaway one.
     * What this pins is that a payload of this real shape round-trips through
     * sign and verify.
     *
     * The claim it cannot make on its own is that our HMAC equals ClickUp's.
     * That was checked directly: four genuine deliveries (taskCreated,
     * taskStatusUpdated, taskUpdated, taskDeleted) all had an X-Signature
     * identical to `signWebhookBody(rawBody, secret)`, byte for byte.
     */
    const secret = "throwaway-secret-not-clickups";
    const raw = JSON.stringify(createdFixture);

    expect(
      verifyWebhookSignature({
        body: raw,
        signature: signWebhookBody(raw, secret),
        secrets: [secret],
      }),
    ).toBe(true);

    // One byte of the history diff is enough to invalidate it.
    const tampered = raw.replace('"to do"', '"complete"');
    expect(
      verifyWebhookSignature({
        body: tampered,
        signature: signWebhookBody(raw, secret),
        secrets: [secret],
      }),
    ).toBe(false);
  });
});
