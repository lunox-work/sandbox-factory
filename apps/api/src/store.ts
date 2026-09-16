/**
 * The store contract, re-exported.
 *
 * The interface, `NotFoundError`, and the Postgres implementation live in
 * `@sandbox-factory/db`: dependencies point downward, so a package cannot
 * import this app, and the contract has to sit where both can reach it.
 *
 * This module stays so that `routes.ts` and its tests keep importing from
 * `./store.js` as they always have — the swap to a real database is not
 * visible to them.
 *
 * `createInMemoryStore` remains for the route tests, which must run with no
 * container: it is a test double now, not the production path. The server
 * requires Postgres.
 */

import { normalizeTitle, type Todo } from "sandbox-factory";

import { NotFoundError, type TodoStore } from "@sandbox-factory/db";

export {
  createPostgresStore,
  NotFoundError,
  type TodoPatch,
  type TodoStore,
} from "@sandbox-factory/db";

/**
 * A seeded todo. The owner is part of the seed because the store is
 * owner-scoped: a fixture without one could only be read by a test that
 * guessed which user it belonged to.
 */
export interface SeedTodo extends Todo {
  readonly userId: string;
}

export function createInMemoryStore(seed: readonly SeedTodo[] = []): TodoStore {
  const todos = new Map<string, SeedTodo>(seed.map((todo) => [todo.id, todo]));
  let counter = seed.length;

  /**
   * The owner check, in the one place every mutating method goes through.
   *
   * A row owned by someone else throws `NotFoundError` rather than a distinct
   * "forbidden" error, matching the Postgres store: there, the owner is part
   * of the WHERE clause and a non-match simply yields no row. The two
   * implementations have to be indistinguishable to a caller, and that
   * includes being indistinguishable about another user's ids.
   */
  function require(userId: string, id: string): SeedTodo {
    const existing = todos.get(id);
    if (existing === undefined || existing.userId !== userId) {
      throw new NotFoundError(id);
    }
    return existing;
  }

  /** Strip the owner: it is storage bookkeeping, not part of the contract. */
  function toTodo({ userId: _userId, ...todo }: SeedTodo): Todo {
    return todo;
  }

  return {
    async list(userId) {
      // Newest first — the order the UI wants to render.
      return [...todos.values()]
        .filter((todo) => todo.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(toTodo);
    },

    async get(userId, id) {
      const existing = todos.get(id);
      return existing === undefined || existing.userId !== userId
        ? undefined
        : toTodo(existing);
    },

    async create(userId, title) {
      counter += 1;
      const todo: SeedTodo = {
        id: `todo_${counter}`,
        userId,
        // Normalized here as well as at the edge, so a caller reaching the
        // store directly cannot write an untrimmed title.
        title: normalizeTitle(title),
        done: false,
        createdAt: new Date().toISOString(),
      };
      todos.set(todo.id, todo);
      return toTodo(todo);
    },

    async update(userId, id, patch) {
      const existing = require(userId, id);
      const updated: SeedTodo = {
        ...existing,
        ...(patch.title === undefined
          ? {}
          : { title: normalizeTitle(patch.title) }),
        ...(patch.done === undefined ? {} : { done: patch.done }),
      };
      todos.set(id, updated);
      return toTodo(updated);
    },

    async remove(userId, id) {
      require(userId, id);
      todos.delete(id);
    },
  };
}
