/** Migration runner, as a function so the CLI stays a thin wrapper. */

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createConnection } from "./client.js";
import type { Database } from "./store.js";

export interface MigrateOptions {
  readonly url: string;
  /** Directory holding the generated SQL, relative to the package root. */
  readonly migrationsFolder?: string;
}

/**
 * Injectable so close-on-failure can be tested without a database. `run` has
 * drizzle's `migrate` signature verbatim, so the default is the import itself
 * and no adapter is left uncovered.
 */
export interface MigrateDeps {
  readonly connect: typeof createConnection;
  readonly run: (
    db: Database,
    config: { migrationsFolder: string },
  ) => Promise<void>;
}

export async function runMigrations(
  { url, migrationsFolder = "drizzle" }: MigrateOptions,
  { connect = createConnection, run = migrate }: Partial<MigrateDeps> = {},
): Promise<void> {
  // A dedicated connection: a migration holds locks, and on a shared pool an
  // unrelated query could wait behind one.
  const connection = connect({ url, max: 1 });
  try {
    await run(connection.db, { migrationsFolder });
  } finally {
    // A failed migration must still drain the pool, or the process hangs.
    await connection.close();
  }
}
