/**
 * Test config for the web app.
 *
 * Separate from `vite.config.ts` because the dev server config there — the
 * `/api` proxy in particular — is irrelevant to tests and its `server.port`
 * would make two test runs collide.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // The components under test render DOM, so they need a DOM.
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
  },
});
