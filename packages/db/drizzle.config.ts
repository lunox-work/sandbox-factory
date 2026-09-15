/**
 * drizzle-kit config, used only by `npm run db:generate` to diff the schema
 * and emit SQL into `drizzle/`. Not loaded at runtime, and deliberately not
 * part of the tsconfig `include` — it is tooling config, not shipped code.
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
