import {
  BOUNTY_COMPLEXITIES,
  BOUNTY_RUN_KINDS,
  maximumRateCardMinor,
  MODEL_BOUNTY_COMPLEXITIES,
  PRICED_BOUNTY_COMPLEXITIES,
  SCENARIO_WEIGHTS,
  STEP_SETTING_LIMITS,
  WHOLE_BOUNTY_COMPLEXITIES,
} from "sandbox-factory";
import { z } from "zod";

import {
  respecRequestSchema,
  scenarioKindSchema,
  scenarioWeightSchema,
} from "./spec.js";

/** Any size a proposal can hold, half sizes included, or `unsized`. */
export const bountyComplexitySchema = z.enum(BOUNTY_COMPLEXITIES);
/** Any size a proposal can be priced at, half sizes included. */
export const pricedComplexitySchema = z.enum(PRICED_BOUNTY_COMPLEXITIES);
/**
 * The five sizes a person or the model judges in. The model never answers
 * a half size and a resize never sets one: a half size is only ever where
 * the scenario step lands.
 */
export const wholeComplexitySchema = z.enum(WHOLE_BOUNTY_COMPLEXITIES);
/** What the sizing model may answer: a whole size, or `unsized`. */
export const modelComplexitySchema = z.enum(MODEL_BOUNTY_COMPLEXITIES);
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
    xsMinor: minorAmountSchema,
    sMinor: minorAmountSchema,
    mMinor: minorAmountSchema,
    lMinor: minorAmountSchema,
    xlMinor: minorAmountSchema,
  })
  .refine(
    ({ xsMinor, sMinor, mMinor, lMinor, xlMinor }) =>
      xsMinor <= sMinor &&
      sMinor <= mMinor &&
      mMinor <= lMinor &&
      lMinor <= xlMinor,
    { message: "Rates must increase from XS through XL." },
  );

export const rateCardSnapshotSchema = rateCardValuesSchema.extend({
  revision: z.number().int().positive(),
});

export const rateCardDtoSchema = rateCardSnapshotSchema.extend({
  organizationId: z.string().min(1),
  updatedAt: z.iso.datetime(),
});

export const putRateCardSchema = rateCardValuesSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
  })
  .refine(
    ({ currency, xlMinor }) => xlMinor <= maximumRateCardMinor(currency),
    {
      path: ["xlMinor"],
      message: "XL cannot exceed USD 1,000.",
    },
  );

export const sizingResultSchema = z
  .object({
    complexity: modelComplexitySchema,
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

/** What a run does: core's `BOUNTY_RUN_KINDS`. */
export const bountyRunKindSchema = z.enum(BOUNTY_RUN_KINDS);
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
  /** Jira's key for a board's ticket; null for a bounty written here. */
  issueKey: z.string().min(1).nullable(),
  /** The bounty the outcome is about, once the run had one. */
  bountyId: z.string().min(1).optional(),
  /** On outcomes recorded before bounties existed: the Jira pointer. */
  jiraIssueId: z.string().min(1).optional(),
  proposalId: z.string().min(1).optional(),
  status: bountyOutcomeStatusSchema,
  code: z.string().min(1).max(80).optional(),
  actualModel: z.string().min(1).max(200).optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  /**
   * A respec's only: the size before the change, and the points the change
   * moved the spec by, negative for a trim. The size after is the
   * proposal's.
   */
  previousComplexity: bountyComplexitySchema.optional(),
  pointsDelta: z.number().int().optional(),
});

/** Why a backlog run picked a bounty: one category it fits, and the case. */
export const bountyCategoryMatchSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  reason: z.string().min(1),
});

/**
 * A board's proposals by category: what the category view above the list
 * is drawn from. Every category in the registry is present, in registry
 * order, with a zero when nothing on the board fits it. A bounty picked for
 * two categories counts in both, so the counts can sum past `total`.
 */
