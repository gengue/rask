import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema.ts";

/**
 * Bun names a prepared statement after the first 40 characters of the SQL plus
 * a per-connection counter (Signature.zig, unchanged on Bun main). Drizzle's
 * generated selects share those 40 characters across many distinct queries —
 * every tasks select starts `select "id", "custom_id", "name", "statu` — and
 * under concurrency two of them can end up behind one name on one connection
 * (oven-sh/bun#30494, still live in 1.3.14). The server then binds one query's
 * parameters to the other's plan: `bind message supplies 1 parameters, but
 * prepared statement requires 3` on random routes — or, worse, silently
 * returns the wrong rows. That was the e2e flake of 2026-08-29: 5/2/4
 * unrelated specs red across three runs, no overlap.
 *
 * The fix is to deny the collision its precondition: prefix every query with a
 * comment carrying a hash of its full text, so no two distinct queries agree
 * on their first 40 characters no matter which counter values they race to.
 * `prepare: false` would also do it, but trades this bug for oven-sh/bun#39450
 * — unnamed statements stringify object parameters as `[object Object]`,
 * which breaks every jsonb column we have.
 */
function fingerprint(query: string): string {
  return `/*q${Bun.hash(query).toString(36)}*/`;
}

type BunSQL = InstanceType<typeof SQL>;

/**
 * Wraps the three client entry points Drizzle's bun-sql session uses:
 * `unsafe` for every query, `begin` for transactions, `savepoint` for nested
 * ones. The transaction callbacks receive a connection-bound client, so those
 * are wrapped recursively. Everything else passes through untouched.
 */
function withFingerprints(client: BunSQL): BunSQL {
  return new Proxy(client, {
    get(target, property, _receiver) {
      if (property === "unsafe") {
        return (query: string, params?: unknown[]) =>
          target.unsafe(fingerprint(query) + query, params);
      }
      if (property === "begin" || property === "savepoint") {
        return (first: unknown, second?: unknown) => {
          const wrap = (fn: (tx: BunSQL) => unknown) => (tx: BunSQL) => fn(withFingerprints(tx));
          // begin(fn) or begin("isolation level", fn); savepoint mirrors it.
          const method = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[
            property
          ];
          if (!method) throw new Error(`client has no ${String(property)}`);
          return typeof first === "function"
            ? method.call(target, wrap(first as (tx: BunSQL) => unknown))
            : method.call(target, first, wrap(second as (tx: BunSQL) => unknown));
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Bun's built-in Postgres client. No `pg`, no `postgres.js`: the runtime ships
 * a pooled driver and Drizzle has a first-party adapter for it.
 */
export function createDb(url: string, options: { max?: number } = {}) {
  const client = withFingerprints(new SQL({ url, max: options.max ?? 10 }));
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;
