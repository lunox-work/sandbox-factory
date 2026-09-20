/** Public surface of the database layer. */

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
export { generateId, ID_PREFIXES, newTodoRow, rowToTodo } from "./mapping.js";
export type { IdPrefix } from "./mapping.js";
export { runMigrations } from "./migrate.js";
export type { MigrateOptions } from "./migrate.js";
export { createOrganizationStore } from "./organizations.js";
export type {
  Membership,
  OrganizationMember,
  OrganizationStore,
  OrganizationSummary,
  PendingInvitation,
} from "./organizations.js";
export { createObjectStore, isNotFound } from "./objects.js";
export type { ObjectStore, ObjectStoreOptions, PutOptions } from "./objects.js";
export {
  account,
  invitation,
  member,
  organization,
  session,
  todos,
  user,
  userEmail,
  verification,
} from "./schema.js";
export type {
  AccountRow,
  InvitationRow,
  MemberRow,
  NewMemberRow,
  NewOrganizationRow,
  NewTodoRow,
  NewUserEmailRow,
  OrganizationRow,
  SessionRow,
  TodoRow,
  UserEmailRow,
  UserRow,
  VerificationRow,
} from "./schema.js";
export { createPostgresStore, NotFoundError } from "./store.js";
export type { Database, TodoPatch, TodoStore } from "./store.js";