export const proposalCategoriesDtoSchema = z.object({
  /** Every proposal on the board, categorised or not. */
  total: z.number().int().nonnegative(),
  /**
   * The proposals in no category at all: a bounty somebody picked by hand,
   * or one sized before there were categories.
   */
  uncategorized: z.number().int().nonnegative(),
  categories: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      /** Why a bounty like this is worth outsourcing. */
      why: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
});

export const bountyRunPlannedIssueSchema = z.object({
  /** Jira's issue id for a board's ticket; the bounty's id for one written here. */
  externalIssueId: z.string().min(1),
  /** Jira's key for a board's ticket; null for a bounty written here. */
  issueKey: z.string().min(1).nullable(),
  summary: z.string(),
  /** The bounty, when it was known as the plan was written. */
  bountyId: z.string().min(1).optional(),
  /** Absent on plans recorded before categories existed. */
  categories: z.array(bountyCategoryMatchSchema).optional(),
});

export const bountyRunDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  /**
   * The Jira board the run read, or null for a run that started from a
   * bounty with none: one written here, or one whose board has gone.
   */
  boardId: z.string().min(1).nullable(),
  /** The one bounty a `bounty`, `reprice` or `respec` run is about. */
  bountyId: z.string().min(1).nullable(),
  kind: bountyRunKindSchema,
  sourceProposalId: z.string().nullable(),
  sourceRevision: z.number().int().positive().nullable(),
  /** What a `respec` run was asked to do; null for every other kind. */
  respec: respecRequestSchema.nullable(),
  requestId: z.uuid(),
  status: bountyRunStatusSchema,
  selection: z.record(z.string(), z.unknown()),
  rateCard: rateCardSnapshotSchema,
  requestedModel: z.string().min(1),
  promptVersion: z.string().min(1),
  planned: z.array(bountyRunPlannedIssueSchema),
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

/** Size one bounty someone picked, by Jira's numeric issue id. */
export const addIssueSchema = z.object({
  requestId: z.uuid(),
  issueId: z.string().regex(/^\d{1,18}$/),
});

const stepPointsSchema = z
  .number()
  .int()
  .min(STEP_SETTING_LIMITS.minWeightPoints)
  .max(STEP_SETTING_LIMITS.maxPoints);

/** The settings a step was computed with: `pricing/step` in core. */
export const stepSettingsSchema = z.object({
  pointsPerStep: z
    .number()
    .int()
    .min(STEP_SETTING_LIMITS.minPointsPerStep)
    .max(STEP_SETTING_LIMITS.maxPoints),
  weightPoints: z.object(
    Object.fromEntries(
      SCENARIO_WEIGHTS.map((weight) => [weight, stepPointsSchema]),
    ) as Record<(typeof SCENARIO_WEIGHTS)[number], typeof stepPointsSchema>,
  ),
});

/** A scenario one revision of the spec has and the other did not. */
const stepScenarioSchema = z.object({
  id: z.string().min(1),
  kind: scenarioKindSchema,
  title: z.string().min(1),
  weight: scenarioWeightSchema,
});

/**
 * How the weight a reviewer added to the spec moved the size: the base,
 * the half steps it climbed and the scenarios behind them. Stored on the
 * proposal as computed, so it reads the same after the settings change.
 */
export const stepResultSchema = z.object({
  base: wholeComplexitySchema,
  complexity: pricedComplexitySchema,
  steps: z.number().int().nonnegative(),
  addedPoints: z.number().int().nonnegative(),
  added: z.array(stepScenarioSchema),
  /** Absent on a step stored before removals were listed. */
  removed: z.array(stepScenarioSchema).optional(),
  nextStepIn: z.number().int().positive().nullable(),
  settings: stepSettingsSchema,
  stepVersion: z.string().min(1),
});

