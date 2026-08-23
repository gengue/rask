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
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/seed.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${E2E.webPort}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun run --cwd ../api start:local",
      url: `http://localhost:${E2E.apiPort}/health`,
      env: E2E_ENV,
      // Never reuse: a server already up is one pointed at the dev database.
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "bun run dev",
      url: `http://localhost:${E2E.webPort}`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
