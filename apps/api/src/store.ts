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

export function createInMemoryStore(seed: readonly Todo[] = []): TodoStore {
  const todos = new Map<string, Todo>(seed.map((todo) => [todo.id, todo]));
  let counter = seed.length;

  function require(id: string): Todo {
    const existing = todos.get(id);
    if (existing === undefined) {
      throw new NotFoundError(id);
    }
    return existing;
  }

  return {
    async list() {
      // Newest first — the order the UI wants to render.
      return [...todos.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    },

    async get(id) {
      return todos.get(id);
    },

    async create(title) {
      counter += 1;
      const todo: Todo = {
        id: `todo_${counter}`,
        // Normalized here as well as at the edge, so a caller reaching the
        // store directly cannot write an untrimmed title.
        title: normalizeTitle(title),
        done: false,
        createdAt: new Date().toISOString(),
      };
      todos.set(todo.id, todo);
      return todo;
    },

    async update(id, patch) {
      const existing = require(id);
      const updated: Todo = {
        ...existing,
        ...(patch.title === undefined
          ? {}
          : { title: normalizeTitle(patch.title) }),
        ...(patch.done === undefined ? {} : { done: patch.done }),
      };
      todos.set(id, updated);
      return updated;
    },

    async remove(id) {
      require(id);
      todos.delete(id);
    },
  };
}
