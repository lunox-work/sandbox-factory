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
export {
  createJiraBoardStore,
  mergePricing,
  mergeSelection,
} from "./jira-boards.js";
export type {
  JiraBoardStore,
  JiraBoardSummary,
  RegisterBoardInput,
  StoredBoardPricing,
  StoredBoardSelection,
  StoredCategorySettings,
  StoredStepSettings,
  SyncBoardInput,
  UpdateBoardInput,
} from "./jira-boards.js";
export { createBountyStore, followsJira } from "./bounties.js";
export type {
  ListedBounty,
  NewBounty,
  StoredBounty,
  BountyChange,
  BountyJiraLink,
  BountyMutationResult,
  BountyProposalSummary,
  BountySandboxSummary,
  BountyStore,
} from "./bounties.js";
export { createJiraIssueStore } from "./jira-issues.js";
export type {
  JiraIssueInput,
  JiraIssuePointer,
  JiraIssueStore,
  JiraIssueLinkResult,
} from "./jira-issues.js";
export { createRateCardStore } from "./rate-cards.js";
export type {
  PutRateCardResult,
  RateCardStore,
  StoredRateCard,
} from "./rate-cards.js";
export { createBountyRunStore, runDeadline } from "./bounty-runs.js";
export type {
  BountyRunStore,
  CreateBountyRunInput,
  CreateBountyRunResult,
  StoredBountyRun,
} from "./bounty-runs.js";
export { createBountyProposalStore } from "./bounty-proposals.js";
export type {
  ApplyRubricInput,
  BountyProposalStore,
  CreateBountyProposalInput,
  LeasedBountyProposalInput,
  ListedBountyProposal,
  ProposalMutationResult,
  StoredBountyProposal,
} from "./bounty-proposals.js";
export {
  createBountyProfileStore,
  PENDING_PROFILE_STATUSES,
} from "./bounty-profiles.js";
export type {
  BountyProfileStore,
  NewBountyProfile,
  ProfileTransition,
  StoredBountyProfile,
} from "./bounty-profiles.js";
export { createBountySpecStore } from "./bounty-specs.js";
export type {
  BountySpecStore,
  NewBountySpec,
  StoredBountySpec,
  StoredBountySpecRevision,
} from "./bounty-specs.js";
export { createBountyWritebackStore } from "./bounty-writebacks.js";
export type {
  BountyWritebackStore,
  StoredBountyWriteback,
  WritebackKind,
  WritebackStatus,
} from "./bounty-writebacks.js";
export {
  createJiraConnectionStore,
  jiraWriteGranted,
} from "./jira-connections.js";
export type {
  JiraConnectionInput,
  JiraConnectionStore,
  JiraConnectionSummary,
  JiraConnectionTokens,
} from "./jira-connections.js";
export { createGithubConnectionStore } from "./github-connections.js";
export type {
  GithubConnectionPatch,
  GithubConnectionStore,
  GithubConnectionSummary,
  GithubFlaggedConnection,
  GithubInstallationInput,
  GithubLinkResult,
} from "./github-connections.js";
export { createGithubGrantStore } from "./github-grants.js";
export type {
  GithubGrantInput,
  GithubGrantStore,
  GithubGrantSummary,
  GithubGrantTokens,
} from "./github-grants.js";
export { createGithubRepoStore } from "./github-repos.js";
export type {
  DueGithubRepo,
  GithubRepoMetadata,
  GithubRepoRole,
  GithubRepoStore,
  GithubRepoSummary,
  DetectedStack,
  RegisterGithubRepoInput,
} from "./github-repos.js";
export { createRepoSnapshotStore } from "./repo-snapshots.js";
export type {
  CreateRepoSnapshotResult,
  NewRepoSnapshot,
  RepoSnapshotStore,
  RepoSnapshotSummary,
  StoredRepoSnapshot,
} from "./repo-snapshots.js";
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
export { NotFoundError, RepositoryInUseError } from "./errors.js";
export type { Database } from "./errors.js";
export { createAnalysisRunStore } from "./analysis-runs.js";
export type {
  AnalysisRunStore,
  StoredAnalysisRun,
  ClaimedAnalysisRun,
  EnqueueAnalysisResult,
  NewArtifact,
} from "./analysis-runs.js";
export { createArtifactStore } from "./artifacts.js";
export type { ArtifactStore, StoredArtifact } from "./artifacts.js";
export { createSandboxStore, sandboxSlug } from "./sandboxes.js";
export type {
  BuildOutput,
  CreateSandboxResult,
  CreateVersionResult,
  LinkSourceResult,
  NewSandboxVersion,
  NewSlicedSource,
  NewStarterSource,
  ReplayContext,
  SandboxStore,
  SandboxVersionPatch,
  StarterOutput,
  StoredSandbox,
  StoredSandboxVersion,
  StoredVersionSource,
  StoredVersionWithSource,
  PublishVersionResult,
  UpdateVersionResult,
} from "./sandboxes.js";
export { createSubmissionStore } from "./submissions.js";
export type {
  CreateSubmissionResult,
  NewSubmission,
  StoredSubmission,
  SubmissionOutcome,
  SubmissionStore,
} from "./submissions.js";
