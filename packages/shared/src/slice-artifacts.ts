import { z } from "zod";
import {
  SLICE_MANIFEST_SCHEMA_VERSION,
  BOUNDARY_CONTRACT_SCHEMA_VERSION,
  SLICE_BLOCKER_CODES,
  OPERATION_POLICY,
  type SliceManifest,
  type BoundaryContract,
} from "sandbox-factory";
import { sliceParamsSchema, sliceBudgetSchema } from "./analysis.js";

const strings = z.array(z.string());
const count = z.number().int().nonnegative();
const coverage = z.enum(["full", "partial", "names-only"]);
const blocker = z.object({
  code: z.enum(SLICE_BLOCKER_CODES),
  file: z.string().nullable(),
  location: z.string().nullable(),
  detail: z.string(),
});
const edge = z.object({
  from: z.string(),
  to: z.string(),
  relation: z.string(),
  specifier: z.string().nullable(),
  location: z.string().nullable(),
  targetSymbol: z.string().nullable(),
});
const module = z.object({
  module: z.string(),
  symbols: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      declaration: z.string().nullable(),
    }),
  ),
  importedBy: strings,
  stubPath: z.string().nullable(),
});
const provenance = {
  toolVersion: z.string(),
  extractorVersion: z.string().nullable(),
  sourceSnapshotId: z.string(),
  sourceCommitSha: z.string(),
  graphRunId: z.string(),
};

export const boundaryContractSchema = z.object({
  schemaVersion: z.literal(BOUNDARY_CONTRACT_SCHEMA_VERSION),
  ...provenance,
  language: z.enum(["typescript", "none"]),
  outbound: z.array(module),
  inbound: z.array(module),
  stubCoverage: coverage,
  compilation: z.object({
    attempted: z.boolean(),
    ok: z.boolean(),
    diagnostics: z.array(
      z.object({
        file: z.string().nullable(),
        line: z.number().int().nullable(),
        code: z.string(),
        message: z.string(),
      }),
    ),
    shimmedPackages: strings,
  }),
  blockers: z.array(blocker),
}) satisfies z.ZodType<BoundaryContract>;

export const sliceManifestSchema = z.object({
  schemaVersion: z.literal(SLICE_MANIFEST_SCHEMA_VERSION),
  ...provenance,
  graphSha256: z.string(),
  params: sliceParamsSchema,
  entryPoints: strings,
  budget: sliceBudgetSchema,
  included: z.array(
    z.object({
      path: z.string(),
      blobId: z.string(),
      sha256: z.string(),
      mode: z.string(),
      sizeBytes: count,
      operations: z.array(z.literal("edit")),
    }),
  ),
  synthetic: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["stub", "shim", "config"]),
      generator: z.string(),
      generatorVersion: z.string(),
      sha256: z.string(),
      sizeBytes: count,
    }),
  ),
  requiredBuildInputs: z.object({
    configs: strings,
    packages: z.array(
      z.object({
        name: z.string(),
        version: z.string().nullable(),
        declaredIn: z.string().nullable(),
      }),
    ),
  }),
  cuts: z.object({ outbound: z.array(edge), inbound: z.array(edge) }),
  internalImports: z.array(edge),
  externals: z.object({
    packages: z.array(
      z.object({ specifier: z.string(), service: z.string(), files: strings }),
    ),
    environment: z.array(z.object({ name: z.string(), files: strings })),
  }),
  communities: z.array(z.number().int()),
  blockers: z.array(blocker),
  policy: z.object({
    edit: z.literal(OPERATION_POLICY.edit),
    add: z.literal(OPERATION_POLICY.add),
    delete: z.literal(OPERATION_POLICY.delete),
    rename: z.literal(OPERATION_POLICY.rename),
    synthetic: z.literal(OPERATION_POLICY.synthetic),
    unknown: z.literal(OPERATION_POLICY.unknown),
  }),
  boundaryContractSha256: z.string(),
  meta: z.object({
    includedFiles: count,
    includedBytes: count,
    outboundCuts: count,
    inboundCuts: count,
    stubCoverage: coverage,
    externals: count,
    blockers: count,
    ready: z.boolean(),
  }),
}) satisfies z.ZodType<SliceManifest>;
