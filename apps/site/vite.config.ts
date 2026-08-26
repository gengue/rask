import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// 5174, because apps/web already owns 5173 and `bun run dev` at the root
// starts both. Overridable so several checkouts can run side by side.
const SITE_PORT = Number(process.env.SITE_PORT ?? 5174);

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    port: SITE_PORT,
    strictPort: true,
    // The v4 loopback: the default resolves to ::1 only, and a proxy in front
    // of it (tailscale serve) dials 127.0.0.1 and gets nothing.
    host: "127.0.0.1",
    allowedHosts: [".ts.net"],
  },
  build: { target: "es2022" },
});
