/**
 * drizzle-kit config, used only by `npm run db:generate` to emit SQL into
 * `drizzle/`. Tooling, not shipped code: deliberately outside the tsconfig
 * `include`.
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
