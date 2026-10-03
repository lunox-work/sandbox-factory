import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPERATION_POLICY,
  type SliceManifest,
  type BoundaryContract,
} from "sandbox-factory";
import { sliceManifestSchema, boundaryContractSchema } from "../src/index.js";
const provenance = {
  schemaVersion: 1 as const,
  toolVersion: "slice@1",
  extractorVersion: null,
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a",
  graphRunId: "arn_1",
};
const contract: BoundaryContract = {
  ...provenance,
  language: "none",
  outbound: [],
  inbound: [],
  stubCoverage: "full",
  compilation: {
    attempted: false,
    ok: true,
    diagnostics: [],
    shimmedPackages: [],
  },
  blockers: [],
};
const manifest: SliceManifest = {
  ...provenance,
  graphSha256: "hash",
  params: {
    deadlineMinutes: 30,
    graphRunId: "arn_1",
    entryPoints: ["src/app.ts"],
    budget: { maxFiles: 40, maxDepth: 3 },
    includeInferred: false,
  },
  entryPoints: ["src/app.ts"],
  budget: { maxFiles: 40, maxDepth: 3 },
  included: [],
  synthetic: [],
  requiredBuildInputs: { configs: [], packages: [] },
  cuts: { outbound: [], inbound: [] },
  internalImports: [],
  externals: { packages: [], environment: [] },
  communities: [],
  blockers: [],
  policy: OPERATION_POLICY,
  boundaryContractSha256: "hash",
  meta: {
    includedFiles: 0,
    includedBytes: 0,
    outboundCuts: 0,
    inboundCuts: 0,
    stubCoverage: "full",
    externals: 0,
    blockers: 0,
    ready: true,
  },
};
test("current slice artifacts validate and unsupported or malformed nested artifacts fail", () => {
  assert.deepEqual(sliceManifestSchema.parse(manifest), manifest);
  assert.deepEqual(boundaryContractSchema.parse(contract), contract);
  for (const value of [
    { ...manifest, schemaVersion: 2 },
    { ...manifest, included: [{ path: 4 }] },
    { ...manifest, cuts: { outbound: null, inbound: [] } },
    null,
  ])
    assert.equal(sliceManifestSchema.safeParse(value).success, false);
  for (const value of [
    { ...contract, schemaVersion: 2 },
    { ...contract, outbound: [{ module: "lib/db.ts", symbols: null }] },
    { ...contract, compilation: { attempted: true, diagnostics: "bad" } },
    null,
  ])
    assert.equal(boundaryContractSchema.safeParse(value).success, false);
});
