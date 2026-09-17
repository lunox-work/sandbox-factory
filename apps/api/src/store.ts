/**
 * Re-exports the store contract from `@sandbox-factory/db`, where packages can
 * reach it too, and adds `createInMemoryStore`: a test double so the route
 * tests run with no container. Production requires Postgres.
 */

import { normalizeTitle, type Todo } from "sandbox-factory";

import { NotFoundError, type TodoStore } from "@sandbox-factory/db";

export {
  createPostgresStore,
  NotFoundError,
  type TodoPatch,
  type TodoStore,
} from "@sandbox-factory/db";

/** A seeded todo. Carries its owner because the store is owner-scoped. */
export interface SeedTodo extends Todo {
  readonly userId: string;
}

export function createInMemoryStore(seed: readonly SeedTodo[] = []): TodoStore {
  const todos = new Map<string, SeedTodo>(seed.map((todo) => [todo.id, todo]));
  let counter = seed.length;

  /**
   * The owner check every mutating method goes through. Another user's row
   * throws `NotFoundError`, not "forbidden", matching the Postgres store, where
   * the owner is in the WHERE clause — so ids never leak across users.
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
        // Normalized here as well as at the edge, for callers that reach the
        // store directly.
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
