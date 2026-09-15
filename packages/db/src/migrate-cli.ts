/**
 * `npm run db:migrate` entry point. Kept separate from migrate.ts so importing
 * the runner never has the side effect of executing it.
 */

import { fileURLToPath } from "node:url";

import { runMigrations } from "./migrate.js";

const url = process.env["DATABASE_URL"];
if (url === undefined || url === "") {
  console.error("DATABASE_URL is required to run migrations.");
  process.exit(1);
}

// Resolved from this file, so the command works from any working directory.
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

await runMigrations({ url, migrationsFolder });
console.log("Migrations applied.");
