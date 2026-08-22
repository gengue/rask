import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/rate-limit.ts";

/** Virtual clock: sleeps advance time instantly, so the tests run in microseconds. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("RateLimiter", () => {
  test("lets the first `capacity` requests through without waiting", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ capacity: 100, windowMs: 60_000, ...clock });

    const before = clock.now();
    for (let i = 0; i < 100; i++) await limiter.acquire();

    expect(clock.now()).toBe(before);
  });

  test("makes request 101 wait for the bucket to refill", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ capacity: 100, windowMs: 60_000, ...clock });

    for (let i = 0; i < 100; i++) await limiter.acquire();
    const before = clock.now();
    await limiter.acquire();

    // One token at 100/60s is 600ms.
    expect(clock.now() - before).toBe(600);
  });

  test("refills continuously, so waiting a window restores the full bucket", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ capacity: 10, windowMs: 1000, ...clock });

    for (let i = 0; i < 10; i++) await limiter.acquire();
    clock.advance(1000);

    const before = clock.now();
    for (let i = 0; i < 10; i++) await limiter.acquire();
    expect(clock.now() - before).toBe(0);
  });

  test("trusts the server's remaining count over its own when the server is lower", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ capacity: 100, windowMs: 60_000, ...clock });

    limiter.syncFromHeaders(new Headers({ "x-ratelimit-remaining": "0" }));

    const before = clock.now();
    await limiter.acquire();
    expect(clock.now()).toBeGreaterThan(before);
  });

  test("never raises its own count from the server's header", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ capacity: 5, windowMs: 60_000, ...clock });

    for (let i = 0; i < 5; i++) await limiter.acquire();
    // A stale header claiming plenty left must not refill us early.
    limiter.syncFromHeaders(new Headers({ "x-ratelimit-remaining": "99" }));

    const before = clock.now();
    await limiter.acquire();
    expect(clock.now()).toBeGreaterThan(before);
  });

  test("holds everything until X-RateLimit-Reset after a 429", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ capacity: 100, windowMs: 60_000, ...clock });

    const resetAt = Math.floor((clock.now() + 30_000) / 1000);
    limiter.blockUntilReset(String(resetAt));

    const before = clock.now();
    await limiter.acquire();
    expect(clock.now() - before).toBeGreaterThanOrEqual(29_000);
  });

  test("falls back to a full window when the reset header is missing", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ capacity: 100, windowMs: 60_000, ...clock });

    expect(limiter.blockUntilReset(null)).toBe(60_000);
  });

  test("serializes concurrent callers instead of handing out the same token twice", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ capacity: 2, windowMs: 1000, ...clock });

    const stamps: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, () => limiter.acquire().then(() => stamps.push(clock.now()))),
    );

    // Two go immediately, the next two each wait 500ms (2 tokens per 1000ms).
    expect(stamps).toEqual([1_000_000, 1_000_000, 1_000_500, 1_001_000]);
  });
});
