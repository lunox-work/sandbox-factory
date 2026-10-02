import {
  ANALYSIS_STATUSES,
  ANALYSIS_ERROR_CODES,
  ARTIFACT_KINDS,
} from "sandbox-factory";
import { z } from "zod";

export const analysisParamsSchema = z.strictObject({
  deadlineMinutes: z.number().int().min(1).max(120).default(30),
});
export const enqueueAnalysisSchema = z.strictObject({
  tool: z.literal("graphify"),
  snapshotId: z.string().min(1).optional(),
  params: analysisParamsSchema.default({ deadlineMinutes: 30 }),
});
export const analysisRunDtoSchema = z.strictObject({
  id: z.string(),
  snapshotId: z.string(),
  repoId: z.string(),
  tool: z.literal("graphify"),
  toolVersion: z.string(),
  params: analysisParamsSchema,
  status: z.enum(ANALYSIS_STATUSES),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().nonnegative(),
  errorCode: z.enum(ANALYSIS_ERROR_CODES).nullable(),
  errorDetail: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  deadlineAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export const analysisRunListSchema = z.object({
  runs: z.array(analysisRunDtoSchema),
});
export const analysisRunResponseSchema = z.object({
  run: analysisRunDtoSchema,
});
export const artifactDtoSchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  path: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  meta: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});
export const artifactListSchema = z.object({
  artifacts: z.array(artifactDtoSchema),
});
export const artifactUrlSchema = z.object({ url: z.url() });
export type AnalysisRunDto = z.infer<typeof analysisRunDtoSchema>;
export type ArtifactDto = z.infer<typeof artifactDtoSchema>;
export type EnqueueAnalysisInput = z.input<typeof enqueueAnalysisSchema>;
