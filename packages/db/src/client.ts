/**
 * Connection construction and teardown. Apart from the store so a `TodoStore`
 * holder cannot reach the socket, and tests need no connection.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { Database } from "./errors.js";

export interface ConnectionOptions {
  /** Postgres connection string, e.g. `postgres://user:pass@host:5432/db`. */
  readonly url: string;
  /**
   * Pool size, default 10. Raise it only alongside Postgres'
   * `max_connections`, which runs out first.
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
