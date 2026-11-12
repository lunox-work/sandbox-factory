/**
 * The public API: every route an API token or an OAuth access token may
 * reach (and so every route an MCP tool may wrap), with the scope it needs
 * and the schemas it speaks.
 *
 * **Deny by default.** The credential guard (`credentials.ts`) admits a
 * bound credential only to a route listed here, matched by the exact Hono
 * pattern the route is registered under, and only when the credential
 * holds the listed scope. A route left out is refused to every token,
 * however broad its scopes. Sessions are unaffected: the web app and the
 * extension reach every route as before.
 *
 * A scope never widens a role: a listed route that only owners and admins
 * may use still checks the acting role (the token creator's, read at use).
 *
 * A **self** route (`scope: null`) needs no scope: it acts only on the
 * credential presenting it, named by nothing in the request, so any bound
 * credential may call it and none can reach another through it. Logging
 * out (`POST /tokens/self/revoke`) is the one.
 *
 * A create is marked `idempotent`: a machine credential's retry under the
 * same `Idempotency-Key` gets its first answer back (`idempotency.ts`).
 *
 * Every entry declares its request body (`null` when it takes none) and its
 * response schema, both from `@sandbox-factory/shared`; `openapi.ts` turns
 * the list into `GET /api/v1/openapi.json`, and `public-api.test.ts` fails
 * on an entry without them. Left out on purpose (PLAN.md section 3): price
 * and slice approval, publishing, writeback cancel and token management are
 * a person's act in the web app; routes the extension or web app alone use
 * stay private until someone needs them public.
 */

import {
  addIssueSchema,
  analysisRunListSchema,
  analysisRunResponseSchema,
  artifactListSchema,
  artifactUrlSchema,
  bountyListResponseSchema,
  connectUrlResponseSchema,
  bountyResponseSchema,
  bountyRunListResponseSchema,
  bountyRunResponseSchema,
  bountySizingResponseSchema,
  buildAllSchema,
  postBountySchema,
  sandboxHandoutSchema,
  createSubmissionSchema,
  createUploadSchema,
  submissionFilesResponseSchema,
  uploadResponseSchema,
  submissionListSchema,
  submissionResponseSchema,
  proposalDecisionsResponseSchema,
  proposalSpecDocumentResponseSchema,
  createRunSchema,
  createSandboxSchema,
  createSandboxVersionSchema,
  decideBountySchema,
  enqueueAnalysisSchema,
  enqueueScopeSchema,
  enqueueSliceSchema,
  enqueueSliceResponseSchema,
  generateStarterResponseSchema,
  githubAvailableInstallationsSchema,
  githubConnectionListSchema,
  githubRepoListSchema,
  jiraBacklogPreviewSchema,
  jiraBoardListSchema,
  jiraBoardResponseDtoSchema,
  jiraConnectionListSchema,
  jiraImportRequestSchema,
  jiraImportResponseSchema,
  jiraIssueDetailResponseSchema,
  jiraIssueSearchSchema,
  jiraSiteBoardListSchema,
  jiraSyncResponseSchema,
  jiraWorkspaceIssueSearchSchema,
  meResponseSchema,
  membershipListSchema,
  organizationMemberListSchema,
  organizationResponseSchema,
  proposalActionResponseSchema,
  proposalDetailResponseSchema,
  proposalListResponseSchema,
  proposalMutationSchema,
  proposalProfileResponseSchema,
  proposalSpecResponseSchema,
  proposalSpecRevisionsResponseSchema,
  proposeBountySchema,
  putRateCardSchema,
  rateCardResponseSchema,
  registerBoardSchema,
  replayResponseSchema,
  repoBranchListSchema,
  repoSnapshotListSchema,
  repoSnapshotResponseSchema,
  repoTreePageDtoSchema,
  repoTreeQuerySchema,
  repriceProposalSchema,
  resizeProposalSchema,
  respecProposalSchema,
  runLogContentSchema,
  sandboxFileContentSchema,
  sandboxFileListSchema,
  sandboxListSchema,
  sandboxResponseSchema,
  sandboxVersionListSchema,
  sandboxVersionResponseSchema,
  scopeVersionListSchema,
  startSandboxResponseSchema,
  updateBoardSchema,
  updateBountySchema,
  updateSandboxVersionSchema,
  usageQuerySchema,
  usageResponseSchema,
  createWebhookSchema,
  updateWebhookSchema,
  webhookDeliveryListSchema,
  webhookDeliveryResponseSchema,
  webhookEndpointListSchema,
  webhookEndpointResponseSchema,
  webhookSecretResponseSchema,
  workspaceSettingsSchema,
  writebackOperationResponseSchema,
  writebackReconcileResponseSchema,
} from "@sandbox-factory/shared";
import type { ApiScope } from "sandbox-factory";
import type { z } from "zod";

