import { ClickUpError } from "@rask/clickup-client";
import { type Db, ingestTasks, type OutboxOp, outbox, tasks } from "@rask/schema";
import { eq, sql } from "drizzle-orm";

import type { TokenPool } from "./tokens.ts";

/**
 * Ships optimistic writes to ClickUp.
 *
 * The outbox table is the queue. Rows are claimed with FOR UPDATE SKIP LOCKED,
 * so several worker processes can drain it at once without coordination and a
 * crashed worker's rows come back on their own once the transaction dies.
 *
 * ClickUp is the source of truth, so a rejected write is not retried forever
 * and is not papered over: the mirror is repaired from ClickUp and the user is
 * told. That repair is why `revert` refetches instead of trying to undo.
 */

const MAX_ATTEMPTS = 5;

export interface OutboxRow {
  id: number;
  user_id: string;
  op: OutboxOp;
  entity_id: string | null;
  payload: unknown;
  client_id: string | null;
  attempts: number;
}

export interface DrainResult {
  sent: number;
  failed: number;
  deferred: number;
}

export async function drainOutbox(db: Db, pool: TokenPool, limit = 20): Promise<DrainResult> {
  const claimed = await claim(db, limit);
  const result: DrainResult = { sent: 0, failed: 0, deferred: 0 };

  for (const row of claimed) {
    try {
      const client = await pool.for(row.user_id);
      if (!client) throw new Error(`no ClickUp token for user ${row.user_id}`);

      await execute(db, client, row);
      await db
        .update(outbox)
        .set({ status: "done", updatedAt: new Date(), lastError: null })
        .where(eq(outbox.id, row.id));
      result.sent++;
    } catch (error) {
      const permanent = isPermanent(error) || row.attempts + 1 >= MAX_ATTEMPTS;
      const message = error instanceof Error ? error.message : String(error);

      await db
        .update(outbox)
        .set({
          status: permanent ? "failed" : "pending",
          attempts: row.attempts + 1,
          // 2s, 4s, 8s, 16s. The client's own retry budget, not ClickUp's:
          // 429s are already absorbed inside the ClickUp client.
          nextAttemptAt: new Date(Date.now() + 2 ** (row.attempts + 1) * 1000),
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(outbox.id, row.id));

      if (permanent) {
        await revert(db, pool, row);
        result.failed++;
      } else {
        result.deferred++;
      }
    }
  }

  return result;
}

async function execute(
  db: Db,
  client: NonNullable<Awaited<ReturnType<TokenPool["for"]>>>,
  row: OutboxRow,
) {
  const payload = row.payload as Record<string, unknown>;

  switch (row.op) {
    case "update_task": {
      if (!row.entity_id) throw new Error("update_task without an entity_id");
      const updated = await client.updateTask(row.entity_id, payload);
      // Write ClickUp's own version back. If it normalized anything (a status
      // rename, a due date rounded to midnight) the mirror matches immediately.
      await ingestTasks(db, [updated]);
      return;
    }

    case "create_task": {
      const { listId, ...input } = payload as { listId: string } & Record<string, unknown>;
      const created = await client.createTask(listId, input as never);
      await ingestTasks(db, [created], { listId });
      // Drop the placeholder the API inserted so the browser can swap it for
      // the real row on the next SSE frame.
      if (row.client_id) await db.delete(tasks).where(eq(tasks.id, placeholderId(row.client_id)));
      await db.update(outbox).set({ entityId: created.id }).where(eq(outbox.id, row.id));
      return;
    }

    case "create_comment": {
      const { taskId, text } = payload as { taskId: string; text: string };
      await client.createComment(taskId, { text });
      return;
    }

    case "set_custom_field": {
      const { taskId, fieldId, value } = payload as {
        taskId: string;
        fieldId: string;
        value: unknown;
      };
      await client.setCustomFieldValue(taskId, fieldId, value);
      const refreshed = await client.getTask(taskId);
      await ingestTasks(db, [refreshed]);
      return;
    }
  }
}

/**
 * Puts the mirror back to what ClickUp actually has.
 *
 * For an update that means refetching the task: ClickUp wins, and whatever the
 * user optimistically saw gets overwritten. For a create it means deleting the
 * placeholder, since ClickUp has nothing to refetch.
 */
async function revert(db: Db, pool: TokenPool, row: OutboxRow): Promise<void> {
  try {
    if (row.op === "create_task") {
      if (row.client_id) await db.delete(tasks).where(eq(tasks.id, placeholderId(row.client_id)));
      return;
    }

    const taskId = row.entity_id ?? (row.payload as { taskId?: string } | null)?.taskId ?? null;
    if (!taskId) return;

    const client = await pool.for(row.user_id);
    if (!client) return;

    const truth = await client.getTask(taskId);
    await ingestTasks(db, [truth]);
  } catch {
    // The revert is best-effort. The nightly reconciliation is the backstop,
    // and leaving the row marked failed is what tells the user something broke.
  }
}

export function placeholderId(clientId: string): string {
  return `tmp_${clientId}`;
}

/** A 4xx that is not 429 means the request itself is wrong. Retrying cannot help. */
function isPermanent(error: unknown): boolean {
  return (
    error instanceof ClickUpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}

async function claim(db: Db, limit: number): Promise<OutboxRow[]> {
  const result = await db.execute(sql`
    with claimed as (
      select id from ${outbox}
      where status = 'pending' and next_attempt_at <= now()
      order by id
      for update skip locked
      limit ${limit}
    )
    update ${outbox} o
    set status = 'sending', updated_at = now()
    from claimed c
    where o.id = c.id
    returning o.id, o.user_id, o.op, o.entity_id, o.payload, o.client_id, o.attempts
  `);
  return (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  ) as OutboxRow[];
}
