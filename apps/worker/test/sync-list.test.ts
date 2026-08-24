import { beforeEach, expect, test } from "bun:test";
import { ClickUpClient, RateLimiter } from "@rask/clickup-client";
import { createTestDb, syncCursors, tasks } from "@rask/schema";
import { and, asc, eq, like } from "drizzle-orm";
import { syncList } from "../src/sync.ts";

/**
 * What a list read leaves behind when it does not finish.
 *
 * A full read of a busy list is many pages and any of them can fail. The only
 * thing standing between that and tasks that are silently invisible is which
 * end of the list the cursor is standing on when the error lands, so this test
 * cuts the pagination in half on purpose and asks what the mirror believes
 * afterwards.
 */

const db = createTestDb();
const LIST = "sync-list-test-list";
const PREFIX = "sync-list-test-";

/** Four tasks, two per page, so the read has to survive a page boundary. */
const UNIVERSE = [
  { id: `${PREFIX}1`, updated: 1_000 },
  { id: `${PREFIX}2`, updated: 2_000 },
  { id: `${PREFIX}3`, updated: 3_000 },
  { id: `${PREFIX}4`, updated: 4_000 },
];
const PAGE_SIZE = 2;

/**
 * ClickUp as it actually answers, which is the whole point of this fake.
 *
 * `order_by=updated` is newest first, and `reverse=true` turns it around —
 * measured against the real API rather than read off the spec, which says only
 * "tasks are displayed in reverse order". Getting this backwards here would
 * make the test agree with any implementation.
 */
function clickUp(failFromPage: number | null) {
  const requested: number[] = [];

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const page = Number(url.searchParams.get("page") ?? 0);
    const after = Number(url.searchParams.get("date_updated_gt") ?? -1);
    const oldestFirst = url.searchParams.get("reverse") === "true";
    requested.push(page);

    if (failFromPage !== null && page >= failFromPage) {
      return new Response(JSON.stringify({ err: "boom" }), { status: 500 });
    }

    const matching = UNIVERSE.filter((t) => t.updated > after);
    const ordered = oldestFirst ? matching : [...matching].reverse();
    const slice = ordered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    return new Response(
      JSON.stringify({
        tasks: slice.map((t) => ({
          id: t.id,
          name: `task ${t.id}`,
          date_updated: String(t.updated),
          list: { id: LIST, name: "List" },
        })),
        last_page: (page + 1) * PAGE_SIZE >= ordered.length,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  const client = new ClickUpClient({
    token: "pk_test",
    fetch: fetchImpl,
    limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
    maxRetries: 0,
    sleep: async () => {},
  });

  return { client, requested };
}

async function mirrored(): Promise<string[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(like(tasks.id, `${PREFIX}%`))
    .orderBy(asc(tasks.id));
  return rows.map((r) => r.id);
}

async function cursor() {
  const [row] = await db
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.scope, "list"), eq(syncCursors.scopeId, LIST)))
    .limit(1);
  return row ?? null;
}

beforeEach(async () => {
  await db.delete(tasks).where(like(tasks.id, `${PREFIX}%`));
  await db.delete(syncCursors).where(eq(syncCursors.scopeId, LIST));
  await db.insert(syncCursors).values({ scope: "list", scopeId: LIST });
});

test("a read that dies halfway resumes from what it stored, not past it", async () => {
  const first = clickUp(1);
  await expect(syncList(db, first.client, LIST, {})).rejects.toThrow();

  // Page 0 committed, page 1 never arrived.
  expect(await mirrored()).toEqual([`${PREFIX}1`, `${PREFIX}2`]);
  const stopped = await cursor();
  expect(stopped?.lastUpdatedAt?.getTime()).toBe(2_000);

  // The rest of the list is still ahead of the cursor, so the next read finds
  // it. With the newest page committing first this cursor would read 4000 and
  // tasks 3 and 4 would be invisible until the nightly full pass.
  const second = clickUp(null);
  await syncList(db, second.client, LIST, {});
  expect(await mirrored()).toEqual([`${PREFIX}1`, `${PREFIX}2`, `${PREFIX}3`, `${PREFIX}4`]);
});

test("a failed read is still a read, so nothing retries it in three seconds", async () => {
  const { client } = clickUp(0);
  await expect(syncList(db, client, LIST, {})).rejects.toThrow();

  const row = await cursor();
  // `lastRunAt` is what takes a list out of the cold set; a list ClickUp is
  // refusing has to leave it after one attempt and back off with the poll.
  expect(row?.lastRunAt).not.toBeNull();
  expect(row?.failures).toBe(1);
  expect(row?.lastError).toContain("500");
});
