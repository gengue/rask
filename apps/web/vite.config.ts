import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

/**
 * Dev-only sign-in.
 *
 * `bun run --cwd apps/api seed` writes a session token to .dev-session; hitting
 * /__dev-login turns it into a cookie. This lives in the Vite dev server, which
 * is not part of any build, so there is no code path in the deployed app that
 * can do the same thing. The seeded session is a normal row that expires and
 * can be revoked like any other.
 */
function devLogin(): Plugin {
  return {
    name: "rask-dev-login",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev-login", (_request, response) => {
        const file = join(dirname(fileURLToPath(import.meta.url)), ".dev-session");
        if (!existsSync(file)) {
          response.statusCode = 404;
          response.end("No .dev-session. Run: bun run --cwd apps/api seed");
          return;
        }
        const token = readFileSync(file, "utf8").trim();
        // Must match the API's SESSION_COOKIE_NAME. Cookies are scoped by host
        // and ignore the port, so two checkouts on localhost overwrite each
        // other's session unless each names its own.
        const cookie = process.env.SESSION_COOKIE_NAME ?? "rask_session";
        response.setHeader(
          "Set-Cookie",
          `${cookie}=${token}; Path=/; Max-Age=2592000; SameSite=Lax`,
        );
        response.setHeader("Location", "/");
        response.statusCode = 302;
        response.end();
      });
    },
  };
}

// Overridable so several checkouts can run side by side without fighting over
// ports or over each other's API.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  plugins: [solid(), tailwindcss(), devLogin()],
  server: {
    port: WEB_PORT,
    strictPort: true,
    // Loopback, but the v4 one: the default resolves to ::1 only, and a proxy
    // in front of it (tailscale serve) dials 127.0.0.1 and gets nothing.
    host: "127.0.0.1",
    // Reachable from other machines on the tailnet (MagicDNS names end in
    // .ts.net); Vite rejects any Host header it was not told about.
    allowedHosts: [".ts.net"],
    // Same-origin in dev, exactly like production behind Coolify. Keeps the
    // session cookie SameSite=Lax instead of forcing SameSite=None.
    proxy: {
      "/api": { target: API_ORIGIN, changeOrigin: true },
      "/auth": { target: API_ORIGIN, changeOrigin: true },
    },
  },
  build: { target: "es2022", sourcemap: true },
});
