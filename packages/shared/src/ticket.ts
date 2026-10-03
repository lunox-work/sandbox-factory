/**
 * Tickets on the wire: the organization's own record of a piece of work,
 * written here or imported from Jira, and what a proposal is made from.
 * `/api/v1/orgs/:orgId/tickets`.
 */

import {
  DEFAULT_ISSUE_TYPE,
  TICKET_LIMITS,
  TICKET_ORIGINS,
  ticketSpecHash,
} from "sandbox-factory";
import { z } from "zod";

import {
  bountyComplexitySchema,
  bountyProposalStatusSchema,
} from "./bounty.js";

/**
 * The fingerprint a proposal is priced against, re-exported so
 * `packages/jira` hashes what it reads with the one definition.
 */
export { ticketSpecHash };

export const ticketOriginSchema = z.enum(TICKET_ORIGINS);

/**
 * A ticket's Jira issue, while it has one. The ticket's text follows the
 * issue each time a run reads it; `removedAt` says Jira stopped returning
 * it, and from then on the ticket keeps the text it last had.
 */
export const ticketJiraLinkSchema = z.object({
  /** The platform's pointer to the issue. */
  issueId: z.string().min(1),
  boardId: z.string().min(1),
  connectionId: z.string().min(1),
  key: z.string().min(1),
  /** The issue in Jira, or null when the site is not known. */
  url: z.url().nullable(),
  removedAt: z.iso.datetime().nullable(),
});

/** The ticket's live proposal, in brief: enough for a list to show. */
export const ticketProposalSummarySchema = z.object({
  id: z.string().min(1),
  status: bountyProposalStatusSchema,
  complexity: bountyComplexitySchema,
  amountMinor: z.number().int().positive().nullable(),
  currency: z.string().length(3).nullable(),
});

/** A ticket as a list shows it: everything but its longer text. */
export const ticketSummaryDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  /** The organization's own count, which `key` falls back to. */
  number: z.number().int().positive(),
  /** Its Jira key while it has one, `T-<number>` otherwise. */
  key: z.string().min(1),
  title: z.string().min(1),
  issueType: z.string().min(1),
  priority: z.string().nullable(),
  labels: z.array(z.string()),
  origin: ticketOriginSchema,
  /**
   * The repository the ticket is about, when one was named for it. A Jira
   * ticket with none is drafted beside its board's repository instead.
   */
  repoId: z.string().nullable(),
  revision: z.number().int().positive(),
  jira: ticketJiraLinkSchema.nullable(),
  proposal: ticketProposalSummarySchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const ticketDtoSchema = ticketSummaryDtoSchema.extend({
  description: z.string(),
  components: z.array(z.string()),
  /** True when Jira's description was longer than a ticket keeps. */
  inputTruncated: z.boolean(),
  createdBy: z.string().nullable(),
});

export const ticketListResponseSchema = z.object({
  tickets: z.array(ticketSummaryDtoSchema),
  nextCursor: z.string().nullable(),
});

export const ticketResponseSchema = z.object({ ticket: ticketDtoSchema });

const titleSchema = z.string().trim().min(1).max(TICKET_LIMITS.title);
const descriptionSchema = z.string().max(TICKET_LIMITS.description);
const issueTypeSchema = z.string().trim().min(1).max(TICKET_LIMITS.issueType);
const prioritySchema = z
  .string()
  .trim()
  .min(1)
  .max(TICKET_LIMITS.priority)
  .nullable();
/** Trimmed, and each kept once in the order first given. */
const labelsSchema = z
  .array(z.string().trim().min(1).max(TICKET_LIMITS.label))
  .max(TICKET_LIMITS.labels)
  .transform((labels) => [...new Set(labels)]);
const repoIdSchema = z.string().min(1).nullable();

/** A ticket written here. Only the title is required. */
export const createTicketSchema = z.strictObject({
  title: titleSchema,
  description: descriptionSchema.default(""),
  issueType: issueTypeSchema.default(DEFAULT_ISSUE_TYPE),
  priority: prioritySchema.default(null),
  labels: labelsSchema.default([]),
  repoId: repoIdSchema.default(null),
});

/**
 * A change to a ticket, against the revision the editor saw. A Jira
 * ticket's text is Jira's to change, so only its repository may be set
 * here; the route refuses the rest.
 */
export const updateTicketSchema = z
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

/** Size one ticket and propose a bounty for it, named by `requestId`. */
export const proposeTicketSchema = z.object({ requestId: z.uuid() });

export type TicketOriginDto = z.infer<typeof ticketOriginSchema>;
export type TicketJiraLinkDto = z.infer<typeof ticketJiraLinkSchema>;
export type TicketProposalSummaryDto = z.infer<
  typeof ticketProposalSummarySchema
>;
export type TicketSummaryDto = z.infer<typeof ticketSummaryDtoSchema>;
export type TicketDto = z.infer<typeof ticketDtoSchema>;
export type TicketListResponse = z.infer<typeof ticketListResponseSchema>;
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
