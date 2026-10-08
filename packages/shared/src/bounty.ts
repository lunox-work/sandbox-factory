/**
 * Bounties on the wire: the organization's own record of a piece of work,
 * written here or imported from Jira. A bounty is two things at least, its
 * proposal and its sandbox, and each answer carries both in brief.
 * `/api/v1/orgs/:orgId/bounties`.
 */

import {
  BOUNTY_LIMITS,
  BOUNTY_ORIGINS,
  bountySpecHash,
  SANDBOX_STATUSES,
} from "sandbox-factory";
import { z } from "zod";

import {
  bountyComplexitySchema,
  bountyProposalStatusSchema,
} from "./pricing.js";
import {
  bountyContextResponseSchema,
  contextVersionsDefault,
} from "./context.js";
import { stackDtoSchema, stackInputSchema } from "./stack.js";

/**
 * The fingerprint a proposal is priced against, and the bounds a bounty's
 * text is held to, re-exported so `packages/jira` reads Jira's text with
 * the one definition of each.
 */
export { BOUNTY_LIMITS, bountySpecHash };

export const bountyOriginSchema = z.enum(BOUNTY_ORIGINS);

/**
 * A bounty's Jira issue, while it has one. The bounty's text follows the
 * issue each time a run reads it; `removedAt` says Jira stopped returning
 * it, and from then on the bounty keeps the text it last had.
 */
export const bountyJiraLinkSchema = z.object({
  /** The platform's pointer to the issue. */
  issueId: z.string().min(1),
  boardId: z.string().min(1),
  connectionId: z.string().min(1),
  key: z.string().min(1),
  /** The issue in Jira, or null when the site is not known. */
  url: z.url().nullable(),
  removedAt: z.iso.datetime().nullable(),
});

/** The bounty's live proposal, in brief: enough for a list to show. */
export const bountyProposalSummarySchema = z.object({
  id: z.string().min(1),
  status: bountyProposalStatusSchema,
  complexity: bountyComplexitySchema,
  amountMinor: z.number().int().positive().nullable(),
  currency: z.string().length(3).nullable(),
});

/** The bounty's sandbox, in brief: absent until one is made for it. */
export const bountySandboxSummarySchema = z.object({
  id: z.string().min(1),
  status: z.enum(SANDBOX_STATUSES),
  currentVersionId: z.string().nullable(),
  /** When its publication lapses; null while it has none. */
  expiresAt: z.iso.datetime().nullable(),
  /** Null until a repository is linked; no version is cut before. */
  sourceRepoId: z.string().nullable(),
  /**
   * The version contributors get, or the latest while none is published,
   * and the bounty version it was built on: null for one built before that
   * was kept. Null while it has no version.
   */
  build: z
    .object({
      versionId: z.string().min(1),
      version: z.number().int().positive(),
      bountyVersion: z.number().int().positive().nullable(),
      /** The bounty's synced context versions it was generated with. */
      context: contextVersionsDefault,
    })
    .nullable(),
});

/** A bounty as a list shows it: everything but its longer text. */
export const bountySummaryDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  title: z.string().min(1),
  origin: bountyOriginSchema,
  /**
   * The repository the bounty is about, when one was named for it. A Jira
   * bounty with none is drafted beside its board's repository instead.
   */
  repoId: z.string().nullable(),
  /**
   * What the bounty adds to its repository's detected stack. The
   * repository's own is not repeated here: it is the repository's, follows
   * it, and is shown beside these.
   */
  stack: stackDtoSchema,
  revision: z.number().int().positive(),
  /** The overview's version: moved by each change to its title or text. */
  version: z.number().int().positive(),
  /**
   * The overview version an owner or admin approved; null until one is.
   * While it is `version`, the overview is held as it is
   * (`overviewApproved`).
   */
  approval: z
    .object({
      version: z.number().int().positive(),
      approvedBy: z.string().nullable(),
      approvedAt: z.iso.datetime(),
    })
    .nullable(),
  jira: bountyJiraLinkSchema.nullable(),
  proposal: bountyProposalSummarySchema.nullable(),
  sandbox: bountySandboxSummarySchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * A bounty's three steps, each built on the one before: the overview, the
 * bounty (its live proposal) and the sandbox, with the version each is at
 * and the version of the step before that it was built on. A step built on
 * an older version than the one before it is at is behind
 * (`stageDrift`); nothing locks one step to another.
 */
