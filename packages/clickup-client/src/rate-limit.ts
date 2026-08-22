/**
 * Token bucket sized for ClickUp's per-token quota (100 req/min on Business).
 *
 * Two things keep it honest:
 *  - Local accounting refills continuously, so a burst of 100 calls drains the
 *    bucket and the 101st waits instead of eating a 429.
 *  - Every response feeds `syncFromHeaders` back in. ClickUp's own counter is
 *    the source of truth; ours only ever gets clamped down to match it, never up.
 */

export type Clock = () => number;
export type Sleeper = (ms: number) => Promise<void>;

const defaultSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RateLimiterOptions {
  /** Requests allowed per window. ClickUp Business: 100. */
  capacity?: number;
  /** Window length in ms. ClickUp: 60_000. */
  windowMs?: number;
  now?: Clock;
  sleep?: Sleeper;
}

export class RateLimiter {
  readonly capacity: number;
  readonly windowMs: number;

  private tokens: number;
  private lastRefill: number;
  /** Epoch ms. Set from X-RateLimit-Reset after a 429; nothing goes out before it. */
  private blockedUntil = 0;
  /** Serializes waiters so concurrent callers can't all claim the same token. */
  private chain: Promise<void> = Promise.resolve();

  private readonly now: Clock;
  private readonly sleep: Sleeper;

  constructor(options: RateLimiterOptions = {}) {
    this.capacity = options.capacity ?? 100;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /** Resolves once this caller is cleared to send. FIFO across concurrent callers. */
  acquire(): Promise<void> {
    const turn = this.chain.then(() => this.take());
    // Keep the chain alive even if one waiter rejects.
    this.chain = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  private async take(): Promise<void> {
    for (;;) {
      const wait = this.msUntilAvailable();
      if (wait === 0) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(wait);
    }
  }

  private msUntilAvailable(): number {
    const t = this.now();

    if (t < this.blockedUntil) return this.blockedUntil - t;

    const elapsed = t - this.lastRefill;
    if (elapsed > 0) {
      const perMs = this.capacity / this.windowMs;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * perMs);
      this.lastRefill = t;
    }

    if (this.tokens >= 1) return 0;
    // Round up so we never wake a hair early and spin.
    return Math.ceil((1 - this.tokens) * (this.windowMs / this.capacity));
  }

  /**
   * Reconcile with what ClickUp says. Only clamps down: if the server reports
   * fewer requests left than we think, believe the server.
   */
  syncFromHeaders(headers: Headers): void {
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(remaining) && remaining >= 0) {
      this.lastRefill = this.now();
      this.tokens = Math.min(this.tokens, remaining);
    }
  }

  /** Called on a 429. `reset` is the X-RateLimit-Reset header (epoch seconds). */
  blockUntilReset(reset: string | null): number {
    const t = this.now();
    const resetSeconds = Number(reset);
    // Fall back to a full window if the header is missing or already in the past.
    const until =
      Number.isFinite(resetSeconds) && resetSeconds * 1000 > t
        ? resetSeconds * 1000
        : t + this.windowMs;
    this.blockedUntil = Math.max(this.blockedUntil, until);
    this.tokens = 0;
    this.lastRefill = t;
    return this.blockedUntil - t;
  }
}
