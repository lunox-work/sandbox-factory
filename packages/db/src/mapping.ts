/**
 * Row <-> domain mapping. Pure and separate from the store, so timestamp
 * conversion and id generation are testable without Postgres.
 */

import { normalizeTitle, type Todo } from "sandbox-factory";

import type { NewTodoRow, TodoRow } from "./schema.js";

/** Turns a database row into the domain `Todo`. */
export function rowToTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    done: row.done,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Builds the row for a new todo. Normalizes the title here as well as at the
 * HTTP edge, so a direct store caller cannot write an invalid one.
 */
export function newTodoRow(
  userId: string,
  title: string,
  id: string = generateId(),
): NewTodoRow {
  return { id, userId, title: normalizeTitle(title), done: false };
}

/**
 * The id prefixes in use, one per table that generates ids.
 *
 * Prefixed ids are worth the few bytes: an id that leaks into a log, a URL or
 * a support conversation says what it is, and passing a board id where an
 * issue id belongs is visible rather than a silent 404. The set is declared
 * here, rather than each caller passing a string, so that a typo is a compile
 * error and the full list is readable in one place.
 */
export const ID_PREFIXES = [
  "todo",
  /** Jira: connection, board, issue. */
  "jrc",
  "jrb",
  "jri",
  /** Commercials: bounty run, bounty proposal. */
  "brn",
  "bpr",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

/**
 * Generated in the application, not by a sequence: `create` stays one round
 * trip and ids stay collision-free across replicas.
 *
 * Defaults to `todo` so the existing callers are unchanged; every new table
 * passes its own prefix.
 */
export function generateId(prefix: IdPrefix = "todo"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