export const bountyStagesSchema = z.object({
  /**
   * The overview's version, and the latest context synced from each
   * source, which the steps after it are made with (`contextDrift`).
   */
  overview: z.object({
    version: z.number().int().positive(),
    context: contextVersionsDefault,
  }),
  /**
   * The live proposal's version, 0 until first approved, and the overview
   * version it was sized from: null when no version says what it was
   * sized from.
   */
  bounty: z
    .object({
      version: z.number().int().nonnegative(),
      overviewVersion: z.number().int().positive().nullable(),
      /** The context versions it was sized with. */
      context: contextVersionsDefault,
    })
    .nullable(),
  /** The sandbox's `build`, and the bounty version it was built on. */
  sandbox: z
    .object({
      version: z.number().int().positive(),
      bountyVersion: z.number().int().positive().nullable(),
      /** The context versions it was generated with. */
      context: contextVersionsDefault,
    })
    .nullable(),
});

export const bountyDtoSchema = bountySummaryDtoSchema.extend({
  description: z.string(),
  components: z.array(z.string()),
  /** True when Jira's description was longer than a bounty keeps. */
  inputTruncated: z.boolean(),
  createdBy: z.string().nullable(),
  stages: bountyStagesSchema,
});

/** One version of a bounty's overview: its text from then until the next. */
export const bountyVersionDtoSchema = z.object({
  version: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  /** Who wrote it; null for Jira's text, or a person since removed. */
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const bountyVersionListSchema = z.object({
  versions: z.array(bountyVersionDtoSchema),
});

export const bountyListResponseSchema = z.object({
  bounties: z.array(bountySummaryDtoSchema),
  nextCursor: z.string().nullable(),
});

export const bountyResponseSchema = z.object({ bounty: bountyDtoSchema });

/**
 * A sync's answer: the bounty as it now is (a Jira sync takes the issue's
 * text too), where each source stands, and whether the sync made a new
 * version of the source's context.
 */
export const syncBountyContextResponseSchema = z.object({
  bounty: bountyDtoSchema,
  context: bountyContextResponseSchema,
  changed: z.boolean(),
});

const titleSchema = z.string().trim().min(1).max(BOUNTY_LIMITS.title);
const descriptionSchema = z.string().max(BOUNTY_LIMITS.description);
const repoIdSchema = z.string().min(1).nullable();

/** A bounty written here. Only the title is required. */
export const createBountySchema = z.strictObject({
  title: titleSchema,
  description: descriptionSchema.default(""),
  repoId: repoIdSchema.default(null),
  stack: stackInputSchema.default([]),
});

/**
 * A change to a bounty, against the revision the editor saw. A Jira
 * bounty's text is Jira's to change, so only its repository and stack may
 * be set here; the route refuses the rest.
 */
export const updateBountySchema = z
  .strictObject({
    expectedRevision: z.number().int().positive(),
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    repoId: repoIdSchema.optional(),
    stack: stackInputSchema.optional(),
  })
  .refine(
    ({ expectedRevision: _revision, ...change }) =>
      Object.values(change).some((value) => value !== undefined),
    "Nothing to change.",
  );

/**
 * Links a bounty to a Jira issue picked for it: one of the workspace's
 * boards, and the issue by Jira's id. The bounty follows the issue from then
 * on, so its text becomes Jira's.
 */
export const linkBountyJiraSchema = z.strictObject({
  boardId: z.string().min(1),
  issueId: z.string().min(1),
});

/** Approves the overview, or takes that back, against the revision seen. */
export const decideBountySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});

/** Size one bounty and make its proposal, named by `requestId`. */
export const proposeBountySchema = z.object({ requestId: z.uuid() });

export type BountyOriginDto = z.infer<typeof bountyOriginSchema>;
export type BountyJiraLinkDto = z.infer<typeof bountyJiraLinkSchema>;
export type BountyProposalSummaryDto = z.infer<
  typeof bountyProposalSummarySchema
>;
export type BountySandboxSummaryDto = z.infer<
  typeof bountySandboxSummarySchema
>;
export type BountySummaryDto = z.infer<typeof bountySummaryDtoSchema>;
export type BountyDto = z.infer<typeof bountyDtoSchema>;
export type BountyStagesDto = z.infer<typeof bountyStagesSchema>;
export type BountyVersionDto = z.infer<typeof bountyVersionDtoSchema>;
export type BountyVersionList = z.infer<typeof bountyVersionListSchema>;
export type BountyListResponse = z.infer<typeof bountyListResponseSchema>;
export type SyncBountyContextResponse = z.infer<
  typeof syncBountyContextResponseSchema
>;
export type CreateBountyInput = z.infer<typeof createBountySchema>;
export type UpdateBountyInput = z.infer<typeof updateBountySchema>;
export type LinkBountyJiraInput = z.infer<typeof linkBountyJiraSchema>;
