/**
 * Errors the stores raise, and the shared `Database` type.
 *
 * `NotFoundError` was defined alongside the todo store; it outlived it because
 * every owner-scoped store raises it for the same reason. A row belonging to
 * another user or another organization is reported as missing rather than as
 * forbidden: telling the two apart would confirm which ids exist. The routes
 * turn it into a 404 in one place, `errorHandler`.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/** Thrown when an id does not exist, or belongs to someone else. */
export class NotFoundError extends Error {
  constructor(id: string) {
    super(`No record with id "${id}".`);
    this.name = "NotFoundError";
  }
}

export type Database = PostgresJsDatabase<Record<string, never>>;

/**
 * Whether a write was refused by a unique constraint — Postgres' `23505`.
 *
 * Also what the handle triggers raise (migration 0030), so a claim that loses
 * a race to a concurrent one reads the same as any other duplicate.
 */
export function isUniqueViolation(error: unknown): boolean {
  // drizzle-orm >= 0.44 wraps every driver failure in a `DrizzleQueryError`
  // whose own `code` is undefined; the postgres.js error, with the SQLSTATE,
  // is its `cause`. Followed a few levels, never unboundedly.
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    if ("code" in current && current.code === "23505") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
