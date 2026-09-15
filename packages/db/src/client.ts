/**
 * Connection construction and teardown.
 *
 * Kept apart from the store so that a caller holding a `TodoStore` has no way
 * to reach the socket underneath it, and so tests can build a store over any
 * driver-shaped object without opening a connection.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { Database } from "./store.js";

export interface ConnectionOptions {
  /** Postgres connection string, e.g. `postgres://user:pass@host:5432/db`. */
  readonly url: string;
  /**
   * Pool size. The default of 10 suits a single API process; raise it only
   * alongside Postgres' own `max_connections`, which is what actually runs
   * out first.
   */
  readonly max?: number;
}

export interface Connection {
  readonly db: Database;
  /** Drains the pool. Call on shutdown so the process can exit cleanly. */
  close(): Promise<void>;
}

export function createConnection({
  url,
  max = 10,
}: ConnectionOptions): Connection {
  const sql = postgres(url, { max });
  return {
    db: drizzle(sql),
    async close() {
      await sql.end();
    },
  };
}
