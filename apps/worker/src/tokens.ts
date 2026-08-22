import { ClickUpClient, RateLimiter } from "@rask/clickup-client";
import { type Db, loadToken, oauthTokens } from "@rask/schema";

/**
 * The pool of ClickUp clients the worker syncs with.
 *
 * ClickUp meters 100 req/min per token, so N logged-in users give the worker
 * N x 100 req/min in aggregate as long as each token keeps its own bucket.
 * Round-robin spreads ingestion across all of them.
 *
 * ponytail: any user's token can sync any list. Everyone on this team shares
 * one workspace, so the mirror is the same either way. The day Rask needs to
 * respect private lists, this becomes a per-user visibility filter on read
 * rather than a change to how ingestion is scheduled.
 */
export class TokenPool {
  private clients: Array<{ userId: string; client: ClickUpClient; teamId: string }> = [];
  private cursor = 0;

  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  async refresh(): Promise<number> {
    const rows = await this.db.select({ userId: oauthTokens.userId }).from(oauthTokens);
    const known = new Set(this.clients.map((c) => c.userId));

    for (const row of rows) {
      if (known.has(row.userId)) continue;
      const token = await loadToken(this.db, row.userId, this.key);
      if (!token) continue;
      this.clients.push({
        userId: row.userId,
        teamId: token.teamId,
        // One limiter per token. Sharing one across tokens would throttle the
        // pool down to a single user's quota.
        client: new ClickUpClient({ token: token.token, limiter: new RateLimiter() }),
      });
    }

    const live = new Set(rows.map((r) => r.userId));
    this.clients = this.clients.filter((c) => live.has(c.userId));
    return this.clients.length;
  }

  next(): { userId: string; client: ClickUpClient; teamId: string } | null {
    if (this.clients.length === 0) return null;
    const entry = this.clients[this.cursor % this.clients.length];
    this.cursor++;
    return entry ?? null;
  }

  /** The specific user's client. Writes must go out under their own token. */
  async for(userId: string): Promise<ClickUpClient | null> {
    const existing = this.clients.find((c) => c.userId === userId);
    if (existing) return existing.client;
    const token = await loadToken(this.db, userId, this.key);
    if (!token) return null;
    const client = new ClickUpClient({ token: token.token, limiter: new RateLimiter() });
    this.clients.push({ userId, client, teamId: token.teamId });
    return client;
  }

  get size(): number {
    return this.clients.length;
  }
}
