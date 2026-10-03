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

/**
 * A repository, or a connection holding one, that a sandbox still points
 * at. Sandbox provenance keeps its source snapshot and runs for replay
 * (`ON DELETE no action`), so the delete is refused rather than cascaded.
 */
export class RepositoryInUseError extends Error {
  readonly code = "repository_in_use";
  constructor() {
    super("A sandbox is built from this repository. Remove the sandbox first.");
    this.name = "RepositoryInUseError";
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
  return hasSqlState(error, "23505");
}

/** Whether a write was refused by a foreign key — Postgres' `23503`. */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasSqlState(error, "23503");
}

function hasSqlState(error: unknown, code: string): boolean {
  // drizzle-orm >= 0.44 wraps every driver failure in a `DrizzleQueryError`
  // whose own `code` is undefined; the postgres.js error, with the SQLSTATE,
  // is its `cause`. Followed a few levels, never unboundedly.
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    if ("code" in current && current.code === code) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Runs a delete that cascades into repositories, turning the foreign-key
 * refusal from sandbox provenance into `RepositoryInUseError`. Only the
 * sandbox tables reference repositories, snapshots or runs without a
 * cascade, so a `23503` here can only mean a sandbox.
 */
export async function guardRepositoryDelete<T>(
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isForeignKeyViolation(error)) throw new RepositoryInUseError();
    throw error;
  }
}
