import { defineConfig, devices } from "@playwright/test";
import { E2E, E2E_ENV } from "./e2e/env.ts";

/**
 * One browser, one critical flow.
 *
 * Playwright starts the API and the Vite dev server itself, on their own ports,
 * against a database of its own that it recreates every run. None of that is
 * incidental: the suite seeds, seeding truncates, and pointed at the repo .env
 * it used to wipe the workspace mirror a developer had open.
 */
/*
 * Both servers pipe their output.
 *
 * The default swallows it, and a webServer that never becomes ready then fails
 * with nothing but "Timed out waiting" — no banner, no error, no way to tell
 * which of the two it was. That happened once on a runner and took a re-run to
 * establish it was the runner rather than the code.
 */

/*
 * This used to say the wait was for Vite optimizing dependencies on a cold
 * checkout. Measured, that is not what happens: a cold start with no
 * `node_modules/.vite` at all is under a second, and eight consecutive starts
 * landed between 400 and 500ms. The number stays generous because the API's
 * first boot is the slow one, not because anybody has seen Vite take a minute.
 */
const WEB_SERVER_TIMEOUT_MS = 120_000;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/seed.ts",
  fullyParallel: false,
  workers: 1,
  /*
   * 15s, not Playwright's 5s default. Green assertions resolve the moment the
   * element appears, so this costs nothing on a healthy run — it only buys the
   * suite room on a loaded box. On 2026-08-29 a run sharing the machine with a
   * ~110MB file-deletion burst lost two specs to first-paint waits that landed
   * a beat past 5s, with the API healthy and every request answered. Same
   * class as the CLICKUP_API_BASE incident: the assertion budget, not the code.
   */
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${E2E.webPort}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      /*
       * The script's body rather than `bun run --cwd ../api start:local`, for
       * the same reason Vite is run directly below: `bun run` is a parent that
       * takes the teardown signal and leaves the server behind holding this
       * port. That orphan is not theoretical — a failed run used to log
       * `script "start:local" was terminated by signal SIGTERM` and then keep
       * answering on 3210, so the next run refused to start at all.
       */
      command: "bun --env-file=../../.env src/index.ts",
      cwd: "../api",
      url: `http://localhost:${E2E.apiPort}/health`,
      env: E2E_ENV,
      // Never reuse: a server already up is one pointed at the dev database.
      reuseExistingServer: false,
      timeout: WEB_SERVER_TIMEOUT_MS,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      /*
       * Vite directly, not through `bun run dev`.
       *
       * That script is `bun --env-file=../../.env --bun vite`, and every part
       * of it was a layer between Playwright and the process it is waiting on.
       * `bun run` puts a parent in between, so Playwright's teardown signal
       * lands on the wrapper and Vite can outlive the run holding this port.
       * `--env-file` reads a file that does not exist in CI, since `.env` is
       * ignored — everything Vite needs is in `E2E_ENV` already.
       *
       * `--bun` is the one that earned this change. It runs Vite on Bun rather
       * than Node, which is the most exotic thing in the stack and the only
       * layer whose failure looks like what CI kept showing: the command
       * echoes, nothing is ever printed, and the wait runs out two minutes
       * later. Vite starts in half a second every time it is run directly.
       *
       * Not reproduced, so this is not a proven root cause — it is the removal
       * of the three things between here and a process that has never once
       * been seen to hang on its own.
       */
      command: "node_modules/.bin/vite",
      // The address Vite actually binds; `server.host` is 127.0.0.1 and
      // `localhost` resolves to ::1 first on a dual-stack box, which costs a
      // refused connection on every poll before the fallback succeeds.
      url: `http://127.0.0.1:${E2E.webPort}`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: WEB_SERVER_TIMEOUT_MS,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
