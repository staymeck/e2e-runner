import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
