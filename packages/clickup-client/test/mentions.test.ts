import { describe, expect, test } from "bun:test";
import { ClickUpClient } from "../src/client.ts";
import {
  findMentions,
  flattenMentions,
  formatMention,
  toCommentSegments,
} from "../src/mentions.ts";
import { RateLimiter } from "../src/rate-limit.ts";

const ROBERTO = formatMention({ id: 2462555, name: "Roberto Spinelli" });

describe("toCommentSegments", () => {
  test("returns null when there is nothing to tag", () => {
    // Plain comments keep using comment_text, which ClickUp formats itself.
    expect(toCommentSegments("just a comment")).toBeNull();
  });

  test("splits text around a mention", () => {
    expect(toCommentSegments(`Please look at this ${ROBERTO} thanks`)).toEqual([
      { text: "Please look at this " },
      { type: "tag", user: { id: 2462555 } },
      { text: " thanks" },
    ]);
  });

  test("handles a mention at the very start", () => {
    expect(toCommentSegments(`${ROBERTO} can you check`)).toEqual([
      { type: "tag", user: { id: 2462555 } },
      { text: " can you check" },
    ]);
  });

  test("handles a mention at the very end, with no trailing text", () => {
    expect(toCommentSegments(`over to ${ROBERTO}`)).toEqual([
      { text: "over to " },
      { type: "tag", user: { id: 2462555 } },
    ]);
  });

  test("keeps several mentions and the text between them", () => {
    const marta = formatMention({ id: 111, name: "Marta" });
    expect(toCommentSegments(`${ROBERTO} and ${marta}`)).toEqual([
      { type: "tag", user: { id: 2462555 } },
      { text: " and " },
      { type: "tag", user: { id: 111 } },
    ]);
  });

  test("leaves a bare @name alone, since it identifies nobody", () => {
    expect(toCommentSegments("hey @roberto")).toBeNull();
  });

  test("ignores a malformed mention rather than tagging the wrong person", () => {
    expect(toCommentSegments("@[Roberto](clickup://user/abc)")).toBeNull();
  });
});

describe("reading mentions back", () => {
  test("lists who was tagged", () => {
    expect(findMentions(`hi ${ROBERTO}`)).toEqual([{ id: 2462555, name: "Roberto Spinelli" }]);
  });

  test("flattens to the same shape ClickUp sends us", () => {
    expect(flattenMentions(`hi ${ROBERTO}, thanks`)).toBe("hi @Roberto Spinelli, thanks");
  });
});

describe("what actually goes over the wire", () => {
  test("a plain comment still sends comment_text", async () => {
    const { client, calls } = makeCommentClient();
    await client.createComment("9hz", { text: "on it" });

    expect(calls[0]?.body).toEqual({
      comment_text: "on it",
      assignee: undefined,
      notify_all: false,
    });
  });

  test("a comment with a mention sends structured segments instead", async () => {
    const { client, calls } = makeCommentClient();
    await client.createComment("9hz", { text: `over to ${ROBERTO}` });

    expect(calls[0]?.body).toEqual({
      comment: [{ text: "over to " }, { type: "tag", user: { id: 2462555 } }],
      assignee: undefined,
      notify_all: false,
    });
  });

  test("a reply carries mentions too", async () => {
    const { client, calls } = makeCommentClient();
    await client.createThreadedComment("c1", { text: `${ROBERTO} ping` });

    expect(calls[0]?.url).toContain("/v2/comment/c1/reply");
    expect(calls[0]?.body).toMatchObject({
      comment: [{ type: "tag", user: { id: 2462555 } }, { text: " ping" }],
    });
  });

  test("editing keeps resolved alongside the segments", async () => {
    const { client, calls } = makeCommentClient();
    await client.updateComment("c1", { text: `hi ${ROBERTO}`, resolved: true });

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toMatchObject({ resolved: true });
    expect((calls[0]?.body as { comment?: unknown } | undefined)?.comment).toBeDefined();
  });
});

function makeCommentClient() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ id: "1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return {
    calls,
    client: new ClickUpClient({
      token: "pk_1",
      fetch: fetchImpl,
      limiter: new RateLimiter({ capacity: 1e6, windowMs: 1, sleep: async () => {} }),
    }),
  };
}
