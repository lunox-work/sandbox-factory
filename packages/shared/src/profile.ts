/**
 * A proposal's complexity profile on the wire: the evidence its price will
 * point back to, measured from the code graph of the bounty's repository.
 * `GET /api/v1/orgs/:orgId/proposals/:id/profile`.
 */

import {
  ANALYSIS_ERROR_CODES,
  COMPLEXITY_PROFILE_VERSION,
  PROFILE_ERROR_CODES,
  PROFILE_STATUSES,
  SCENARIO_KINDS,
} from "sandbox-factory";
import { z } from "zod";

const count = z.number().int().nonnegative();

export const complexityProfileSchema = z.object({
  version: z.literal(COMPLEXITY_PROFILE_VERSION),
  slice: z.object({
    files: count,
    bytes: count,
    modules: z.array(z.string()),
    stubCoverage: z.enum(["full", "partial", "names-only"]),
    blockers: count,
    ready: z.boolean(),
  }),
  touchedModules: z.array(z.string()),
  externals: z.object({
    services: z.array(z.string()),
    environment: count,
    seams: count,
  }),
  spec: z.object({
    scenarios: count,
    kinds: z.record(z.enum(SCENARIO_KINDS), count),
    openQuestions: count,
    assumptions: count,
  }),
  tests: z.object({
    files: count,
    untestedModules: z.array(z.string()),
  }),
  pattern: z.object({ path: z.string(), reason: z.string() }).nullable(),
  nonFunctional: z.object({
    scenarios: count,
    migrations: z.boolean(),
    ci: z.boolean(),
  }),
  risks: z.array(z.string()),
});

export const profileStatusSchema = z.enum(PROFILE_STATUSES);

/** One spec revision's profile, and the runs it was measured from. */
export const bountyProfileDtoSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  specRevision: z.number().int().positive(),
  status: profileStatusSchema,
  errorCode: z.enum(PROFILE_ERROR_CODES).nullable(),
  /** The failed run's own code, when a run is what failed. */
  runErrorCode: z.enum(ANALYSIS_ERROR_CODES).nullable(),
  snapshotId: z.string().nullable(),
  scopeRunId: z.string().nullable(),
  sliceRunId: z.string().nullable(),
  profile: complexityProfileSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Null when the proposal was never profiled: no linked repository. */
export const proposalProfileResponseSchema = z.object({
  profile: bountyProfileDtoSchema.nullable(),
});

export type ComplexityProfileDto = z.infer<typeof complexityProfileSchema>;
export type BountyProfileDto = z.infer<typeof bountyProfileDtoSchema>;
export type ProposalProfileResponse = z.infer<
  typeof proposalProfileResponseSchema
>;