export type PublicMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What a route answers on success. */
export type PublicResponse =
  | { readonly status: 200 | 201 | 202; readonly schema: z.ZodType }
  /** No body: a removal. */
  | { readonly status: 204 }
  /**
   * A browser step: the answer is a `Location` to follow, not data; or,
   * when `schema` is given, that body to a client sending
   * `Accept: application/json`.
   */
  | { readonly status: 302; readonly schema?: z.ZodType };

export interface PublicRoute {
  readonly method: PublicMethod;
  /** The Hono pattern the route is registered under, `/api/v1/...`. */
  readonly path: string;
  /** Null for a self route: any bound credential, acting on itself only. */
  readonly scope: ApiScope | null;
  readonly summary: string;
  /** The OpenAPI tag: the section of PLAN.md section 3 it belongs to. */
  readonly tag:
    "Workspace" | "Integrations" | "Bounties" | "Sandboxes" | "Webhooks";
  /** The JSON body it reads, or null when it reads none. */
  readonly request: z.ZodType | null;
  /** Query parameters, where a shared schema states them. */
  readonly query?: z.ZodObject | undefined;
  readonly response: PublicResponse;
  /**
   * A create: an `Idempotency-Key` replays its first answer to a retry
   * (`idempotency.ts`).
   */
  readonly idempotent?: true | undefined;
}

const V1 = "/api/v1";
const ORG = `${V1}/orgs/:orgId`;
const GH = `${ORG}/github`;
const JIRA = `${ORG}/jira`;
const SBX = `${ORG}/sandboxes`;
const HOOKS = `${ORG}/webhooks`;

const ok = (schema: z.ZodType) => ({ status: 200, schema }) as const;
const created = (schema: z.ZodType) => ({ status: 201, schema }) as const;
const accepted = (schema: z.ZodType) => ({ status: 202, schema }) as const;
const removed = { status: 204 } as const;
/** A connect flow: a redirect, or its URL as JSON to an API client. */
const connectStep = {
  status: 302,
  schema: connectUrlResponseSchema,
} as const;

/** Reads: `workspace:read`, no body. */
function read(
  path: string,
  summary: string,
  tag: PublicRoute["tag"],
  schema: z.ZodType,
  query?: z.ZodObject,
): PublicRoute {
  return {
    method: "GET",
    path,
    scope: "workspace:read",
    summary,
    tag,
    request: null,
    query,
    response: ok(schema),
  };
}

