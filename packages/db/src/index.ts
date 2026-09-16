/**
 * Public surface of the database layer.
 *
 * `apps/api` imports the store contract and the Postgres implementation from
 * here; `NotFoundError` lives in this package because dependencies point
 * downward and a package may not import an app.
 */

export { authSchema } from "./auth-schema.js";
export { createConnection } from "./client.js";
export {
  createEmailStore,
  createProfileStore,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "./emails.js";
export type {
  EmailStore,
  ProvenEmail,
  UsernameResult,
  UserProfileStore,
} from "./emails.js";
export type { Connection, ConnectionOptions } from "./client.js";
export { generateId, newTodoRow, rowToTodo } from "./mapping.js";
export { runMigrations } from "./migrate.js";
export type { MigrateOptions } from "./migrate.js";
export { createObjectStore, isNotFound } from "./objects.js";
export type { ObjectStore, ObjectStoreOptions, PutOptions } from "./objects.js";
export {
  account,
  session,
  todos,
  user,
  userEmail,
  verification,
} from "./schema.js";
export type {
  AccountRow,
  NewTodoRow,
  NewUserEmailRow,
  SessionRow,
  TodoRow,
  UserEmailRow,
  UserRow,
  VerificationRow,
} from "./schema.js";
export { createPostgresStore, NotFoundError } from "./store.js";
export type { Database, TodoPatch, TodoStore } from "./store.js";
