/** API success envelopes consumed by platform-neutral feature clients. */
import { z } from "zod";
import {
  bountyRunDtoSchema,
  rateCardDtoSchema,
  bountyProposalDtoSchema,
  bountyCategoryMatchSchema,
  bountyWritebackDtoSchema,
  proposalLiveSpecSchema,
  proposalFreshnessDtoSchema,
} from "./pricing.js";
import {
  githubConnectionDtoSchema,
  githubRepoDtoSchema,
  githubGrantDtoSchema,
  githubAvailableInstallationDtoSchema,
  githubInstallationRepositoryDtoSchema,
} from "./github.js";
import {
  jiraBoardSummarySchema,
  jiraIssueDtoSchema,
  jiraIssueDetailDtoSchema,
} from "./jira.js";

export const jiraConnectionDtoSchema = z.object({
  id: z.string(),
  cloudId: z.string(),
  siteUrl: z.string(),
  siteName: z.string(),
  email: z.string().nullable(),
  healthy: z.boolean(),
  scopes: z.array(z.string()),
  resourceScopes: z.array(z.string()).default([]),
  writeGranted: z.boolean().default(false),
  createdAt: z.string(),
});
export const jiraConnectionListSchema = z.object({
  connections: z.array(jiraConnectionDtoSchema),
});
export const jiraBoardListSchema = z.object({
  boards: z.array(jiraBoardSummarySchema),
});
export const githubConnectionListSchema = z.object({
  connections: z.array(githubConnectionDtoSchema),
});
export const githubRepoListSchema = z.object({
  repositories: z.array(githubRepoDtoSchema),
});
export const rateCardResponseSchema = z.object({
  rateCard: rateCardDtoSchema.nullable(),
});
export const bountyRunResponseSchema = z.object({ run: bountyRunDtoSchema });
export const bountyRunListResponseSchema = z.object({
  runs: z.array(bountyRunDtoSchema),
  /** The page after this one, `createdAt|id`; null on the last. */
  nextCursor: z.string().nullable().default(null),
  sizingAvailable: z.boolean(),
});
export const listedProposalSchema = bountyProposalDtoSchema.extend({
  boardId: z.string().nullable().optional(),
  categories: z.array(bountyCategoryMatchSchema).default([]),
});
export const proposalListResponseSchema = z.object({
  proposals: z.array(listedProposalSchema),
  nextCursor: z.string().nullable(),
});
export const accountResponseSchema = z.object({
  user: z.object({ id: z.string(), username: z.string().nullable() }),
});
export const provenEmailListSchema = z.object({
  emails: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      providers: z.array(z.string()),
      isPrimary: z.boolean(),
    }),
  ),
});

export const proposalDetailResponseSchema = z.object({
  proposal: bountyProposalDtoSchema,
  freshness: proposalFreshnessDtoSchema,
  liveSpec: proposalLiveSpecSchema.nullable().optional(),
  writebackOperations: z.array(bountyWritebackDtoSchema).default([]),
  /**
   * The re-price or spec change rewriting the proposal now, or null when
   * none is: what its page follows to the end, from a reload as from the
   * click that started it.
   */
  activeRun: bountyRunDtoSchema.nullable().default(null),
});

/** A bounty's first sizing while it is in flight, or null when none is. */
export const bountySizingResponseSchema = z.object({
  run: bountyRunDtoSchema.nullable(),
});

export const proposalActionResponseSchema = z.object({
  proposal: bountyProposalDtoSchema.optional(),
  run: bountyRunDtoSchema.optional(),
  proposalId: z.string().optional(),
});
export const jiraIssueSearchSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      summary: z.string(),
      status: z.string(),
      issueType: z.string(),
      subtaskCount: z.number().int().nonnegative().optional(),
    }),
  ),
});

/**
 * The workspace's Jira issues that match a search, from every board it has:
 * each with the board it was found on, and the bounty it already is, if any.
 */
export const jiraWorkspaceIssueSearchSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      summary: z.string(),
      status: z.string(),
      issueType: z.string(),
      boardId: z.string(),
      boardName: z.string(),
      bountyId: z.string().nullable(),
    }),
  ),
});

export const githubAvailableInstallationsSchema = z.object({
  grant: githubGrantDtoSchema,
  installations: z.array(githubAvailableInstallationDtoSchema),
});
export const githubInstallationRepositoriesSchema = z.object({
  repositories: z.array(githubInstallationRepositoryDtoSchema),
});
export const githubConnectionResponseSchema = z.object({
  connection: githubConnectionDtoSchema,
});
export const githubRepoResponseSchema = z.object({
  repository: githubRepoDtoSchema,
});

export const jiraBoardResponseDtoSchema = z.object({
  board: jiraBoardSummarySchema,
});
export const jiraSyncResponseSchema = z.object({
  boards: z.array(jiraBoardSummarySchema).optional(),
  added: z.array(z.string()).default([]),
});
export const jiraIssueDetailResponseSchema = z.object({
  issue: jiraIssueDetailDtoSchema,
});
export const jiraBacklogPreviewSchema = z.object({
  boardId: z.string(),
  jql: z.string(),
  selection: z
    .object({
      ticketCap: z.number().optional(),
      unassignedOnly: z.boolean(),
      issueTypes: z.array(z.string()),
      minAgeDays: z.number(),
      maxAgeDays: z.number().optional(),
      minSpecChars: z.number(),
    })
    .optional(),
  categories: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      why: z.string(),
      /** What the rule checks, in plain words. Absent from an older API. */
      looksFor: z.string().optional(),
      example: z.string().optional(),
      enabled: z.boolean(),
      thresholds: z.record(z.string(), z.number()),
    }),
  ),
  issues: z.array(
    jiraIssueDtoSchema.extend({
      categories: z.array(bountyCategoryMatchSchema).optional(),
    }),
  ),
  matched: z.record(z.string(), z.number()),
  unmatched: z.number(),
  candidatesScanned: z.number(),
  skippedLive: z.number(),
  scanLimitReached: z.boolean(),
  ticketCapReached: z.boolean(),
  /**
   * Nothing fit a category, so `issues` are the oldest open tickets that fit
   * none. Absent from an older API, which reads as false.
   */
  fallback: z.boolean().optional(),
});
export type JiraBacklogPreviewDto = z.infer<typeof jiraBacklogPreviewSchema>;

export const accountNameResponseSchema = z.object({ name: z.string() });
export const accountUsernameResponseSchema = z.object({ username: z.string() });
export const invitationCreatedResponseSchema = z.object({
  invitation: z.object({ id: z.string() }),
});
export const activeRunConflictSchema = z.object({
  code: z.literal("run_active"),
  runId: z.string(),
});
