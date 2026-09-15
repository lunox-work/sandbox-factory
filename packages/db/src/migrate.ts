/**
 * Migration runner.
 *
 * Exposed as a function rather than only a CLI so the API can run migrations
 * at boot if it wants to, and so the CLI stays a thin wrapper.
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createConnection } from "./client.js";
import type { Database } from "./store.js";

export interface MigrateOptions {
  readonly url: string;
  /** Directory holding the generated SQL, relative to the package root. */
  readonly migrationsFolder?: string;
}

/**
 * The two collaborators, injectable so the close-on-failure contract below can
 * be tested without a database.
 *
 * `run` takes drizzle's `migrate` signature verbatim rather than a simplified
 * one, so the default is the imported function itself. An adapter arrow here
 * would be a line of untestable production code whose only purpose is to
 * reshape arguments — this way there is nothing to leave uncovered.
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
  // A dedicated single connection: a migration holds locks, and sharing the
  // API's pool would let an unrelated query wait behind one.
  const connection = connect({ url, max: 1 });
  try {
    await run(connection.db, { migrationsFolder });
  } finally {
    // finally, not a trailing call: a failed migration must still drain the
    // pool, or the process hangs on exit holding a connection.
    await connection.close();
  }
}
