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
  /** Postgres' `application_name` for every connection the pool opens. */
  readonly applicationName?: string;
}

export interface Connection {
  readonly db: Database;
  /**
   * Calls `onNotify` for each `NOTIFY` on `channel`, on a connection of its
   * own that reconnects by itself. Resolves once listening, with the
   * function that stops it. A notification lost to a reconnect is lost, so
   * a listener keeps a timer as well.
   */
  listen(
    channel: string,
    onNotify: (payload: string) => void,
  ): Promise<() => Promise<void>>;
  /** Drains the pool. Call on shutdown so the process can exit cleanly. */
  close(): Promise<void>;
}

export function createConnection({
  url,
  max = 10,
  applicationName,
}: ConnectionOptions): Connection {
  const sql = postgres(url, {
    max,
    ...(applicationName === undefined
      ? {}
      : { connection: { application_name: applicationName } }),
  });
  return {
    db: drizzle(sql),
    async listen(channel, onNotify) {
      const { unlisten } = await sql.listen(channel, onNotify);
      return unlisten;
    },
    async close() {
      await sql.end();
    },
  };
}
