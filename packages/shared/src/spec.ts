import {
  RESPEC_LIMITS,
  SCENARIO_KINDS,
  SCENARIO_ORIGINS,
  SCENARIO_WEIGHTS,
  SPEC_LIMITS,
  STEP_KEYWORDS,
  WEIGHT_REASON_CHARS,
} from "sandbox-factory";
import { z } from "zod";

/**
 * A spec as it is stored and sent: strict, so a draft that reaches the
 * database is one every reader can render. The limits are core's
 * (`SPEC_LIMITS`), the same numbers the draft tool's schema carries.
 *
 * Every string is one line. The spec renders to Gherkin, where a line break
 * inside a step would end it and start whatever the next line looked like.
 */
const oneLine = (maxChars: number) =>
  z
    .string()
    .min(1)
    .max(maxChars)
    .refine((value) => value === value.trim() && !/[\r\n]/.test(value), {
      message: "Must be one trimmed line.",
    });

export const scenarioKindSchema = z.enum(SCENARIO_KINDS);
export const stepKeywordSchema = z.enum(STEP_KEYWORDS);
export const scenarioOriginSchema = z.enum(SCENARIO_ORIGINS);
export const scenarioWeightSchema = z.enum(SCENARIO_WEIGHTS);

export const scenarioStepSchema = z.object({
  keyword: stepKeywordSchema,
  text: oneLine(SPEC_LIMITS.stepChars),
});

/** "s1" to "s999", stable within a spec revision. */
export const scenarioIdSchema = z.string().regex(/^s[1-9]\d{0,2}$/);

export const scenarioSchema = z.object({
  /** "s1", stable within a spec revision. */
  id: scenarioIdSchema,
  kind: scenarioKindSchema,
  title: oneLine(SPEC_LIMITS.titleChars),
  steps: z.array(scenarioStepSchema).min(1).max(SPEC_LIMITS.steps),
  origin: scenarioOriginSchema,
  /**
   * Optional so a spec drafted before weights (`draft-v1`) still reads.
   * Every scenario a `draft-v2` call writes has one.
   */
  weight: scenarioWeightSchema.optional(),
  weightReason: oneLine(WEIGHT_REASON_CHARS).optional(),
});

export const specDraftSchema = z
  .object({
    feature: oneLine(SPEC_LIMITS.featureChars),
    background: z
      .array(oneLine(SPEC_LIMITS.stepChars))
      .max(SPEC_LIMITS.background),
    scenarios: z.array(scenarioSchema).max(SPEC_LIMITS.scenarios),
    openQuestions: z
      .array(oneLine(SPEC_LIMITS.noteChars))
      .max(SPEC_LIMITS.openQuestions),
    assumptions: z
      .array(oneLine(SPEC_LIMITS.noteChars))
      .max(SPEC_LIMITS.assumptions),
  })
  .superRefine((draft, ctx) => {
    // A bounty too thin for a single scenario is a real answer, as long as
    // the draft says what it was missing.
    if (draft.scenarios.length === 0 && draft.openQuestions.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["scenarios"],
        message: "A spec needs a scenario or an open question.",
      });
    }
    const ids = draft.scenarios.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["scenarios"],
        message: "Scenario ids must be unique.",
      });
    }
  });

/** How a spec revision came to be. */
export const bountySpecOriginSchema = z.enum([
  "draft",
  "expand",
  "trim",
  "answer",
]);

/**
 * One revision of a proposal's spec. Private to the organization, like the
 * proposal it belongs to.
 */
export const bountySpecDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  proposalId: z.string().min(1),
  revision: z.number().int().positive(),
  /** The bounty this revision was drafted from, as the proposal hashes it. */
  specHash: z.string().length(64),
  specHashVersion: z.number().int().positive(),
  draft: specDraftSchema,
  origin: bountySpecOriginSchema,
  /** The reviewer's ask, for a revision that came from one. */
  instruction: z.string().nullable(),
  /** Null when a run drafted it rather than a person. */
  createdBy: z.string().nullable(),
  runId: z.string().nullable(),
  actualModel: z.string().nullable(),
  promptVersion: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/** A revision without its scenarios, for listing a spec's history. */
