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
 * Generated in the application, not by a sequence: `create` stays one round
 * trip and ids stay collision-free across replicas.
 */
export function generateId(): string {
  return `todo_${crypto.randomUUID()}`;
}
