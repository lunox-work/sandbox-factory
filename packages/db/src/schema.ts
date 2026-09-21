/**
 * The Drizzle schema, re-exported from `schema/`.
 *
 * **This file stays the single entry point on purpose.** `drizzle.config.ts`
 * names it, `drizzleAdapter` is handed the tables from it, and every store
 * imports from it — so the split below is an internal reorganisation that
 * nothing outside this package can observe. Keep it a barrel: a table declared
 * here rather than in a module beneath would be invisible to anyone reading
 * `schema/`, which is where the tables now live.
 *
 * One module per bounded area, split when the file reached 373 lines and the
 * Jira and commercials tables were about to be added to it:
 *
 * - `schema/auth.ts` — Better Auth's four tables, plus `user_email`.
 * - `schema/organizations.ts` — the second principal and its membership.
 * - `schema/jira.ts` — connections to a client's Atlassian site.
 *
 * `auth.ts` and `organizations.ts` import each other; see the note in
 * `organizations.ts` for why the foreign-key thunks make that safe.
 */

export {
  account,
  session,
  user,
  userEmail,
  verification,
} from "./schema/auth.js";
export type {
  AccountRow,
  NewUserEmailRow,
  SessionRow,
  UserEmailRow,
  UserRow,
  VerificationRow,
} from "./schema/auth.js";

export {
  invitation,
  member,
  organization,
  ORGANIZATION_KINDS,
} from "./schema/organizations.js";
export type {
  OrganizationKind,
  InvitationRow,
  MemberRow,
  NewMemberRow,
  NewOrganizationRow,
  OrganizationRow,
} from "./schema/organizations.js";

export { jiraBoard, jiraConnection } from "./schema/jira.js";
export type {
  JiraBoardRow,
  JiraConnectionRow,
  NewJiraBoardRow,
  NewJiraConnectionRow,
} from "./schema/jira.js";