export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  // The credential itself
  {
    method: "POST",
    path: `${V1}/tokens/self/revoke`,
    scope: null,
    summary:
      "Revoke the presenting API token or OAuth access token (log out); no scope needed",
    tag: "Workspace",
    request: null,
    response: removed,
  },

  // Workspace
  read(
    `${V1}/me`,
    "The account the credential acts as",
    "Workspace",
    meResponseSchema,
  ),
  read(
    `${V1}/me/orgs`,
    "Workspaces the credential reaches (a token: its own only)",
    "Workspace",
    membershipListSchema,
  ),
  read(
    ORG,
    "One workspace, with the acting role",
    "Workspace",
    organizationResponseSchema,
  ),
  read(
    `${ORG}/members`,
    "The workspace's members",
    "Workspace",
    organizationMemberListSchema,
  ),
  read(
    `${ORG}/settings`,
    "The workspace's settings",
    "Workspace",
    workspaceSettingsSchema,
  ),
  read(
    `${ORG}/rate-card`,
    "The workspace's rate card",
    "Workspace",
    rateCardResponseSchema,
  ),
  {
    method: "PUT",
    path: `${ORG}/rate-card`,
    scope: "pricing:write",
    summary: "Replace the rate card (owners and admins)",
    tag: "Workspace",
    request: putRateCardSchema,
    response: ok(rateCardResponseSchema),
  },
  read(
    `${ORG}/usage`,
    "Runs started in a window, by family, kind and state",
    "Workspace",
    usageResponseSchema,
    usageQuerySchema,
  ),

  // Integrations: GitHub
  {
    method: "GET",
    path: `${GH}/connect`,
    scope: "integrations:write",
    summary:
      "Connect the GitHub App (a browser step): redirects, or answers `{ url }` to `Accept: application/json` for a person to open",
    tag: "Integrations",
    request: null,
    response: connectStep,
  },
  read(
    `${GH}/connections`,
    "Linked GitHub installations",
    "Integrations",
    githubConnectionListSchema,
  ),
  read(
    `${GH}/connections/available`,
    "GitHub installations the acting person may link",
    "Integrations",
    githubAvailableInstallationsSchema,
  ),
  read(
    `${GH}/repositories`,
    "Registered repositories",
    "Integrations",
    githubRepoListSchema,
  ),
  {
    method: "DELETE",
    path: `${GH}/repositories/:id`,
    scope: "integrations:write",
    summary: "Remove a registered repository (owners and admins)",
    tag: "Integrations",
    request: null,
    response: removed,
  },
  read(
    `${GH}/repositories/:id/branches`,
    "A repository's branches, the default first",
    "Integrations",
    repoBranchListSchema,
  ),
  read(
    `${GH}/repositories/:id/snapshots`,
    "A repository's snapshots, newest first",
    "Integrations",
    repoSnapshotListSchema,
  ),
  read(
    `${GH}/snapshots/:id`,
    "One snapshot and its tree facts",
    "Integrations",
    repoSnapshotResponseSchema,
  ),
  read(
    `${GH}/snapshots/:id/tree`,
    "One page of a snapshot's file list",
    "Integrations",
    repoTreePageDtoSchema,
    repoTreeQuerySchema,
  ),

  // Integrations: Jira
  {
    method: "GET",
    path: `${JIRA}/connect`,
    scope: "integrations:write",
    summary:
      "Connect a Jira site (a browser step): redirects, or answers `{ url }` to `Accept: application/json` for a person to open",
    tag: "Integrations",
    request: null,
    response: connectStep,
  },
  read(
    `${JIRA}/connections`,
    "Connected Jira sites",
    "Integrations",
    jiraConnectionListSchema,
  ),
  read(
    `${JIRA}/connections/:id/boards`,
    "The boards a connected site's grant can see",
    "Integrations",
    jiraSiteBoardListSchema,
  ),
  {
    method: "POST",
    path: `${JIRA}/connections/:id/sync`,
    scope: "integrations:write",
    summary: "Re-read a site's boards (owners and admins)",
    tag: "Integrations",
    request: null,
    response: ok(jiraSyncResponseSchema),
  },
  read(
    `${JIRA}/boards`,
    "Registered boards",
    "Integrations",
    jiraBoardListSchema,
  ),
  {
    method: "POST",
    path: `${JIRA}/boards`,
    scope: "integrations:write",
    summary: "Register a board (owners and admins)",
    tag: "Integrations",
    request: registerBoardSchema,
    response: created(jiraBoardResponseDtoSchema),
  },
  {
    method: "PATCH",
    path: `${JIRA}/boards/:id`,
    scope: "integrations:write",
    summary: "Change a board's settings (owners and admins)",
    tag: "Integrations",
    request: updateBoardSchema,
    response: ok(jiraBoardResponseDtoSchema),
  },
  read(
    `${JIRA}/boards/:id/issues/:issueKey`,
    "One Jira issue on a board",
    "Integrations",
    jiraIssueDetailResponseSchema,
  ),
  read(
    `${JIRA}/boards/:id/backlog-preview`,
    "What a board's backlog scan would offer, with no model call",
    "Integrations",
    jiraBacklogPreviewSchema,
  ),
  read(
    `${JIRA}/boards/:id/search`,
    "Search one board's issues (`q`)",
    "Integrations",
    jiraIssueSearchSchema,
  ),
  read(
    `${JIRA}/search`,
    "Search every board's issues (`q`)",
    "Integrations",
    jiraWorkspaceIssueSearchSchema,
  ),

  // Posting work: bounties
  read(
    `${ORG}/bounties`,
    "Bounties, newest first",
    "Bounties",
    bountyListResponseSchema,
  ),
  {
    method: "POST",
    path: `${ORG}/bounties`,
    idempotent: true,
    scope: "bounties:write",
    summary:
      "Write a bounty from text, or import one from a connected repository's GitHub issue (`source.githubIssue`; an issue imported before answers 200 with its bounty)",
    tag: "Bounties",
    request: postBountySchema,
    response: created(bountyResponseSchema),
  },
  read(`${ORG}/bounties/:id`, "One bounty", "Bounties", bountyResponseSchema),
  {
    method: "PATCH",
    path: `${ORG}/bounties/:id`,
    scope: "bounties:write",
    summary: "Edit a bounty's scope",
    tag: "Bounties",
    request: updateBountySchema,
    response: ok(bountyResponseSchema),
  },
  {
    method: "DELETE",
    path: `${ORG}/bounties/:id`,
    scope: "bounties:write",
    summary: "Delete a bounty nothing is built on (owners and admins)",
    tag: "Bounties",
    request: null,
    response: removed,
  },
  read(
    `${ORG}/bounties/:id/versions`,
    "A bounty's scope versions",
    "Bounties",
    scopeVersionListSchema,
  ),
  {
    method: "POST",
    path: `${ORG}/bounties/:id/approve`,
    scope: "bounties:write",
    summary: "Approve a bounty's scope (owners and admins)",
    tag: "Bounties",
    request: decideBountySchema,
    response: ok(bountyResponseSchema),
  },
  {
    method: "POST",
    path: `${ORG}/bounties/:id/unapprove`,
    scope: "bounties:write",
    summary: "Withdraw a scope approval (owners and admins)",
    tag: "Bounties",
    request: decideBountySchema,
    response: ok(bountyResponseSchema),
  },
  {
    method: "POST",
    path: `${JIRA}/boards/:id/import`,
    scope: "bounties:write",
    summary: "Import a board's backlog scan as bounties, unsized",
    tag: "Bounties",
    request: jiraImportRequestSchema,
    response: ok(jiraImportResponseSchema),
  },

  // Posting work: sizing and proposals
  read(
    `${ORG}/bounties/:id/sizing`,
    "The run sizing a bounty, if any",
    "Bounties",
    bountySizingResponseSchema,
  ),
  {
    method: "POST",
    path: `${ORG}/bounties/:id/propose`,
    idempotent: true,
    scope: "pricing:write",
    summary: "Size and price a bounty (one model call)",
    tag: "Bounties",
    request: proposeBountySchema,
    response: accepted(proposalActionResponseSchema),
  },
  {
    method: "POST",
    path: `${JIRA}/boards/:id/issues`,
    idempotent: true,
    scope: "pricing:write",
    summary: "Size one Jira issue as a bounty (owners and admins)",
    tag: "Bounties",
    request: addIssueSchema,
    response: accepted(proposalActionResponseSchema),
  },
  {
    method: "POST",
    path: `${JIRA}/boards/:id/runs`,
    idempotent: true,
    scope: "pricing:write",
    summary: "Size every issue a board's scan selects (owners and admins)",
    tag: "Bounties",
    request: createRunSchema,
    response: accepted(bountyRunResponseSchema),
  },
  read(
    `${JIRA}/boards/:id/runs`,
    "A board's sizing runs",
    "Bounties",
    bountyRunListResponseSchema,
  ),
  read(
    `${ORG}/runs/:id`,
    "One sizing run",
    "Bounties",
    bountyRunResponseSchema,
  ),
  read(
    `${ORG}/proposals`,
    "Proposals, newest first",
    "Bounties",
    proposalListResponseSchema,
  ),
  read(
    `${ORG}/proposals/:id`,
    "One proposal and its freshness",
    "Bounties",
    proposalDetailResponseSchema,
  ),
  read(
    `${ORG}/proposals/:id/spec`,
    "A proposal's spec",
    "Bounties",
    proposalSpecResponseSchema,
  ),
  read(
    `${ORG}/proposals/:id/profile`,
    "A proposal's complexity profile",
    "Bounties",
    proposalProfileResponseSchema,
  ),
  read(
    `${ORG}/proposals/:id/spec/revisions`,
    "A proposal's spec revisions",
    "Bounties",
    proposalSpecRevisionsResponseSchema,
  ),
  read(
    `${ORG}/proposals/:id/spec/gherkin`,
    "A proposal's spec as Gherkin with its Decided: list",
    "Bounties",
    proposalSpecDocumentResponseSchema,
  ),
  read(
    `${ORG}/proposals/:id/decisions`,
    "A spec's decisions, their confirmation and where a person confirms",
    "Bounties",
    proposalDecisionsResponseSchema,
  ),
  {
    method: "POST",
    path: `${ORG}/proposals/:id/resize`,
    scope: "pricing:write",
    summary: "Resize a proposal (owners and admins)",
    tag: "Bounties",
    request: resizeProposalSchema,
    response: ok(proposalActionResponseSchema),
  },
  {
    method: "POST",
    path: `${ORG}/proposals/:id/rubric`,
    scope: "pricing:write",
    summary: "Price a proposal by the rubric (owners and admins)",
    tag: "Bounties",
    request: proposalMutationSchema,
    response: ok(proposalActionResponseSchema),
  },
  {
    method: "POST",
    path: `${ORG}/proposals/:id/reprice`,
    scope: "pricing:write",
    summary: "Re-price a proposal (owners and admins)",
    tag: "Bounties",
    request: repriceProposalSchema,
    response: accepted(proposalActionResponseSchema),
  },
  {
    method: "POST",
    path: `${ORG}/proposals/:id/respec`,
    scope: "specs:write",
    summary: "Change a proposal's spec (owners and admins)",
    tag: "Bounties",
    request: respecProposalSchema,
    response: accepted(proposalActionResponseSchema),
  },
  {
    method: "POST",
    path: `${ORG}/writebacks/:id/retry`,
    scope: "pricing:write",
    summary: "Retry a failed Jira writeback (owners and admins)",
    tag: "Bounties",
    request: null,
    response: accepted(writebackOperationResponseSchema),
  },
  {
    method: "POST",
    path: `${ORG}/writebacks/:id/reconcile`,
    scope: "pricing:write",
    summary: "Adopt a writeback Jira already holds (owners and admins)",
    tag: "Bounties",
    request: null,
    response: ok(writebackReconcileResponseSchema),
  },

  // Sandboxes: analysis and context
  {
    method: "POST",
    path: `${GH}/repositories/:id/runs`,
    idempotent: true,
    scope: "sandboxes:write",
    summary: "Run one context builder on a repository (owners and admins)",
    tag: "Sandboxes",
    request: enqueueAnalysisSchema,
    response: accepted(analysisRunResponseSchema),
  },
  {
    method: "POST",
    path: `${GH}/repositories/:id/builds`,
    idempotent: true,
    scope: "sandboxes:write",
    summary: "Run every context builder on a repository (owners and admins)",
    tag: "Sandboxes",
    request: buildAllSchema,
    response: accepted(analysisRunListSchema),
  },
  {
    method: "POST",
    path: `${GH}/repositories/:id/slices`,
    idempotent: true,
    scope: "sandboxes:write",
    summary: "Slice a repository from entry points (owners and admins)",
    tag: "Sandboxes",
    request: enqueueSliceSchema,
    response: accepted(enqueueSliceResponseSchema),
  },
  {
    method: "POST",
    path: `${GH}/repositories/:id/scope`,
    idempotent: true,
    scope: "sandboxes:write",
    summary: "Run the scope agent for a proposal (owners and admins)",
    tag: "Sandboxes",
    request: enqueueScopeSchema,
    response: accepted(enqueueSliceResponseSchema),
  },
  read(
    `${GH}/repositories/:id/runs`,
    "A repository's analysis runs",
    "Sandboxes",
    analysisRunListSchema,
  ),
  read(
    `${GH}/runs/:id`,
    "One analysis run",
    "Sandboxes",
    analysisRunResponseSchema,
  ),
  read(
    `${GH}/runs/:id/artifacts`,
    "An analysis run's artifacts",
    "Sandboxes",
    artifactListSchema,
  ),
  read(
    `${GH}/runs/:id/log/url`,
    "A signed URL for a run's log (owners and admins)",
    "Sandboxes",
    artifactUrlSchema,
  ),
  read(
    `${GH}/runs/:id/log/content`,
    "A run's log as text (owners and admins)",
    "Sandboxes",
    runLogContentSchema,
  ),

  // Sandboxes: versions
  read(SBX, "Sandboxes", "Sandboxes", sandboxListSchema),
  {
    method: "POST",
    path: `${SBX}/start`,
    idempotent: true,
    scope: "sandboxes:write",
    summary: "Start a bounty's sandbox (owners and admins)",
    tag: "Sandboxes",
    request: createSandboxSchema,
    response: created(startSandboxResponseSchema),
  },
  {
    method: "POST",
    path: `${SBX}/uploads`,
    idempotent: true,
    scope: "sandboxes:write",
    summary:
      "Upload a public, pseudonymised carveout hand-off folder as a bounty's version (owners and admins)",
    tag: "Sandboxes",
    request: createUploadSchema,
    response: accepted(uploadResponseSchema),
  },
  read(`${SBX}/:id`, "One sandbox", "Sandboxes", sandboxResponseSchema),
  {
    method: "PUT",
    path: `${SBX}/:id/source`,
    scope: "sandboxes:write",
    summary: "Link a sandbox to its bounty's repository (owners and admins)",
    tag: "Sandboxes",
    request: null,
    response: ok(sandboxResponseSchema),
  },
  {
    method: "POST",
    path: `${SBX}/:id/starter`,
    idempotent: true,
    scope: "sandboxes:write",
    summary: "Generate a version from the bounty's text (owners and admins)",
    tag: "Sandboxes",
    request: null,
    response: accepted(generateStarterResponseSchema),
  },
  read(
    `${SBX}/:id/versions`,
    "A sandbox's versions",
    "Sandboxes",
    sandboxVersionListSchema,
  ),
  {
    method: "POST",
    path: `${SBX}/:id/versions`,
    idempotent: true,
    scope: "sandboxes:write",
    summary: "Cut a draft version from a slice run (owners and admins)",
    tag: "Sandboxes",
    request: createSandboxVersionSchema,
    response: created(sandboxVersionResponseSchema),
  },
  read(
    `${SBX}/versions/:vid`,
    "One version",
    "Sandboxes",
    sandboxVersionResponseSchema,
  ),
  {
    method: "PATCH",
    path: `${SBX}/versions/:vid`,
    scope: "sandboxes:write",
    summary: "Change a draft version (owners and admins)",
    tag: "Sandboxes",
    request: updateSandboxVersionSchema,
    response: ok(sandboxVersionResponseSchema),
  },
  {
    method: "POST",
    path: `${SBX}/versions/:vid/build`,
    idempotent: true,
    scope: "sandboxes:write",
    summary: "Build a draft version (owners and admins)",
    tag: "Sandboxes",
    request: null,
    response: accepted(analysisRunResponseSchema),
  },
  read(
    `${SBX}/versions/:vid/files`,
    "A version's files",
    "Sandboxes",
    sandboxFileListSchema,
  ),
  {
    method: "POST",
    path: `${SBX}/versions/:vid/submissions`,
    idempotent: true,
    scope: "submissions:write",
    summary:
      "Submit files against a published version, to be graded (owners and admins)",
    tag: "Sandboxes",
    request: createSubmissionSchema,
    response: accepted(submissionResponseSchema),
  },
  {
    method: "POST",
    path: `${SBX}/submissions/:sid/retry`,
    idempotent: true,
    scope: "submissions:write",
    summary:
      "Retry a failed submission once with new files, told only its failing scenario keys (owners and admins)",
    tag: "Sandboxes",
    request: createSubmissionSchema,
    response: accepted(submissionResponseSchema),
  },
  {
    method: "GET",
    path: `${SBX}/submissions/:sid/files`,
    scope: "submissions:write",
    summary:
      "A passing submission's changed files on an uploaded version, never a hidden test (owners and admins)",
    tag: "Sandboxes",
    request: null,
    response: ok(submissionFilesResponseSchema),
  },
  read(
    `${SBX}/versions/:vid/submissions`,
    "A version's submissions and their verdicts",
    "Sandboxes",
    submissionListSchema,
  ),
  read(
    `${SBX}/submissions/:sid`,
    "One submission's verdict: counts and failing scenario keys only",
    "Sandboxes",
    submissionResponseSchema,
  ),
  read(
    `${SBX}/versions/:vid/handout`,
    "A built version's public files and its hidden suite's commitment hash",
    "Sandboxes",
    sandboxHandoutSchema,
  ),
  read(
    `${SBX}/versions/:vid/files/content`,
    "One file's content (`path`)",
    "Sandboxes",
    sandboxFileContentSchema,
  ),
  read(
    `${SBX}/versions/:vid/replay`,
    "What a version was built from",
    "Sandboxes",
    replayResponseSchema,
  ),

  // Webhooks out
  read(
    HOOKS,
    "Webhook endpoints (owners and admins)",
    "Webhooks",
    webhookEndpointListSchema,
  ),
  {
    method: "POST",
    path: HOOKS,
    idempotent: true,
    scope: "webhooks:write",
    summary:
      "Add a webhook endpoint; answers its signing secret once (owners and admins)",
    tag: "Webhooks",
    request: createWebhookSchema,
    response: created(webhookSecretResponseSchema),
  },
  read(
    `${HOOKS}/:id`,
    "One webhook endpoint (owners and admins)",
    "Webhooks",
    webhookEndpointResponseSchema,
  ),
  {
    method: "PATCH",
    path: `${HOOKS}/:id`,
    scope: "webhooks:write",
    summary:
      "Change an endpoint's URL, events or enabled state (owners and admins)",
    tag: "Webhooks",
    request: updateWebhookSchema,
    response: ok(webhookEndpointResponseSchema),
  },
  {
    method: "DELETE",
    path: `${HOOKS}/:id`,
    scope: "webhooks:write",
    summary: "Remove an endpoint and its deliveries (owners and admins)",
    tag: "Webhooks",
    request: null,
    response: removed,
  },
  {
    method: "POST",
    path: `${HOOKS}/:id/rotate-secret`,
    scope: "webhooks:write",
    summary:
      "Replace an endpoint's signing secret; answers it once (owners and admins)",
    tag: "Webhooks",
    request: null,
    response: ok(webhookSecretResponseSchema),
  },
  read(
    `${HOOKS}/:id/deliveries`,
    "An endpoint's deliveries, newest first (owners and admins)",
    "Webhooks",
    webhookDeliveryListSchema,
  ),
  {
    method: "POST",
    path: `${HOOKS}/:id/deliveries/:deliveryId/redeliver`,
    scope: "webhooks:write",
    summary: "Send a delivery again now (owners and admins)",
    tag: "Webhooks",
    request: null,
    response: accepted(webhookDeliveryResponseSchema),
  },
  {
    method: "POST",
    path: `${HOOKS}/:id/ping`,
    scope: "webhooks:write",
    summary: "Send an endpoint a test ping event (owners and admins)",
    tag: "Webhooks",
    request: null,
    response: accepted(webhookDeliveryResponseSchema),
  },
];

const byRoute = new Map(
  PUBLIC_ROUTES.map((route) => [`${route.method} ${route.path}`, route]),
);

/** The public route registered as `method path`, or undefined. */
export function publicRoute(
  method: string,
  path: string,
): PublicRoute | undefined {
  return byRoute.get(`${method} ${path}`);
}
