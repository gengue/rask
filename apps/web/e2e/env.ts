/**
 * The end-to-end suite gets its own everything.
 *
 * It seeds, which means it truncates. Pointed at the database in the repo
 * `.env` — which is what it used to do — a single `bun run e2e` wipes the
 * workspace mirror a developer has been looking at all day, and there is no
 * warning because seeding is the suite working correctly. Its own database and
 * its own ports mean it can run while a dev stack is up and neither notices.
 */
export const E2E = {
  databaseUrl: "postgres://rask:rask@localhost:5432/rask_e2e",
  apiPort: "3210",
  webPort: "5413",
  cookieName: "rask_e2e",
} as const;

export const E2E_ENV: Record<string, string> = {
  DATABASE_URL: E2E.databaseUrl,
  API_PORT: E2E.apiPort,
  WEB_PORT: E2E.webPort,
  API_ORIGIN: `http://localhost:${E2E.apiPort}`,
  SESSION_COOKIE_NAME: E2E.cookieName,
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