export const bountySpecRevisionDtoSchema = z.object({
  revision: z.number().int().positive(),
  origin: bountySpecOriginSchema,
  /** What the reviewer asked for, for a revision that came from a request. */
  instruction: z.string().nullable(),
  scenarioCount: z.number().int().nonnegative(),
  openQuestionCount: z.number().int().nonnegative(),
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** Whether this is the revision the proposal's size goes with. */
  current: z.boolean(),
});

/**
 * `GET /proposals/:id/spec`. `spec` is null for a proposal with none: one
 * sized before specs existed, or one whose bounty was too large or too thin
 * to draft from.
 */
export const proposalSpecResponseSchema = z.object({
  spec: bountySpecDtoSchema.nullable(),
});

export const proposalSpecRevisionsResponseSchema = z.object({
  revisions: z.array(bountySpecRevisionDtoSchema),
});

/**
 * What a reviewer may ask of a spec: core's `RespecRequest`, checked. Each
 * names what it changes in the revision it was made against; whether
 * those exist there is the route's to check (`checkRespec`).
 */
export const respecRequestSchema = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("expand"),
      kinds: z
        .array(scenarioKindSchema)
        .min(1)
        .max(SCENARIO_KINDS.length)
        .optional(),
      instruction: z
        .string()
        .trim()
        .min(1)
        .max(RESPEC_LIMITS.instructionChars)
        .optional(),
    }),
    z.object({
      mode: z.literal("answer"),
      answers: z
        .array(
          z.object({
            question: oneLine(SPEC_LIMITS.noteChars),
            answer: z.string().trim().min(1).max(RESPEC_LIMITS.answerChars),
          }),
        )
        .min(1)
        .max(SPEC_LIMITS.openQuestions),
    }),
    z.object({
      mode: z.literal("trim"),
      removeScenarioIds: z
        .array(scenarioIdSchema)
        .min(1)
        .max(SPEC_LIMITS.scenarios),
    }),
  ])
  .superRefine((request, ctx) => {
    const repeated = (values: readonly string[]) =>
      new Set(values).size !== values.length;
    if (
      request.mode === "expand" &&
      request.kinds === undefined &&
      request.instruction === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["kinds"],
        message: "An expansion needs a kind or an instruction.",
      });
    }
    if (request.mode === "expand" && repeated(request.kinds ?? [])) {
      ctx.addIssue({
        code: "custom",
        path: ["kinds"],
        message: "Each kind once.",
      });
    }
    if (
      request.mode === "answer" &&
      repeated(request.answers.map(({ question }) => question))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["answers"],
        message: "Each question once.",
      });
    }
    if (request.mode === "trim" && repeated(request.removeScenarioIds)) {
      ctx.addIssue({
        code: "custom",
        path: ["removeScenarioIds"],
        message: "Each scenario once.",
      });
    }
  });

export type ScenarioWeightDto = z.infer<typeof scenarioWeightSchema>;
export type RespecRequestDto = z.infer<typeof respecRequestSchema>;
export type ScenarioStepDto = z.infer<typeof scenarioStepSchema>;
export type ScenarioDto = z.infer<typeof scenarioSchema>;
export type SpecDraftDto = z.infer<typeof specDraftSchema>;
export type BountySpecOrigin = z.infer<typeof bountySpecOriginSchema>;
export type BountySpecDto = z.infer<typeof bountySpecDtoSchema>;
export type BountySpecRevisionDto = z.infer<typeof bountySpecRevisionDtoSchema>;
export type ProposalSpecResponse = z.infer<typeof proposalSpecResponseSchema>;
export type ProposalSpecRevisionsResponse = z.infer<
  typeof proposalSpecRevisionsResponseSchema
>;
