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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
