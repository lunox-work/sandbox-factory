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
 * - `schema/bounty.ts` — the organization's own bounties: the record a
 *   proposal and a sandbox hang from, whether written here or imported.
 * - `schema/pricing.ts` — what bounties are priced at, and how they got
 *   there: rate cards, sizing runs, proposals and their specs.
 * - `schema/jira.ts` — connections to a client's Atlassian site, and the
 *   issues imported from it as bounties.
 * - `schema/github.ts` — installations of the GitHub App, the grants that
 *   linked them, and the repositories registered from them.
 * - `schema/analysis.ts` — what is known about a repository at one commit.
 * - `schema/sandbox.ts` — a bounty's sandbox: its versions, the private
 *   provenance behind each, and the submissions judged by them.
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

export { bounty, bountyContext, bountyVersion } from "./schema/bounty.js";
export type {
  NewBountyRow,
  BountyRow,
  BountyVersionRow,
  BountyContextRow,
} from "./schema/bounty.js";

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
  bountyProfile,
  bountyProposal,
  bountyRun,
  bountySpec,
  bountyWriteback,
  rateCard,
} from "./schema/pricing.js";
export type {
  BountyProfileRow,
  BountyProposalRow,
  BountyRunRow,
  BountySpecOrigin,
  BountySpecRow,
  BountyWritebackPayload,
  BountyWritebackRow,
  NewBountyProfileRow,
  NewBountyProposalRow,
  NewBountyRunRow,
  NewBountySpecRow,
  NewBountyWritebackRow,
  NewRateCardRow,
  RateCardRow,
} from "./schema/pricing.js";

export {
  sandbox,
  sandboxSource,
  sandboxVersion,
  sandboxVersionSource,
  submission,
} from "./schema/sandbox.js";
export type {
  NewSubmissionRow,
  SandboxRow,
  SandboxSourceRow,
  SandboxVersionRow,
  SandboxVersionSourceRow,
  SubmissionRow,
} from "./schema/sandbox.js";
