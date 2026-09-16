/**
 * Row <-> domain mapping, kept pure and separate from the store.
 *
 * This is the only place that knows a database row is not a `Todo`. Isolating
 * it means the interesting edge (timestamp conversion, id generation) is
 * testable without a running Postgres — which the repo requires: no test may
 * depend on a container.
 */

import { normalizeTitle, type Todo } from "sandbox-factory";

import type { NewTodoRow, TodoRow } from "./schema.js";

/** Turn a database row into the domain type the API contract promises. */
export function rowToTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    done: row.done,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Build the row for a new todo.
 *
 * The title is normalized here as well as at the HTTP edge, matching the
 * in-memory store: a caller reaching the store directly must not be able to
 * write an untrimmed or over-long title.
 */
export function newTodoRow(
  userId: string,
  title: string,
  id: string = generateId(),
): NewTodoRow {
  return { id, userId, title: normalizeTitle(title), done: false };
}

/**
 * Ids are generated in the application, not by the database.
 *
 * `crypto.randomUUID` rather than a sequence: the store's `create` returns the
 * row it wrote, and a client-generated id keeps that a single round trip while
 * staying collision-free across replicas.
 */
export function generateId(): string {
  return `todo_${crypto.randomUUID()}`;
}
