import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Lets a deployment serve this app under a path prefix (e.g. a host nginx reverse-proxying
  // /orchestrator/ to this container) without hardcoding one: unset, it stays "/" like today.
  // Must end in "/" — Vite's own convention, also what `import.meta.env.BASE_URL` then exposes
  // at runtime for the router basename and the API client to read (see client.ts, main.tsx).
  base: process.env.E2E_RUNNER_WEB_BASE || "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/v1": {
        // Matches load-config.ts's DEFAULT_PORT; override while developing against a different instance.
        target: process.env.E2E_RUNNER_DEV_API_TARGET || "http://127.0.0.1:8090",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
