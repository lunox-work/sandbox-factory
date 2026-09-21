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
export { createTokenCipher, sameKeyId, TokenCipherError } from "./cipher.js";
export type { TokenCipher } from "./cipher.js";
export { generateId, ID_PREFIXES } from "./mapping.js";
export type { IdPrefix } from "./mapping.js";
export { runMigrations } from "./migrate.js";
export type { MigrateOptions } from "./migrate.js";
export { createJiraBoardStore } from "./jira-boards.js";
export type {
  JiraBoardStore,
  JiraBoardSummary,
  RegisterBoardInput,
  StoredBoardSelection,
  UpdateBoardInput,
} from "./jira-boards.js";
export { createJiraConnectionStore } from "./jira-connections.js";
export type {
  JiraConnectionInput,
  JiraConnectionStore,
  JiraConnectionSummary,
  JiraConnectionTokens,
} from "./jira-connections.js";
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
  ORGANIZATION_KINDS,
  session,
  user,
  userEmail,
  verification,
} from "./schema.js";
export type {
  AccountRow,
  InvitationRow,
  OrganizationKind,
  MemberRow,
  NewMemberRow,
  NewOrganizationRow,
  NewUserEmailRow,
  OrganizationRow,
  SessionRow,
  UserEmailRow,
  UserRow,
  VerificationRow,
} from "./schema.js";
export { NotFoundError } from "./errors.js";
export type { Database } from "./errors.js";
