/**
 * Bounties on the wire: the organization's own record of a piece of work,
 * written here or imported from Jira. A bounty is two things at least, its
 * proposal and its sandbox, and each answer carries both in brief.
 * `/api/v1/orgs/:orgId/bounties`.
 */

import {
  DEFAULT_ISSUE_TYPE,
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

/**
 * The fingerprint a proposal is priced against, and the bounds and default
 * a bounty's text is held to, re-exported so `packages/jira` reads Jira's
 * text with the one definition of each.
 */
export { DEFAULT_ISSUE_TYPE, BOUNTY_LIMITS, bountySpecHash };

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
  /** Null until a repository is linked; no version is cut before. */
  sourceRepoId: z.string().nullable(),
});

/** A bounty as a list shows it: everything but its longer text. */
export const bountySummaryDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  /** The organization's own count, which `key` falls back to. */
  number: z.number().int().positive(),
  /** Its Jira key while it has one, `B-<number>` otherwise. */
  key: z.string().min(1),
  title: z.string().min(1),
  issueType: z.string().min(1),
  priority: z.string().nullable(),
  labels: z.array(z.string()),
  origin: bountyOriginSchema,
  /**
   * The repository the bounty is about, when one was named for it. A Jira
   * bounty with none is drafted beside its board's repository instead.
   */
  repoId: z.string().nullable(),
  revision: z.number().int().positive(),
  jira: bountyJiraLinkSchema.nullable(),
  proposal: bountyProposalSummarySchema.nullable(),
  sandbox: bountySandboxSummarySchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const bountyDtoSchema = bountySummaryDtoSchema.extend({
  description: z.string(),
  components: z.array(z.string()),
  /** True when Jira's description was longer than a bounty keeps. */
  inputTruncated: z.boolean(),
  createdBy: z.string().nullable(),
});

export const bountyListResponseSchema = z.object({
  bounties: z.array(bountySummaryDtoSchema),
  nextCursor: z.string().nullable(),
});

export const bountyResponseSchema = z.object({ bounty: bountyDtoSchema });

const titleSchema = z.string().trim().min(1).max(BOUNTY_LIMITS.title);
const descriptionSchema = z.string().max(BOUNTY_LIMITS.description);
const issueTypeSchema = z.string().trim().min(1).max(BOUNTY_LIMITS.issueType);
const prioritySchema = z
  .string()
  .trim()
  .min(1)
  .max(BOUNTY_LIMITS.priority)
  .nullable();
/** Trimmed, and each kept once in the order first given. */
const labelsSchema = z
  .array(z.string().trim().min(1).max(BOUNTY_LIMITS.label))
  .max(BOUNTY_LIMITS.labels)
  .transform((labels) => [...new Set(labels)]);
const repoIdSchema = z.string().min(1).nullable();

/** A bounty written here. Only the title is required. */
export const createBountySchema = z.strictObject({
  title: titleSchema,
  description: descriptionSchema.default(""),
  issueType: issueTypeSchema.default(DEFAULT_ISSUE_TYPE),
  priority: prioritySchema.default(null),
  labels: labelsSchema.default([]),
  repoId: repoIdSchema.default(null),
});

/**
 * A change to a bounty, against the revision the editor saw. A Jira
 * bounty's text is Jira's to change, so only its repository may be set
 * here; the route refuses the rest.
 */
export const updateBountySchema = z
  .strictObject({
    expectedRevision: z.number().int().positive(),
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    issueType: issueTypeSchema.optional(),
    priority: prioritySchema.optional(),
    labels: labelsSchema.optional(),
    repoId: repoIdSchema.optional(),
  })
  .refine(
    ({ expectedRevision: _revision, ...change }) =>
      Object.values(change).some((value) => value !== undefined),
    "Nothing to change.",
  );

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
export type BountyListResponse = z.infer<typeof bountyListResponseSchema>;
export type CreateBountyInput = z.infer<typeof createBountySchema>;
export type UpdateBountyInput = z.infer<typeof updateBountySchema>;
