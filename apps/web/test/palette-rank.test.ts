import { describe, expect, test } from "bun:test";
import { rankCommands } from "../src/lib/rank.ts";

const commands = [
  { id: "1", label: "Engineering", section: "Space", run: () => {} },
  { id: "2", label: "Marketing Team Tasks", section: "Space", run: () => {} },
  {
    id: "3",
    label: "TS preparation - DMC trips / VEOT (Venezuela Online)",
    section: "Ops",
    run: () => {},
  },
  { id: "4", label: "Invoice audit", section: "Finance", run: () => {} },
];

const labels = (query: string) => rankCommands(commands, query).map((c) => c.label);

describe("command ranking", () => {
  test("short queries match as an abbreviation", () => {
    // The whole point of subsequence matching: three letters, right answer.
    expect(labels("eng")[0]).toBe("Engineering");
  });

  test("a longer query has to actually appear", () => {
    // "invoice" is a subsequence of the VEOT string. It is not a match.
    expect(labels("invoice")).toEqual(["Invoice audit"]);
  });

  test("matches the section as well as the label", () => {
    expect(labels("finance")).toEqual(["Invoice audit"]);
  });

  test("an empty query leaves the list alone", () => {
    expect(labels("")).toHaveLength(4);
  });

  test("no match yields nothing rather than everything", () => {
    expect(labels("zzzzz")).toEqual([]);
  });
});
