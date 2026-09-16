/**
 * The Postgres implementation of `TodoStore`.
 *
 * The interface and `NotFoundError` are defined here rather than in
 * `apps/api`, because dependencies point downward only: a package may not
 * import an app. `apps/api/src/store.ts` re-exports both, so `routes.ts` and
 * its tests keep importing from where they always did.
 *
 * Behaviour matches the in-memory store exactly — same ordering, same
 * normalization, same error on a missing id — so swapping one for the other
 * cannot change what a caller observes.
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
 * The todo store, scoped to one owner on every call.
 *
 * `userId` is a required first argument rather than a filter the caller may
 * remember to apply, and that shape is the point: there is no method here that
 * can read or write across users, so a route cannot leak one user's todos by
 * forgetting a `where` clause. An id that belongs to someone else is reported
 * as `NotFoundError`, exactly as a genuinely missing one is — telling the two
 * apart would confirm which ids exist.
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
      // Newest first — the order the UI wants to render, and the same order
      // the in-memory store returns.
      const rows = await db
        .select()
        .from(todos)
        .where(eq(todos.userId, userId))
        .orderBy(desc(todos.createdAt));
      return rows.map(rowToTodo);
    },

    async get(userId, id) {
      // Both predicates, always. Matching on `id` alone would return another
      // user's row to a caller who guessed an id.
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
        // Unreachable for a single-row insert, but `noUncheckedIndexedAccess`
        // is on and an assertion here would be exactly what it exists to stop.
        throw new Error("Insert returned no row.");
      }
      return rowToTodo(row);
    },

    async update(userId, id, patch) {
      // Build the patch rather than spreading `patch` straight in: an
      // undefined value would otherwise null out a column, and the title
      // needs normalizing before it is written.
      const values: { title?: string; done?: boolean } = {};
      if (patch.title !== undefined) {
        values.title = normalizeTitle(patch.title);
      }
      if (patch.done !== undefined) {
        values.done = patch.done;
      }

      // An empty patch is a no-op, not an error — but `update` must still
      // return the current row, and an UPDATE with no SET clause is invalid
      // SQL, so read instead.
      if (Object.keys(values).length === 0) {
        const existing = await this.get(userId, id);
        if (existing === undefined) {
          throw new NotFoundError(id);
        }
        return existing;
      }

      // The owner predicate is part of the UPDATE itself rather than a check
      // before it: a read-then-write would leave a window in which the row
      // changed hands, and would cost a round trip to no benefit.
      const updated = await db
        .update(todos)
        .set(values)
        .where(and(eq(todos.id, id), eq(todos.userId, userId)))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        // No row matched: either there is no such id, or it is someone
        // else's. Both are a 404 to the caller.
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
