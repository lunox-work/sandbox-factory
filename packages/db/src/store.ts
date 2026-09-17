/**
 * The Postgres `TodoStore`. The interface and `NotFoundError` live here, not
 * in `apps/api`, because a package may not import an app; the API re-exports
 * them. Behaviour matches the API's in-memory store exactly: same ordering,
 * normalization and missing-id error.
 */

import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { normalizeTitle, type Todo } from "sandbox-factory";

import { newTodoRow, rowToTodo } from "./mapping.js";
import { todos } from "./schema.js";

export interface TodoPatch {
  readonly title?: string;
  readonly done?: boolean;
}

/**
 * The todo store, scoped to one owner on every call. `userId` is a required
 * argument, so no method can cross users and a route cannot leak by forgetting
 * a `where`. Someone else's id is a `NotFoundError`, like a missing one;
 * telling them apart would confirm which ids exist.
 */
export interface TodoStore {
  list(userId: string): Promise<Todo[]>;
  get(userId: string, id: string): Promise<Todo | undefined>;
  create(userId: string, title: string): Promise<Todo>;
  update(userId: string, id: string, patch: TodoPatch): Promise<Todo>;
  remove(userId: string, id: string): Promise<void>;
}

/** Thrown when an id does not exist; routes turn this into a 404. */
export class NotFoundError extends Error {
  constructor(id: string) {
    super(`No todo with id "${id}".`);
    this.name = "NotFoundError";
  }
}

export type Database = PostgresJsDatabase<Record<string, never>>;

export function createPostgresStore(db: Database): TodoStore {
  return {
    async list(userId) {
      // Newest first, as the in-memory store returns.
      const rows = await db
        .select()
        .from(todos)
        .where(eq(todos.userId, userId))
        .orderBy(desc(todos.createdAt));
      return rows.map(rowToTodo);
    },

    async get(userId, id) {
      // Both predicates, always: `id` alone would serve a guessed id.
      const rows = await db
        .select()
        .from(todos)
        .where(and(eq(todos.id, id), eq(todos.userId, userId)));
      const row = rows[0];
      return row === undefined ? undefined : rowToTodo(row);
    },

    async create(userId, title) {
      const inserted = await db
        .insert(todos)
        .values(newTodoRow(userId, title))
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        // Unreachable, but `noUncheckedIndexedAccess` requires the check.
        throw new Error("Insert returned no row.");
      }
      return rowToTodo(row);
    },

    async update(userId, id, patch) {
      // Built field by field, not spread: undefined keys must not reach the
      // UPDATE, and the title needs normalizing.
      const values: { title?: string; done?: boolean } = {};
      if (patch.title !== undefined) {
        values.title = normalizeTitle(patch.title);
      }
      if (patch.done !== undefined) {
        values.done = patch.done;
      }

      // An empty patch is a no-op, but an UPDATE with no SET is invalid SQL,
      // so read the current row instead.
      if (Object.keys(values).length === 0) {
        const existing = await this.get(userId, id);
        if (existing === undefined) {
          throw new NotFoundError(id);
        }
        return existing;
      }

      // The owner predicate is in the UPDATE itself: a read-then-write would
      // leave a race window and cost a round trip.
      const updated = await db
        .update(todos)
        .set(values)
        .where(and(eq(todos.id, id), eq(todos.userId, userId)))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        // No such id, or someone else's: both are a 404.
        throw new NotFoundError(id);
      }
      return rowToTodo(row);
    },

    async remove(userId, id) {
      const deleted = await db
        .delete(todos)
        .where(and(eq(todos.id, id), eq(todos.userId, userId)))
        .returning({ id: todos.id });
      if (deleted.length === 0) {
        throw new NotFoundError(id);
      }
    },
  };
}
