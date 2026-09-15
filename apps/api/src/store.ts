/**
 * An in-memory todo store.
 *
 * Deliberately not a database: it keeps the scaffold runnable with `npm run
 * dev` and no Docker, and it defines the interface that the real Postgres
 * implementation in packages/db will satisfy. Swapping it out should not
 * require touching routes.ts.
 */

import { normalizeTitle, type Todo } from "sandbox-factory";

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
