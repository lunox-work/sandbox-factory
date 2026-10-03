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
 * - `schema/organizations.ts` — the second principal, its membership, and the
 *   handle namespace both principals share.
 * - `schema/jira.ts` — connections to a client's Atlassian site.
 * - `schema/github.ts` — installations of the GitHub App, the grants that
 *   linked them, and the repositories registered from them.
 * - `schema/analysis.ts` — what is known about a repository at one commit.
 * - `schema/sandbox.ts` — tasks cut from a repository, their versions and
 *   the private provenance behind each.
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
  handle,
  member,
  organization,
  ORGANIZATION_KINDS,
} from "./schema/organizations.js";
export type {
  HandleRow,
  OrganizationKind,
  InvitationRow,
  MemberRow,
  NewMemberRow,
  NewOrganizationRow,
  OrganizationRow,
} from "./schema/organizations.js";

export { jiraBoard, jiraConnection, jiraIssue } from "./schema/jira.js";
export type {
  JiraBoardRow,
  JiraConnectionRow,
  JiraIssueRow,
  NewJiraBoardRow,
  NewJiraConnectionRow,
  NewJiraIssueRow,
} from "./schema/jira.js";

export { githubConnection, githubGrant, githubRepo } from "./schema/github.js";
export type {
  GithubConnectionRow,
  GithubGrantRow,
  GithubRepoRow,
  NewGithubConnectionRow,
  NewGithubGrantRow,
  NewGithubRepoRow,
} from "./schema/github.js";

export { repoSnapshot, analysisRun, artifact } from "./schema/analysis.js";
export type {
  NewRepoSnapshotRow,
  RepoSnapshotRow,
  AnalysisRunRow,
  ArtifactRow,
} from "./schema/analysis.js";

export {
  BOUNTY_SPEC_ORIGINS,
  bountyProposal,
  bountyRun,
  bountySpec,
  bountyWriteback,
  rateCard,
} from "./schema/bounty.js";
export type {
  BountyProposalRow,
  BountyRunRow,
  BountySpecOrigin,
  BountySpecRow,
  BountyWritebackPayload,
  BountyWritebackRow,
  NewBountyProposalRow,
  NewBountyRunRow,
  NewBountySpecRow,
  NewBountyWritebackRow,
  NewRateCardRow,
  RateCardRow,
} from "./schema/bounty.js";

export {
  sandbox,
  sandboxJiraIssue,
  sandboxSource,
  sandboxVersion,
  sandboxVersionSource,
} from "./schema/sandbox.js";
export type {
  SandboxJiraIssueRow,
  SandboxRow,
  SandboxSourceRow,
  SandboxVersionRow,
  SandboxVersionSourceRow,
} from "./schema/sandbox.js";