export const bountyProposalStatusSchema = z.enum(["proposed", "approved"]);
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
  /** The bounty the proposal prices. */
  bountyId: z.string().min(1),
  /** The bounty's Jira issue key while it has one; null for one written here. */
  issueKey: z.string().min(1).nullable(),
  /** The bounty's title as the platform holds it. */
  title: z.string(),
  specHash: z.string().length(64),
  specHashVersion: z.number().int().positive(),
  rateCard: rateCardSnapshotSchema,
  modelComplexity: modelComplexitySchema,
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
  /** Moved by every write, and what a change is checked against. */
  revision: z.number().int().positive(),
  /**
   * The version people see: how many times what it says has been
   * approved, moved only by an approval of something changed since the
   * last. 0 until it is first approved.
   */
  version: z.number().int().nonnegative().default(0),
  /** When the current version was approved; null before the first. */
  versionedAt: z.iso.datetime().nullable().default(null),
  /**
   * The spec revision this size goes with. Null when the proposal has no
   * spec: one sized before specs existed, or one whose bounty could not be
   * drafted from.
   */
  specRevision: z.number().int().positive().nullable(),
  /**
   * The repository snapshot whose outline the spec was drafted beside, or
   * null when the bounty had no repository, its repository had no snapshot
   * yet, or the snapshot has since been pruned.
   */
  repoSnapshotId: z.string().nullable().default(null),
  /**
   * The scenario step `complexity` came from. Null when there is none to
   * take: an unsized bounty, a proposal with no spec, or one whose spec was
   * drafted before weights. Then `complexity` is the base itself.
   */
  step: stepResultSchema.nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decidedBy: z.string().nullable(),
  decisionDeliveryPolicy: z.enum(["off", "requested"]).nullable(),
  freshness: proposalFreshnessSchema.optional(),
  liveTitle: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const proposalMutationSchema = z.object({
  expectedRevision: z.number().int().positive(),
});
/**
 * A reviewer's size. Whole sizes only: it sets the base, and the step
 * still applies on top, so a reviewer who says M on a spec that grew a
 * heavy scenario gets M+.
 */
export const resizeProposalSchema = proposalMutationSchema.extend({
  complexity: wholeComplexitySchema,
});
export const repriceProposalSchema = proposalMutationSchema.extend({
  requestId: z.uuid(),
});
/**
 * A change to a proposal's spec: grow it, answer its questions or trim
 * it. Like a re-price it starts a run, named by `requestId`, against the
 * proposal revision the reviewer saw.
 */
export const respecProposalSchema = repriceProposalSchema.extend({
  request: respecRequestSchema,
});

export const proposalFreshnessDtoSchema = z.object({
  freshness: proposalFreshnessSchema,
  checkedAt: z.iso.datetime(),
  code: z.string().optional(),
  liveTitle: z.string().optional(),
  liveKey: z.string().optional(),
  liveUrl: z.url().optional(),
});

/**
 * What the bounty says now, for comparing with what was priced: read from
 * Jira for a bounty that has an issue there, and the bounty as stored
 * otherwise, which has no `url`.
 */
export const proposalLiveSpecSchema = z.object({
  summary: z.string(),
  descriptionText: z.string(),
  /** The Jira issue's key; null for a bounty written here. */
  key: z.string().nullable(),
  url: z.url().nullable(),
  inputTruncated: z.boolean(),
});

export const bountyWritebackDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  proposalId: z.string().min(1),
  proposalRevision: z.number().int().positive(),
  kind: z.enum(["approved", "withdrawn"]),
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
export type StepSettingsDto = z.infer<typeof stepSettingsSchema>;
export type StepResultDto = z.infer<typeof stepResultSchema>;
export type BountyRunOutcome = z.infer<typeof bountyRunOutcomeSchema>;
export type BountyCategoryMatch = z.infer<typeof bountyCategoryMatchSchema>;
export type ProposalCategoriesDto = z.infer<typeof proposalCategoriesDtoSchema>;
export type BountyRunPlannedIssue = z.infer<typeof bountyRunPlannedIssueSchema>;
export type BountyRunDto = z.infer<typeof bountyRunDtoSchema>;
export type BountyProposalDto = z.infer<typeof bountyProposalDtoSchema>;
export type ProposalFreshnessDto = z.infer<typeof proposalFreshnessDtoSchema>;
export type ProposalLiveSpecDto = z.infer<typeof proposalLiveSpecSchema>;
export type BountyWritebackDto = z.infer<typeof bountyWritebackDtoSchema>;
