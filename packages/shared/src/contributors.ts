/**
 * Invited contributors: a person outside a workspace, invited by its owners
 * or admins to work on one published version, before there is a
 * marketplace. The workspace's side (`/orgs/:orgId/sandboxes/…/invites`,
 * `…/contributors`) makes and revokes invites and assignments; the
 * contributor's side (`/contributions/…`, `POST /invites/claim`) answers
 * only what a contributor may see: the version's public listing and
 * project, and their own submissions' verdicts.
 */

import { z } from "zod";

import { submissionDtoSchema } from "./sandbox.js";

/** How long an invite admits claims unless the inviter says otherwise. */
export const CONTRIBUTOR_INVITE_DEFAULT_DAYS = 14;
export const CONTRIBUTOR_INVITE_MAX_DAYS = 30;
/** The most people one invite may admit; one unless said. */
export const CONTRIBUTOR_INVITE_MAX_CLAIMS = 20;
/**
 * The web app's page a claim link opens. The secret rides in the
 * fragment (`/invite#lnxinv_…`), which no server or `Referer` receives.
 */
export const CONTRIBUTOR_INVITE_PATH = "/invite";

/** `POST /orgs/:orgId/sandboxes/versions/:vid/invites`. */
export const createContributorInviteSchema = z.strictObject({
  /** The inviter's note of who it is for, shown to the workspace only. */
  label: z.string().trim().min(1).max(100).optional(),
  /** A hint of the address it was sent to; not checked at claim. */
  email: z.email().max(320).optional(),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(CONTRIBUTOR_INVITE_MAX_DAYS)
    .default(CONTRIBUTOR_INVITE_DEFAULT_DAYS),
  maxClaims: z
    .number()
    .int()
    .min(1)
    .max(CONTRIBUTOR_INVITE_MAX_CLAIMS)
    .default(1),
});
export type CreateContributorInviteInput = z.input<
  typeof createContributorInviteSchema
>;

export const CONTRIBUTOR_INVITE_STATES = [
  "active",
  "claimed",
  "expired",
  "revoked",
] as const;

/** An invite as the workspace lists it: never its secret, which is not kept. */
export const contributorInviteDtoSchema = z.object({
  id: z.string(),
  sandboxVersionId: z.string(),
  label: z.string().nullable(),
  emailHint: z.string().nullable(),
  /** `claimed` once every claim it admits is made. */
  state: z.enum(CONTRIBUTOR_INVITE_STATES),
  maxClaims: z.number().int().positive(),
  claims: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  claimedAt: z.iso.datetime().nullable(),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
});
export type ContributorInviteDto = z.infer<typeof contributorInviteDtoSchema>;

/**
 * The invite just made, with its secret and the link that carries it:
 * answered once, never again.
 */
export const createdContributorInviteResponseSchema = z.object({
  invite: contributorInviteDtoSchema,
  token: z.string().min(1),
  claimUrl: z.string().min(1),
});
export type CreatedContributorInviteDto = z.infer<
  typeof createdContributorInviteResponseSchema
>;

export const contributorInviteResponseSchema = z.object({
  invite: contributorInviteDtoSchema,
});

/** A contributor's access to a version, as the workspace lists it. */
export const contributorAssignmentDtoSchema = z.object({
  id: z.string(),
  sandboxVersionId: z.string(),
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  inviteId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ContributorAssignmentDto = z.infer<
  typeof contributorAssignmentDtoSchema
>;

export const contributorAssignmentResponseSchema = z.object({
  contributor: contributorAssignmentDtoSchema,
});

/** `GET /orgs/:orgId/sandboxes/versions/:vid/contributors`. */
export const contributorListResponseSchema = z.object({
  invites: z.array(contributorInviteDtoSchema),
  contributors: z.array(contributorAssignmentDtoSchema),
});
export type ContributorListDto = z.infer<typeof contributorListResponseSchema>;

/** `POST /invites/claim`: the secret, in the body, never a path. */
export const claimInviteSchema = z.strictObject({
  token: z.string().min(1).max(200),
});

/**
 * A version a contributor may work on, in its public names only: what its
 * project's `sandbox-task.json` says (null when it cannot be read), and the
 * folder its archive unpacks to. Never the workspace, the bounty or the
 * repository.
 */
export const contributionDtoSchema = z.object({
  assignmentId: z.string(),
  versionId: z.string(),
  version: z.number().int().positive(),
  root: z.string(),
  title: z.string().nullable(),
  specSummary: z.string().nullable(),
  complexity: z.string().nullable(),
  tags: z.array(z.string()),
  /** The project's commands, from its descriptor; null when unread. */
  commands: z
    .object({
      install: z.string(),
      build: z.string(),
      test: z.string(),
      dev: z.string(),
    })
    .nullable()
    .default(null),
  /** The files a submission may change, from its descriptor. */
  editablePaths: z.array(z.string()).default([]),
  /** The Node versions it runs on (`>=22.12.0`); null when unread. */
  nodeRange: z.string().nullable().default(null),
  /** Whether it takes submissions now: published, current and unexpired. */
  open: z.boolean(),
  /** When its publication lapses; null when it is not published. */
  closesAt: z.iso.datetime().nullable(),
  joinedAt: z.iso.datetime(),
});
export type ContributionDto = z.infer<typeof contributionDtoSchema>;

export const contributionListSchema = z.object({
  contributions: z.array(contributionDtoSchema),
});
export const contributionResponseSchema = z.object({
  contribution: contributionDtoSchema,
});

/**
 * A contributor's own submission and its verdict: counts, duediligence's
 * verdict, scenario keys. Not its run, carry-back or merge-back, which are
 * the workspace's, and never a hidden test.
 */
export const contributionSubmissionDtoSchema = submissionDtoSchema
  .pick({
    id: true,
    sandboxVersionId: true,
    status: true,
    errorCode: true,
    verdict: true,
    public: true,
    hidden: true,
    failedScenarios: true,
    refused: true,
    retryOf: true,
    createdAt: true,
    updatedAt: true,
  })
  .strict();
export type ContributionSubmissionDto = z.infer<
  typeof contributionSubmissionDtoSchema
>;

export const contributionSubmissionResponseSchema = z.object({
  submission: contributionSubmissionDtoSchema,
});
export const contributionSubmissionListSchema = z.object({
  submissions: z.array(contributionSubmissionDtoSchema),
});
