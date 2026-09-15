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

import { desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { normalizeTitle, type Todo } from "sandbox-factory";

import { newTodoRow, rowToTodo } from "./mapping.js";
import { todos } from "./schema.js";

export interface TodoPatch {
  readonly title?: string;
  readonly done?: boolean;
}

export interface TodoStore {
  list(): Promise<Todo[]>;
  get(id: string): Promise<Todo | undefined>;
  create(title: string): Promise<Todo>;
  update(id: string, patch: TodoPatch): Promise<Todo>;
  remove(id: string): Promise<void>;
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
    async list() {
      // Newest first — the order the UI wants to render, and the same order
      // the in-memory store returns.
      const rows = await db.select().from(todos).orderBy(desc(todos.createdAt));
      return rows.map(rowToTodo);
    },

    async get(id) {
      const rows = await db.select().from(todos).where(eq(todos.id, id));
      const row = rows[0];
      return row === undefined ? undefined : rowToTodo(row);
    },

    async create(title) {
      const inserted = await db
        .insert(todos)
        .values(newTodoRow(title))
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        // Unreachable for a single-row insert, but `noUncheckedIndexedAccess`
        // is on and an assertion here would be exactly what it exists to stop.
        throw new Error("Insert returned no row.");
      }
      return rowToTodo(row);
    },

    async update(id, patch) {
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
        const existing = await this.get(id);
        if (existing === undefined) {
          throw new NotFoundError(id);
        }
        return existing;
      }

      const updated = await db
        .update(todos)
        .set(values)
        .where(eq(todos.id, id))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError(id);
      }
      return rowToTodo(row);
    },

    async remove(id) {
      const deleted = await db
        .delete(todos)
        .where(eq(todos.id, id))
        .returning({ id: todos.id });
      if (deleted.length === 0) {
        throw new NotFoundError(id);
      }
    },
  };
}
