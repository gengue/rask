import { describe, expect, test } from "bun:test";
import { applyMention, mentionQueryAt } from "../src/lib/mention-query.ts";

const at = (text: string) => mentionQueryAt(text, text.length);

describe("mentionQueryAt", () => {
  test("finds a bare @ with nothing typed yet", () => {
    expect(at("hey @")).toEqual({ start: 4, term: "" });
  });

  test("finds the term being typed", () => {
    expect(at("hey @rob")).toEqual({ start: 4, term: "rob" });
  });

  test("works at the very start of the box", () => {
    expect(at("@rob")).toEqual({ start: 0, term: "rob" });
  });

  test("ignores an @ inside a word, which is usually an email", () => {
    expect(at("write to roberto@ventura")).toBeNull();
  });

  test("stops at a newline, since the user moved on", () => {
    expect(at("hey @rob\nand also")).toBeNull();
  });

  test("stops once a mention is complete", () => {
    expect(at("@[Roberto](clickup://user/1)")).toBeNull();
  });

  test("gives up on a term too long to be a name", () => {
    expect(at(`@${"x".repeat(40)}`)).toBeNull();
  });

  test("uses the caret, not the end of the text", () => {
    const text = "hey @rob and more";
    expect(mentionQueryAt(text, 8)).toEqual({ start: 4, term: "rob" });
  });

  test("returns nothing when there is no @ at all", () => {
    expect(at("plain comment")).toBeNull();
  });
});

describe("applyMention", () => {
  test("replaces the token and leaves the caret after a trailing space", () => {
    const text = "hey @rob";
    const query = mentionQueryAt(text, text.length);
    if (!query) throw new Error("expected a query");

    const result = applyMention(text, query, text.length, "@[Roberto](clickup://user/1)");
    expect(result.text).toBe("hey @[Roberto](clickup://user/1) ");
    expect(result.caret).toBe(result.text.length);
  });

  test("keeps whatever followed the caret", () => {
    const text = "hey @rob and more";
    const query = mentionQueryAt(text, 8);
    if (!query) throw new Error("expected a query");

    expect(applyMention(text, query, 8, "@[R](clickup://user/1)").text).toBe(
      "hey @[R](clickup://user/1)  and more",
    );
  });
});
