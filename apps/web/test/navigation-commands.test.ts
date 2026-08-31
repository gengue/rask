import { describe, expect, test } from "bun:test";
import { buildNavigationCommands } from "../src/components/CommandPalette.tsx";
import type { DocRef, Space } from "../src/lib/api.ts";

/**
 * What ⌘K can reach.
 *
 * The sidebar's argument for hiding itself on a narrow window is that this
 * palette navigates to anything by typing it. Every row the tree draws and this
 * does not is that claim being quietly false — and a missing row here looks
 * exactly like a row that does not exist.
 */

const doc = (id: string, name: string): DocRef => ({ id, name });

const SPACES: Space[] = [
  {
    id: "space-ai",
    name: "AI",
    docs: [doc("d-space", "AI Release notes")],
    lists: [{ id: "list-loose", name: "AI Tasks", docs: [doc("d-loose", "Backlog notes")] }],
    folders: [
      {
        id: "folder-execs",
        name: "Executives",
        docs: [doc("d-folder", "Team charter")],
        lists: [{ id: "list-nested", name: "Strategy", docs: [doc("d-nested", "Sprint notes")] }],
      },
    ],
  },
];

const WORKSPACE_DOCS = [doc("d-workspace", "Company handbook")];

function build() {
  const listed: string[] = [];
  const opened: string[] = [];
  const commands = buildNavigationCommands(
    { spaces: SPACES, docs: WORKSPACE_DOCS },
    { list: (id) => listed.push(id), doc: (id) => opened.push(id) },
  );
  return { commands, listed, opened };
}

test("offers every List and every Doc the tree draws", () => {
  const { commands } = build();

  expect(commands.map((command) => command.id).sort()).toEqual([
    "doc:d-folder",
    "doc:d-loose",
    "doc:d-nested",
    "doc:d-space",
    "doc:d-workspace",
    "list:list-loose",
    "list:list-nested",
  ]);
});

test("runs the right navigation for each kind", () => {
  const { commands, listed, opened } = build();

  commands.find((command) => command.id === "list:list-nested")?.run();
  commands.find((command) => command.id === "doc:d-space")?.run();

  expect(listed).toEqual(["list-nested"]);
  expect(opened).toEqual(["d-space"]);
});

describe("labels", () => {
  const labelOf = (id: string) => build().commands.find((command) => command.id === id)?.label;

  test("names the path down to a Doc, so two Sprint notes are told apart", () => {
    expect(labelOf("doc:d-nested")).toBe("Executives / Strategy / Sprint notes");
    expect(labelOf("doc:d-loose")).toBe("AI Tasks / Backlog notes");
    expect(labelOf("doc:d-folder")).toBe("Executives / Team charter");
    expect(labelOf("doc:d-space")).toBe("AI Release notes");
  });

  /*
   * Workspace Docs have no Space to file them under, and the sidebar gives them
   * a section of their own for the same reason.
   */
  test("files a workspace Doc under Docs rather than under a Space", () => {
    const { commands } = build();
    expect(commands.find((command) => command.id === "doc:d-workspace")?.section).toBe("Docs");
  });
});

/*
 * A Doc and a List can carry the same name, and both end up in one flat list of
 * commands. Prefixing the id by kind is what keeps them from colliding — the
 * palette keys its rows by id.
 */
test("a Doc and a List of the same name are two commands", () => {
  const clash: Space[] = [
    { id: "s", name: "S", docs: [doc("d1", "Roadmap")], lists: [], folders: [] },
  ];
  clash[0]?.lists.push({ id: "l1", name: "Roadmap", docs: [] });

  const commands = buildNavigationCommands(
    { spaces: clash, docs: [] },
    { list: () => {}, doc: () => {} },
  );

  expect(commands).toHaveLength(2);
  expect(new Set(commands.map((command) => command.id)).size).toBe(2);
});
