import { afterEach, beforeEach, expect, test } from "bun:test";
import { ClickUpClient, RateLimiter } from "@rask/clickup-client";
import { createTestDb, lists, spaces } from "@rask/schema";
import { eq, like } from "drizzle-orm";
import { syncHierarchy } from "../src/sync.ts";

/**
 * Where a List's statuses come from, which is two different places.
 *
 * A List inside a Folder arrives from `GET /space/{id}/folder` with its
 * effective status set inlined. A folderless one arrives from
 * `GET /space/{id}/list` with `override_statuses` and no `statuses` field at
 * all — measured against the workspace, and the vendored spec agrees. So a
 * folderless List that overrides its Space has no statuses anywhere in the tree
 * walk, and every status picker fell back to the Space's set: four names the
 * List does not have and none of the ones it does.
 */

const db = createTestDb();
const TEAM = "hierarchy-test-team";
const SPACE = "hierarchy-test-space";
const OVERRIDER = "hierarchy-test-overrider";
const INHERITOR = "hierarchy-test-inheritor";
const IN_FOLDER = "hierarchy-test-in-folder";

const SPACE_STATUSES = [
  { status: "to do", color: "#87909e", type: "open", orderindex: 0 },
  { status: "done", color: "#008844", type: "closed", orderindex: 1 },
];

/** What the overriding List actually has, and only `GET /list/{id}` says so. */
const OWN_STATUSES = [
  { status: "planned", color: "#0091ff", type: "unstarted", orderindex: 0 },
  { status: "review", color: "#ab4aba", type: "custom", orderindex: 1 },
  { status: "complete", color: "#008844", type: "closed", orderindex: 2 },
];

/** ClickUp as it answers the four calls a tree walk makes. */
function clickUp(options: { listDetailFails?: boolean; emptyStatuses?: boolean } = {}) {
  const calls: string[] = [];

  const fetchImpl = (async (input: string | URL | Request) => {
    // The client's base carries an `/api` prefix; the routes below are the
    // paths it appends to it.
    const path = new URL(typeof input === "string" ? input : input.toString()).pathname.replace(
      /^\/api/,
      "",
    );
    calls.push(path);

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (path === `/v2/team/${TEAM}/space`) {
      return json({ spaces: [{ id: SPACE, name: "Space", statuses: SPACE_STATUSES }] });
    }

    if (path === `/v2/space/${SPACE}/folder`) {
      return json({
        folders: [
          {
            id: "hierarchy-test-folder",
            name: "Folder",
            // A List in a Folder carries the set it uses, inlined, and says
            // "false" about overriding anything itself.
            lists: [
              {
                id: IN_FOLDER,
                name: "In a folder",
                override_statuses: false,
                statuses: OWN_STATUSES,
              },
            ],
          },
        ],
      });
    }

    if (path === `/v2/space/${SPACE}/list`) {
      return json({
        lists: [
          { id: OVERRIDER, name: "Overrides", override_statuses: true },
          { id: INHERITOR, name: "Inherits", override_statuses: false },
        ],
      });
    }

    if (path === `/v2/list/${OVERRIDER}`) {
      if (options.listDetailFails) {
        return new Response(JSON.stringify({ err: "boom" }), { status: 500 });
      }
      return json({
        id: OVERRIDER,
        name: "Overrides",
        override_statuses: true,
        statuses: options.emptyStatuses ? [] : OWN_STATUSES,
      });
    }

    return new Response(JSON.stringify({ err: `unexpected ${path}` }), { status: 404 });
  }) as typeof globalThis.fetch;

  const client = new ClickUpClient({
    token: "pk_test",
    fetch: fetchImpl,
    limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
    maxRetries: 0,
    sleep: async () => {},
  });

  return { client, calls };
}

async function statusesOf(listId: string) {
  const [row] = await db.select().from(lists).where(eq(lists.id, listId));
  return row?.statuses ?? null;
}

const clean = async () => {
  await db.delete(lists).where(like(lists.id, "hierarchy-test-%"));
  await db.delete(spaces).where(like(spaces.id, "hierarchy-test-%"));
};

beforeEach(clean);
afterEach(clean);

test("re-reads a folderless List that overrides, and only that one", async () => {
  const { client, calls } = clickUp();
  const stats = await syncHierarchy(db, client, TEAM);

  expect(await statusesOf(OVERRIDER)).toHaveLength(3);
  expect((await statusesOf(OVERRIDER))?.[1]).toMatchObject({ status: "review", type: "custom" });

  // Nothing said what this one has, and nothing needed to: it uses its Space's
  // set, which `statusesForList` falls back to.
  expect(await statusesOf(INHERITOR)).toBeNull();

  // Inlined by the Folder payload, so it is stored without a second request —
  // and it is stored even though the flag says the List overrides nothing,
  // because a Folder that overrides is exactly what that inherited set is.
  expect(await statusesOf(IN_FOLDER)).toHaveLength(3);

  expect(calls.filter((path) => path.startsWith("/v2/list/"))).toEqual([`/v2/list/${OVERRIDER}`]);
  // 1 space call + folder + list per space + the one re-read.
  expect(stats.requests).toBe(4);
});

test("a List detail that fails keeps the set already mirrored", async () => {
  // Mirrored by an earlier, working sync.
  await db.insert(lists).values({
    id: OVERRIDER,
    spaceId: SPACE,
    name: "Overrides",
    statuses: OWN_STATUSES,
  });

  const { client } = clickUp({ listDetailFails: true });
  await syncHierarchy(db, client, TEAM);

  // `upsertLists` writes every column it names, so storing the shallow row
  // would blank this and put the picker back on the Space's set — today's bug,
  // reintroduced by one 500.
  expect(await statusesOf(OVERRIDER)).toHaveLength(3);

  // And the rest of the tree still lands, rather than a walk that stopped here.
  expect(await statusesOf(IN_FOLDER)).toHaveLength(3);
  expect(await statusesOf(INHERITOR)).toBeNull();
});

test("an empty set is not a set", async () => {
  // ClickUp answering `statuses: []` would otherwise be stored as an override
  // of nothing, and `statusesForList` returns the List's set ahead of the
  // Space's — an empty status picker on a List that has four.
  const { client } = clickUp({ emptyStatuses: true });
  await syncHierarchy(db, client, TEAM);

  expect(await statusesOf(OVERRIDER)).toBeNull();
});
