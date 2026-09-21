import { BOUNTY_COMPLEXITIES } from "sandbox-factory";
import { z } from "zod";

export const bountyComplexitySchema = z.enum(BOUNTY_COMPLEXITIES);
export const pricedComplexitySchema = z.enum(["S", "M", "L", "XL"]);
export const sizingConfidenceSchema = z.enum(["low", "medium", "high"]);

const minorAmountSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const rateCardValuesSchema = z
  .object({
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((value) => value.toUpperCase()),
    sMinor: minorAmountSchema,
    mMinor: minorAmountSchema,
    lMinor: minorAmountSchema,
    xlMinor: minorAmountSchema,
  })
  .refine(
    ({ sMinor, mMinor, lMinor, xlMinor }) =>
      sMinor <= mMinor && mMinor <= lMinor && lMinor <= xlMinor,
    { message: "Rates must increase from S through XL." },
  );

export const rateCardSnapshotSchema = rateCardValuesSchema.extend({
  revision: z.number().int().positive(),
});

export const rateCardDtoSchema = rateCardSnapshotSchema.extend({
  organizationId: z.string().min(1),
  updatedAt: z.iso.datetime(),
});

export const putRateCardSchema = rateCardValuesSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
});

export const sizingResultSchema = z
  .object({
    complexity: bountyComplexitySchema,
    confidence: sizingConfidenceSchema,
    rationale: z.string().trim().min(1).max(500),
    unsizedReason: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.complexity === "unsized" && value.unsizedReason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["unsizedReason"],
        message: "An unsized result requires a reason.",
      });
    }
    if (value.complexity !== "unsized" && value.unsizedReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["unsizedReason"],
        message: "A sized result cannot include an unsized reason.",
      });
    }
  });

export const bountyRunKindSchema = z.enum(["backlog", "reprice"]);
export const bountyRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
]);
export const bountyOutcomeStatusSchema = z.enum([
  "proposed",
  "unsized",
  "failed",
  "skipped",
]);

export const bountyRunOutcomeSchema = z.object({
  externalIssueId: z.string().min(1),
  issueKey: z.string().min(1),
  jiraIssueId: z.string().min(1).optional(),
  proposalId: z.string().min(1).optional(),
  status: bountyOutcomeStatusSchema,
  code: z.string().min(1).max(80).optional(),
  actualModel: z.string().min(1).max(200).optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

export const bountyRunDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  boardId: z.string().min(1),
  kind: bountyRunKindSchema,
  sourceProposalId: z.string().nullable(),
  sourceRevision: z.number().int().positive().nullable(),
  requestId: z.uuid(),
  status: bountyRunStatusSchema,
  selection: z.record(z.string(), z.unknown()),
  rateCard: rateCardSnapshotSchema,
  requestedModel: z.string().min(1),
  promptVersion: z.string().min(1),
  outcomes: z.array(bountyRunOutcomeSchema),
  candidatesScanned: z.number().int().nonnegative(),
  skippedLive: z.number().int().nonnegative(),
  scanLimitReached: z.boolean(),
  fatalErrorCode: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  deadlineAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const createRunSchema = z.object({ requestId: z.uuid() });

export const bountyProposalStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "superseded",
]);
export const proposalFreshnessSchema = z.enum([
  "current",
  "stale",
  "missing",
  "unknown",
]);

export const bountyProposalDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  runId: z.string().min(1),
  jiraIssueId: z.string().min(1),
  issueKey: z.string().min(1),
  specHash: z.string().length(64),
  specHashVersion: z.number().int().positive(),
  rateCard: rateCardSnapshotSchema,
  modelComplexity: bountyComplexitySchema,
  modelConfidence: sizingConfidenceSchema,
  modelRationale: z.string().max(500),
  unsizedReason: z.string().nullable(),
  inputTruncated: z.boolean(),
  actualModel: z.string().min(1),
  promptVersion: z.string().min(1),
  complexity: bountyComplexitySchema,
  sizedBy: z.enum(["model", "reviewer"]),
  resizedBy: z.string().nullable(),
  resizedAt: z.iso.datetime().nullable(),
  amountMinor: minorAmountSchema.nullable(),
  currency: z.string().length(3).nullable(),
  status: bountyProposalStatusSchema,
  revision: z.number().int().positive(),
  decidedAt: z.iso.datetime().nullable(),
  decidedBy: z.string().nullable(),
  decisionDeliveryPolicy: z.enum(["off", "requested"]).nullable(),
  replacesProposalId: z.string().nullable(),
  freshness: proposalFreshnessSchema.optional(),
  liveTitle: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const proposalMutationSchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export const resizeProposalSchema = proposalMutationSchema.extend({
  complexity: pricedComplexitySchema,
});
export const repriceProposalSchema = proposalMutationSchema.extend({
  requestId: z.uuid(),
});

export const proposalFreshnessDtoSchema = z.object({
  freshness: proposalFreshnessSchema,
  checkedAt: z.iso.datetime(),
  code: z.string().optional(),
  liveTitle: z.string().optional(),
  liveKey: z.string().optional(),
  liveUrl: z.url().optional(),
});

export const proposalLiveSpecSchema = z.object({
  summary: z.string(),
  descriptionText: z.string(),
  issueType: z.string(),
  key: z.string(),
  url: z.url(),
  inputTruncated: z.boolean(),
});

export const bountyWritebackDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  proposalId: z.string().min(1),
  proposalRevision: z.number().int().positive(),
  kind: z.enum(["approved", "rejected", "superseded"]),
  status: z.enum([
    "pending",
    "running",
    "done",
    "failed",
    "uncertain",
    "cancelled",
  ]),
  step: z.enum(["comment", "label"]),
  payload: z.object({
    complexity: pricedComplexitySchema,
    amountMinor: minorAmountSchema,
    currency: z.string().length(3),
    proposalUrl: z.url(),
    replacementUrl: z.url().optional(),
  }),
  jiraCommentId: z.string().nullable(),
  errorCode: z.string().nullable(),
  commentAttemptedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type RateCardValuesDto = z.infer<typeof rateCardValuesSchema>;
export type RateCardSnapshotDto = z.infer<typeof rateCardSnapshotSchema>;
export type RateCardDto = z.infer<typeof rateCardDtoSchema>;
export type SizingResult = z.infer<typeof sizingResultSchema>;
export type BountyRunOutcome = z.infer<typeof bountyRunOutcomeSchema>;
export type BountyRunDto = z.infer<typeof bountyRunDtoSchema>;
export type BountyProposalDto = z.infer<typeof bountyProposalDtoSchema>;
export type ProposalFreshnessDto = z.infer<typeof proposalFreshnessDtoSchema>;
export type ProposalLiveSpecDto = z.infer<typeof proposalLiveSpecSchema>;
export type BountyWritebackDto = z.infer<typeof bountyWritebackDtoSchema>;
