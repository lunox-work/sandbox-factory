/**
 * Public surface of the database layer.
 *
 * `apps/api` imports the store contract and the Postgres implementation from
 * here; `NotFoundError` lives in this package because dependencies point
 * downward and a package may not import an app.
 */

export { createConnection } from "./client.js";
export type { Connection, ConnectionOptions } from "./client.js";
export { generateId, newTodoRow, rowToTodo } from "./mapping.js";
export { runMigrations } from "./migrate.js";
export type { MigrateOptions } from "./migrate.js";
export { createObjectStore, isNotFound } from "./objects.js";
export type { ObjectStore, ObjectStoreOptions, PutOptions } from "./objects.js";
export { todos } from "./schema.js";
export type { NewTodoRow, TodoRow } from "./schema.js";
export { createPostgresStore, NotFoundError } from "./store.js";
export type { Database, TodoPatch, TodoStore } from "./store.js";
