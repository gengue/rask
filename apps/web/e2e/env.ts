/**
 * The end-to-end suite gets its own everything.
 *
 * It seeds, which means it truncates. Pointed at the database in the repo
 * `.env` — which is what it used to do — a single `bun run e2e` wipes the
 * workspace mirror a developer has been looking at all day, and there is no
 * warning because seeding is the suite working correctly. Its own database and
 * its own ports mean it can run while a dev stack is up and neither notices.
 */
/*
 * Overridable so two checkouts (e.g. two git worktrees) can run the suite at
 * the same time: same defaults, but E2E_API_PORT / E2E_WEB_PORT / E2E_DB_NAME
 * give a run its own ports and its own database. The session cookie follows
 * the database name — cookies ignore the port, so two suites on localhost
 * would otherwise overwrite each other's session (one SESSION_COOKIE_NAME per
 * checkout, as everywhere else). This buys concurrency *across* checkouts
 * only: two runs in the same checkout still collide on `apps/web/.dev-session`
 * and `test-results/`, and either way a run leaves `.dev-session` holding a
 * token that only exists in the e2e database (`bun run seed` restores it).
 */
const dbName = process.env.E2E_DB_NAME || "rask_e2e";
// Guards the DDL in scripts/db-test.ts and keeps the cookie name a plain
// token. Checked here so a typo'd E2E_DB_NAME dies naming the variable, before
// Playwright has spawned two servers.
if (!/^[a-z0-9_]+$/.test(dbName)) {
  throw new Error(`E2E_DB_NAME must match [a-z0-9_]+, got "${dbName}"`);
}

export const E2E = {
  dbName,
  databaseUrl: `postgres://rask:rask@localhost:5432/${dbName}`,
  apiPort: process.env.E2E_API_PORT || "3210",
  webPort: process.env.E2E_WEB_PORT || "5413",
} as const;

export const E2E_ENV: Record<string, string> = {
  DATABASE_URL: E2E.databaseUrl,
  API_PORT: E2E.apiPort,
  WEB_PORT: E2E.webPort,
  API_ORIGIN: `http://localhost:${E2E.apiPort}`,
  // Without this the API's post-OAuth redirects default to the dev server's
  // 5173. No spec follows one today; set so the port override is complete.
  WEB_ORIGIN: `http://localhost:${E2E.webPort}`,
  SESSION_COOKIE_NAME: E2E.dbName,
  /*
   * A port nothing listens on, so the API never leaves the box.
   *
   * The fixture workspace stores no real OAuth token, so every call the API
   * makes to ClickUp already answered 401 — it just answered slowly, over a
   * runner's internet connection, and the wait landed inside assertions. The
   * detail panel's "Could not read time from ClickUp." is the one a test reads
   * directly, and on a loaded runner it arrived after the five-second wait had
   * given up. A refused connection is the same failure without the round-trip.
   */
  CLICKUP_API_BASE: "http://127.0.0.1:1",
};
