import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import type {
  GithubRepoSummary,
  StoredAnalysisRun,
  StoredBountyProfile,
  StoredArtifact,
  StoredSandbox,
  StoredSandboxVersion,
  StoredVersionSource,
} from "@sandbox-factory/db";
import { OPERATION_POLICY, SLICE_PUBLISHED_REASON } from "sandbox-factory";
import type {
  ApprovedTaskSnapshot,
  BoundaryContract,
  SliceManifest,
} from "sandbox-factory";
import {
  approvedTaskHash,
  mountSandboxRoutes,
  transformConfigHash,
  type SandboxRouteOptions,
} from "../src/sandbox/routes.js";
import type { AuthVariables } from "../src/routes.js";

const stamp = "2026-10-02T00:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const manifest: SliceManifest = {
  schemaVersion: 1,
  toolVersion: "slice@1",
  extractorVersion: "typescript@5.9.3",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_graph",
  graphSha256: "b".repeat(64),
  params: {
    deadlineMinutes: 30,
    graphRunId: "arn_graph",
    entryPoints: ["src/app.ts"],
    budget: { maxFiles: 40, maxDepth: 3 },
    includeInferred: false,
  },
  entryPoints: ["src/app.ts"],
  budget: { maxFiles: 40, maxDepth: 3 },
  included: [
    {
      path: "src/app.ts",
      blobId: "c".repeat(40),
      sha256: "d".repeat(64),
      mode: "100644",
      sizeBytes: 1,
      operations: ["edit"],
    },
  ],
  synthetic: [],
  requiredBuildInputs: {
    configs: ["package.json"],
    packages: [{ name: "pg", version: "^8.11.0", declaredIn: "package.json" }],
  },
  cuts: { outbound: [], inbound: [] },
  internalImports: [],
  externals: {
    packages: [{ specifier: "pg", service: "postgres", files: ["src/app.ts"] }],
    environment: [],
  },
  communities: [0],
  blockers: [],
  policy: OPERATION_POLICY,
  boundaryContractSha256: "f".repeat(64),
  meta: {
    includedFiles: 1,
    includedBytes: 1,
    outboundCuts: 0,
    inboundCuts: 0,
    stubCoverage: "full",
    externals: 1,
    blockers: 0,
    ready: true,
  },
};
const contract: BoundaryContract = {
  schemaVersion: 1,
  toolVersion: "slice@1",
  extractorVersion: "typescript@5.9.3",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_graph",
  language: "typescript",
  outbound: [],
  inbound: [],
  stubCoverage: "full",
  compilation: {
    attempted: true,
    ok: true,
    diagnostics: [],
    shimmedPackages: ["pg"],
  },
  blockers: [],
};
const manifestText = JSON.stringify(manifest);
const contractText = JSON.stringify(contract);
/** The same slice with one cut module, which fixtures can give behaviour. */
const seamContractText = JSON.stringify({
  ...contract,
  outbound: [
    {
      module: "lib/db.ts",
      symbols: [
        {
          name: "db",
          kind: "variable",
          declaration: "export declare const db: any;",
        },
      ],
      importedBy: ["src/app.ts"],
      stubPath: "stubs/lib/db.d.ts",
    },
  ],
});
const seamFixture = {
  module: "lib/db.ts",
  symbol: "db",
  member: "users.find",
  call: "call" as const,
  implementation: "async (id) => ({ id })",
  reason: "a known user",
};
const fixtureSetText = JSON.stringify({
  schemaVersion: 1,
  toolVersion: "fixtures@1",
  sliceRunId: "arn_slice",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  proposalId: "bpr_1",
  specRevision: 2,
  fixtures: [seamFixture],
  scenario: "console.log(1);",
  summary: "Walks it.",
  usage: {
    model: "m",
    turns: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
});
const fixturesRunOf = (
  id: string,
  sliceRunId: string,
  status: StoredAnalysisRun["status"] = "succeeded",
): StoredAnalysisRun => ({
  ...sliceRun,
  id,
  tool: "fixtures",
  toolVersion: "fixtures@1",
  status,
  params: {
    deadlineMinutes: 30,
    agent: "fixtures",
    sliceRunId,
    proposalId: "bpr_1",
    specRevision: 2,
    specHash: "h",
  },
});
const sliceRun: StoredAnalysisRun = {
  id: "arn_slice",
  snapshotId: "rsn_1",
  repoId: "ghr_1",
  tool: "slice",
  toolVersion: "slice@1",
  params: manifest.params,
  status: "succeeded",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  progress: null,
  previewFiles: null,
  startedAt: stamp,
  finishedAt: stamp,
  deadlineAt: stamp,
  createdAt: stamp,
};
const buildRun: StoredAnalysisRun = {
  ...sliceRun,
  id: "arn_build",
  tool: "sandbox_build",
  toolVersion: "sandbox_build@1",
  status: "queued",
  params: {
    deadlineMinutes: 30,
    sliceRunId: "arn_slice",
    sandboxVersionId: "sbv_1",
    manifestSha256: sha(manifestText),
    contractSha256: sha(contractText),
    transformConfigSha256: "1".repeat(64),
    approvedTaskSha256: "2".repeat(64),
  },
};
const artifactOf = (
  kind: StoredArtifact["kind"],
  path: string,
  text: string,
): StoredArtifact => ({
  id: `art_${path}`,
  runId: sliceRun.id,
  kind,
  path,
  objectKey: `runs/arn_slice/lease/${path}`,
  contentType: "application/json",
  sizeBytes: text.length,
  sha256: sha(text),
  meta: null,
  createdAt: stamp,
});
const sandbox: StoredSandbox = {
  id: "sbx_1",
  organizationId: "org_1",
  slug: "abc123def456",
  status: "draft",
  publicRepoId: null,
  currentVersionId: null,
  expiresAt: null,
  bountyId: "bty_1",
  sourceRepoId: "ghr_1",
  createdAt: stamp,
  updatedAt: stamp,
};
const version: StoredSandboxVersion = {
  id: "sbv_1",
  sandboxId: "sbx_1",
  version: 1,
  title: "Fix it",
  specSummary: "Summary",
  complexity: "M",
  tags: [],
  testSummary: [],
  publicBaseCommitSha: null,
  readme: null,
  languages: null,
  frozenAt: null,
  createdAt: stamp,
};
const source: StoredVersionSource = {
  sandboxVersionId: "sbv_1",
  proposalVersion: 1,
  contextVersions: { jira: null, github: null },
  origin: "slice",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  sliceRunId: "arn_slice",
  manifestSha256: sha(manifestText),
  contractSha256: sha(contractText),
  starterRunId: null,
  starterSha256: null,
  transformConfigSha256: "1".repeat(64),
  approvedTaskSha256: "2".repeat(64),
  approvedTask: {
    schemaVersion: 3,
    title: "Fix it",
    summary: "Summary",
    spec: {
      proposalId: "bpr_1",
      specRevision: 2,
      specHash: "s".repeat(64),
      draft: {
        feature: "Thing",
        background: [],
        scenarios: [
          {
            id: "s1",
            kind: "happy",
            title: "works",
            steps: [{ keyword: "Given", text: "x" }],
            origin: "draft",
          },
        ],
        openQuestions: [],
        assumptions: [],
      },
    },
    pricing: {
      proposalId: "bpr_1",
      proposalRevision: 3,
      complexity: "M",
      amountMinor: 10500,
      currency: "USD",
      status: "approved",
      decidedAt: stamp,
    },
    selectedBy: "user_1",
    selectedAt: stamp,
    bountyId: "bty_1",
  },
  aliasRules: [],
  dependencyChoices: {},
  acceptanceTests: [],
  fixtures: null,
  scope: {
    editablePaths: ["src/app.ts"],
    generatedPaths: [],
    permittedOperations: ["edit"],
    dependencies: [],
    blockers: [],
  },
  harnessSha256: null,
  toolchainDigest: null,
  buildRunId: null,
  roundTripRunId: null,
  disclosureRunId: null,
  approvedBy: null,
  approvedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
};

/** The sizing's profile of `bpr_1`'s spec revision 2 in `ghr_1`, sliced. */
const readyProfile: StoredBountyProfile = {
  id: "bpf_1",
  organizationId: "org_1",
  proposalId: "bpr_1",
  specRevision: 2,
  specHash: "s".repeat(64),
  snapshotId: "rsn_1",
  repository: "acme/ghr_1",
  status: "ready",
  errorCode: null,
  runErrorCode: null,
  scopeRunId: "arn_scope",
  sliceRunId: "arn_slice",
  preparedRunId: null,
  profile: null,
  createdAt: stamp,
  updatedAt: stamp,
};

/** What a built version's run wrote, some of it not text or too big to show. */
const builtFiles = [
  { path: "project/src/index.ts", body: "export const sum = 1;\n" },
  { path: "private/hidden.test.ts", body: "test('hidden', () => {});\n" },
  { path: "project/logo.png", body: "\u0000PNG" },
  { path: "project/huge.json", body: "x".repeat(1_000_001) },
];

/** A workspace's repositories, as the sandbox routes list them. */
const workspaceRepo = (
  id: string,
  overrides: Partial<GithubRepoSummary> = {},
): GithubRepoSummary => ({
  id,
  connectionId: "ghc_1",
  role: "source",
  externalId: id,
  fullName: `acme/${id}`,
  defaultBranch: "main",
  isPrivate: true,
  sizeKb: null,
  headSha: null,
  pushedAt: null,
  lastSyncedAt: null,
  syncStatus: "ok",
  syncError: null,
  stack: null,
  stackCommitSha: null,
  stackVersion: null,
  contextSnapshotId: null,
  createdAt: stamp,
  ...overrides,
});
const workspaceRepos: GithubRepoSummary[] = [
  workspaceRepo("ghr_1"),
  workspaceRepo("ghr_2"),
  workspaceRepo("ghr_x"),
  workspaceRepo("ghr_gone", { syncStatus: "gone" }),
  workspaceRepo("ghr_pub", { role: "sandbox" }),
];
/**
 * The repositories each bounty's live proposal says its work touches;
 * `bty_1`'s is `ghr_1`, and a bounty not here has no live proposal.
 */
const touchedBy: Record<string, string[]> = {
  bty_web: ["ghr_2"],
  bty_both: ["ghr_1", "ghr_2"],
  // One gone from GitHub, and one removed from the workspace: neither is
  // a repository it can be cut from now.
  bty_gone: ["ghr_gone", "ghr_old", "ghr_2"],
  bty_removed: ["ghr_old", "ghr_pub"],
  bty_none: [],
  // Disconnected between the read and the write.
  bty_raced: ["ghr_x"],
};
/** Sandboxes made without a repository, by the bounty each is for. */
const sandboxBounties: Record<string, string> = {
  sbx_linked: "bty_web",
  sbx_both: "bty_both",
  sbx_none: "bty_none",
  sbx_unsized: "bty_unsized",
  sbx_raced: "bty_raced",
};

function fixture(
  role = "owner",
  overrides: Partial<{
    frozen: boolean;
    corrupt: boolean;
    manifest: unknown;
    contract: unknown;
    unparsable: boolean;
    limit: boolean;
    sliceStatus: string;
    recordFails: boolean;
    conflict: boolean;
    blocked: boolean;
    noSpec: boolean;
    seam: boolean;
    built: boolean;
    /** The build is still running, and has written its project only. */
    previewing: boolean;
    /** The version has no passing build to publish. */
    unready: boolean;
    /** The bounty's proposal is not approved. */
    unapproved: boolean;
    /**
     * The step before the sandbox that is not approved. Unless said, no
     * bounty is read: the steps before are not what the rest test.
     */
    held: "scope" | "price";
    /** The bounty is read, its scope approved, for a version's listing. */
    bounty: boolean;
    /** The sandbox has no versions yet. */
    noVersions: boolean;
    /** `sbv_1` is published until this time. */
    publishedUntil: string;
    /**
     * The sizing's profile of `bpr_1`'s spec revision 2 in `ghr_1`, with
     * what differs from a ready one; null for none. Unsaid, the routes
     * have no profiles at all.
     */
    profile: Partial<StoredBountyProfile> | null;
    /** The snapshot has no succeeded data model for a build to name. */
    noDataModel: boolean;
    /**
     * Versions as the store makes them under the sandbox's lock: each cut
     * a version of its own, except a cut asked to reuse the draft an
     * earlier cut of the same slice made.
     */
    lockedCut: boolean;
  }> = {},
) {
  const published: { versionId: string; actor: string; expiresAt: string }[] =
    [];
  const manifestText = JSON.stringify(overrides.manifest ?? manifest);
  const contractText = JSON.stringify(overrides.contract ?? contract);
  const created: unknown[] = [];
  const patches: unknown[] = [];
  const builds: unknown[] = [];
  const enqueued: unknown[] = [];
  const removed: string[] = [];
  const linked: { id: string; sourceRepoId: string }[] = [];
  const requested: unknown[] = [];
  const cuts: unknown[] = [];
  const made: { bountyId: string; sourceRepoId: string | null }[] = [];
  let launches = 0;
  const stored = {
    version: { ...version, frozenAt: overrides.frozen === true ? stamp : null },
    source:
      overrides.blocked === true
        ? {
            ...source,
            scope: {
              ...source.scope,
              blockers: [
                { code: "dependency_unresolved" as const, detail: "x" },
              ],
            },
          }
        : overrides.noSpec === true
          ? { ...source, approvedTask: { ...source.approvedTask, spec: null } }
          : overrides.built === true
            ? { ...source, buildRunId: buildRun.id }
            : source,
  };
  const objects = new Map<string, Buffer>([
    [
      "runs/arn_slice/lease/slice-manifest.json",
      Buffer.from(overrides.corrupt === true ? "tampered" : manifestText),
    ],
    [
      "runs/arn_slice/lease/boundary-contract.json",
      Buffer.from(overrides.seam === true ? seamContractText : contractText),
    ],
    ["runs/arn_fixtures/lease/fixture-set.json", Buffer.from(fixtureSetText)],
    ["runs/arn_fixtures_bad/lease/fixture-set.json", Buffer.from("not json")],
    ...builtFiles.map(
      ({ path, body }) =>
        [`runs/arn_build/lease/${path}`, Buffer.from(body)] as const,
    ),
  ]);
  const artifacts = [
    artifactOf(
      "slice_manifest",
      "slice-manifest.json",
      overrides.unparsable === true ? "not json" : manifestText,
    ),
    artifactOf(
      "boundary_contract",
      "boundary-contract.json",
      overrides.seam === true ? seamContractText : contractText,
    ),
  ];
  const fixtureArtifact = (runId: string, text: string): StoredArtifact => ({
    ...artifactOf("fixture_set", "fixture-set.json", text),
    runId,
    objectKey: `runs/${runId}/lease/fixture-set.json`,
  });
  if (overrides.unparsable === true)
    objects.set(
      "runs/arn_slice/lease/slice-manifest.json",
      Buffer.from("not json"),
    );
  const options = {
    sandboxes: {
      create: async (
        owner: string,
        input: { bountyId: string; sourceRepoId: string | null },
      ) =>
        made.push(input) && input.bountyId === "bty_x"
          ? { ok: false, reason: "bounty_not_found" }
          : input.bountyId === "bty_taken"
            ? { ok: false, reason: "bounty_has_sandbox" }
            : input.sourceRepoId === "ghr_x"
              ? { ok: false, reason: "repo_not_found" }
              : {
                  ok: true,
                  sandbox: {
                    ...sandbox,
                    organizationId: owner,
                    bountyId: input.bountyId,
                    sourceRepoId: input.sourceRepoId,
                  },
                },
      list: async () => [sandbox],
      linkSource: async (owner: string, id: string, sourceRepoId: string) => {
        linked.push({ id, sourceRepoId });
        return owner !== "org_1"
          ? { ok: false, reason: "not-found" }
          : id === "sbx_linked"
            ? { ok: false, reason: "source_linked" }
            : sourceRepoId === "ghr_x"
              ? { ok: false, reason: "repo_not_found" }
              : { ok: true, sandbox: { ...sandbox, id, sourceRepoId } };
      },
      get: async (owner: string, id: string) =>
        owner !== "org_1"
          ? null
          : id === "sbx_1"
            ? overrides.publishedUntil === undefined
              ? sandbox
              : {
                  ...sandbox,
                  status: "published" as const,
                  currentVersionId: "sbv_1",
                  expiresAt: overrides.publishedUntil,
                }
            : id === "sbx_bare"
              ? { ...sandbox, id: "sbx_bare", sourceRepoId: null }
              : id === "sbx_unlinked"
                ? { ...sandbox, id: "sbx_unlinked" }
                : id in sandboxBounties
                  ? {
                      ...sandbox,
                      id,
                      bountyId: sandboxBounties[id],
                      sourceRepoId: null,
                    }
                  : null,
      createVersion: async (
        _owner: string,
        sandboxId: string,
        input: unknown,
      ) => {
        const typed = input as {
          reuseDraft?: boolean;
          source: { sliceRunId: string };
        };
        if (overrides.lockedCut === true) {
          const index = created.findIndex(
            (each) =>
              (each as typeof typed).source.sliceRunId ===
              typed.source.sliceRunId,
          );
          if (typed.reuseDraft !== true || index < 0) {
            created.push(input);
            return {
              ok: true,
              version: { ...stored.version, id: `sbv_${created.length}` },
              source: stored.source,
            };
          }
          return {
            ok: true,
            version: { ...stored.version, id: `sbv_${index + 1}` },
            source: stored.source,
          };
        }
        created.push(input);
        return typed.source.sliceRunId === "arn_other"
          ? { ok: false, reason: "slice_mismatch" }
          : sandboxId === "sbx_1"
            ? { ok: true, ...stored }
            : sandboxId === "sbx_unlinked"
              ? { ok: false, reason: "no_source" }
              : { ok: false, reason: "not-found" };
      },
      listVersions: async () =>
        overrides.noVersions === true ? [] : [version],
      getVersion: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbv_1" ? stored : null,
      updateDraft: async (_owner: string, id: string, patch: unknown) => {
        patches.push(patch);
        if (overrides.conflict === true)
          return { ok: false, reason: "conflict" };
        return id === "sbv_1"
          ? overrides.frozen === true
            ? { ok: false, reason: "frozen" }
            : { ok: true, ...stored }
          : { ok: false, reason: "not-found" };
      },
      recordBuild: async (
        _owner: string,
        versionId: string,
        runId: string,
        expected: string,
      ) => {
        builds.push({ versionId, runId, expected });
        return overrides.recordFails === true
          ? { ok: false, reason: "conflict" }
          : { ok: true, ...stored };
      },
      publishVersion: async (
        owner: string,
        id: string,
        actor: string,
        expiresAt: Date,
      ) => {
        if (owner !== "org_1" || id !== "sbv_1")
          return { ok: false, reason: "not-found" };
        if (overrides.unready === true)
          return { ok: false, reason: "not_ready" };
        if (overrides.unapproved === true)
          return { ok: false, reason: "price_not_approved" };
        published.push({
          versionId: id,
          actor,
          expiresAt: expiresAt.toISOString(),
        });
        return {
          ok: true,
          sandbox: {
            ...sandbox,
            status: "published",
            currentVersionId: id,
            expiresAt: expiresAt.toISOString(),
          },
          version: {
            version: { ...version, frozenAt: stamp },
            source: { ...source, approvedBy: actor, approvedAt: stamp },
          },
        };
      },
      unpublish: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbx_1"
          ? { ...sandbox, status: "draft", currentVersionId: null }
          : null,
      replayContext: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbv_1"
          ? {
              source,
              snapshot: { commitSha: "a".repeat(40), repoGone: false },
              sliceRun: { status: "succeeded", artifactsPresent: true },
            }
          : owner === "org_1" && id === "sbv_gone"
            ? { source, snapshot: null, sliceRun: null }
            : null,
    },
    runs: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "arn_slice"
          ? { ...sliceRun, status: overrides.sliceStatus ?? "succeeded" }
          : owner === "org_1" && id === "arn_build"
            ? {
                ...buildRun,
                status: overrides.previewing === true ? "running" : "succeeded",
              }
            : owner === "org_1" && id === "arn_other"
              ? { ...sliceRun, id: "arn_other" }
              : owner === "org_1" && id === "arn_graph"
                ? { ...sliceRun, id: "arn_graph", tool: "graphify" }
                : owner === "org_1" && id === "arn_fixtures"
                  ? fixturesRunOf(id, "arn_slice")
                  : owner === "org_1" && id === "arn_fixtures_bad"
                    ? fixturesRunOf(id, "arn_slice")
                    : owner === "org_1" && id === "arn_fixtures_gone"
                      ? fixturesRunOf(id, "arn_slice")
                      : owner === "org_1" && id === "arn_fixtures_running"
                        ? fixturesRunOf(id, "arn_slice", "running")
                        : owner === "org_1" && id === "arn_fixtures_elsewhere"
                          ? fixturesRunOf(id, "arn_other")
                          : null,
      latestSucceeded: async (
        owner: string,
        snapshotId: string,
        tool: string,
      ) =>
        owner === "org_1" &&
        snapshotId === "rsn_1" &&
        tool === "data_model" &&
        overrides.noDataModel !== true
          ? { ...sliceRun, id: "arn_model", tool: "data_model" }
          : null,
      enqueue: async (_owner: string, snapshotId: string, input: unknown) => {
        enqueued.push({ snapshotId, ...(input as object) });
        return overrides.limit === true
          ? { ok: false, reason: "run_limit" }
          : {
              ok: true,
              created: true,
              run: buildRun,
              obsoleteLogKey: "logs/old.log",
            };
      },
    },
    artifacts: {
      list: async (_owner: string, runId: string) =>
        runId === "arn_slice" || runId === "arn_other"
          ? artifacts
          : runId === "arn_build" && overrides.previewing !== true
            ? builtFiles.map(({ path, body }) => ({
                ...artifactOf("build_manifest", path, body),
                runId,
                objectKey: `runs/arn_build/lease/${path}`,
              }))
            : runId === "arn_fixtures"
              ? [fixtureArtifact(runId, fixtureSetText)]
              : runId === "arn_fixtures_bad"
                ? [fixtureArtifact(runId, "not json")]
                : runId === "arn_fixtures_running"
                  ? [fixtureArtifact(runId, fixtureSetText)]
                  : [],
    },
    objects: {
      get: async (key: string) => objects.get(key),
      remove: async (key: string) => {
        removed.push(key);
      },
    },
    previews: {
      preview: async (owner: string, runId: string) =>
        overrides.previewing === true &&
        owner === "org_1" &&
        runId === "arn_build"
          ? {
              at: "2026-10-16T00:00:00.000Z",
              files: builtFiles
                .filter(({ path }) => path.startsWith("project/"))
                .map(({ path, body }) => ({
                  path,
                  objectKey: `runs/arn_build/lease/${path}`,
                  contentType: "text/plain; charset=utf-8",
                  sizeBytes: Buffer.byteLength(body),
                  sha256: "a".repeat(64),
                })),
            }
          : null,
    },
    repos: { list: async () => workspaceRepos },
    organizationNames: async (owner: string) =>
      owner === "org_1" ? ["Acme Corp", "acme"] : [],
    bounties: {
      get: async (owner: string, id: string) =>
        (overrides.held === undefined && overrides.bounty !== true) ||
        owner !== "org_1" ||
        id !== "bty_1"
          ? null
          : {
              title: "Fix the\n  login",
              description: "",
              stack: ["TypeScript"],
              id,
              // Approved at version 1; held by the scope, it has moved on.
              version: overrides.held === "scope" ? 2 : 1,
              approval: { version: 1, approvedBy: "user_1", approvedAt: stamp },
            },
    },
    proposals: {
      liveForBounty: async (owner: string, bountyId: string) =>
        owner !== "org_1"
          ? null
          : bountyId === "bty_1"
            ? "bpr_1"
            : bountyId in touchedBy
              ? `bpr_${bountyId}`
              : null,
      get: async (owner: string, id: string) =>
        owner === "org_1" && (id === "bpr_1" || id === "bpr_other")
          ? {
              id,
              bountyId: id === "bpr_1" ? "bty_1" : "bty_2",
              revision: 3,
              complexity: "M",
              amountMinor: 10500,
              currency: "USD",
              status: overrides.held === "price" ? "proposed" : "approved",
              decidedAt: stamp,
              specRevision: 2,
              repositories: [{ repoId: "ghr_1", snapshotId: "rsn_1" }],
            }
          : owner === "org_1" && id === "bpr_nospec"
            ? {
                id,
                bountyId: "bty_1",
                revision: 1,
                complexity: "S",
                amountMinor: 5800,
                currency: "USD",
                status: "approved",
                decidedAt: null,
                specRevision: null,
                repositories: [],
              }
            : owner === "org_1" && id.startsWith("bpr_bty_")
              ? {
                  id,
                  bountyId: id.slice("bpr_".length),
                  revision: 1,
                  complexity: "M",
                  amountMinor: 10500,
                  currency: "USD",
                  status: "proposed",
                  decidedAt: null,
                  specRevision: 1,
                  repositories:
                    touchedBy[id.slice("bpr_".length)]?.map((repoId) => ({
                      repoId,
                      snapshotId: `rsn_${repoId}`,
                    })) ?? [],
                }
              : null,
    },
    specs: {
      get: async (_owner: string, proposalId: string, revision: number) =>
        proposalId === "bpr_1" && revision === 2
          ? {
              revision,
              specHash: "s".repeat(64),
              draft: source.approvedTask.spec?.draft,
            }
          : null,
    },
    ...(overrides.profile === undefined
      ? {}
      : {
          profiles: {
            forRevision: async (
              owner: string,
              proposalId: string,
              revision: number,
            ) =>
              overrides.profile === null ||
              owner !== "org_1" ||
              proposalId !== "bpr_1" ||
              revision !== 2
                ? []
                : [{ ...readyProfile, ...overrides.profile }],
            preparationFor: async (owner: string, sliceRunId: string) =>
              owner === "org_1" &&
              sliceRunId ===
                (overrides.profile?.sliceRunId ?? readyProfile.sliceRunId)
                ? (overrides.profile?.preparedRunId ?? null)
                : null,
          },
          requestProfile: async (owner: string, input: unknown) => {
            requested.push({ owner, input });
          },
          cuts: {
            requestCut: async (
              owner: string,
              sandboxId: string,
              actor: string,
            ) => {
              cuts.push({ asked: sandboxId, owner, actor });
              return true;
            },
            clearCut: async (owner: string, sandboxId: string) => {
              cuts.push({ cleared: sandboxId, owner });
            },
          },
        }),
    ensureWorker: async () => {
      launches++;
    },
    now: () => new Date(stamp),
  } as unknown as SandboxRouteOptions;
  const app = new Hono<{ Variables: AuthVariables }>();
  // As `requireMembership` does: the owner is the path's, so a request for
  // another workspace reads that workspace's rows, of which there are none.
  app.use("/api/v1/orgs/:orgId/*", async (c, next) => {
    c.set("user", {
      id: "user_1",
      email: "u@example.test",
      name: "User",
    } as never);
    c.set("member", {
      role,
      organizationId: c.req.param("orgId"),
    } as never);
    await next();
  });
  mountSandboxRoutes(app, options);
  const request = (
    method: string,
    path: string,
    body?: unknown,
    org = "org_1",
  ) =>
    app.request(`/api/v1/orgs/${org}/sandboxes${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  return {
    request,
    created,
    patches,
    builds,
    enqueued,
    removed,
    published,
    linked,
    requested,
    cuts,
    made,
    launches: () => launches,
  };
}

test("a sandbox is changed only on an approved scope and price; unpublishing is not held", async () => {
  for (const [held, error] of [
    ["scope", "Approve the scope and the price before changing the sandbox."],
    ["price", "Approve the price before changing the sandbox."],
  ] as const) {
    const f = fixture("owner", { held });
    for (const [method, path, body] of [
      ["POST", "", { bountyId: "bty_1" }],
      ["POST", "/start", { bountyId: "bty_1" }],
      ["PUT", "/sbx_1/source", undefined],
      ["POST", "/sbx_1/starter", undefined],
      ["POST", "/sbx_1/versions", { sliceRunId: "arn_slice" }],
      ["PATCH", "/versions/sbv_1", { title: "Renamed" }],
      ["POST", "/versions/sbv_1/build", undefined],
      [
        "POST",
        "/versions/sbv_1/publish",
        { expiresAt: "2026-10-09T00:00:00.000Z" },
      ],
    ] as const) {
      const response = await f.request(method, path, body);
      assert.equal(response.status, 409, `${held} ${method} ${path}`);
      assert.deepEqual(await response.json(), {
        code: "step_held",
        heldBy: held,
        error,
      });
    }
    assert.deepEqual(f.made, []);
    assert.deepEqual(f.created, []);
    assert.deepEqual(f.patches, []);
    assert.deepEqual(f.builds, []);
    assert.deepEqual(f.published, []);
    assert.equal((await f.request("POST", "/sbx_1/unpublish")).status, 200);
  }
});

test("an admin publishes a version whose build passed, and unpublishes the sandbox", async () => {
  const f = fixture();
  // A week past the fixture's clock.
  const until = { expiresAt: "2026-10-09T00:00:00.000Z" };
  const response = await f.request("POST", "/versions/sbv_1/publish", until);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    sandbox: { status: string; currentVersionId: string; expiresAt: string };
    version: { frozenAt: string | null };
    source: { approvedBy: string | null };
  };
  assert.equal(body.sandbox.status, "published");
  assert.equal(body.sandbox.currentVersionId, "sbv_1");
  assert.equal(body.version.frozenAt, stamp);
  assert.equal(body.source.approvedBy, "user_1");
  assert.deepEqual(f.published, [
    { versionId: "sbv_1", actor: "user_1", expiresAt: until.expiresAt },
  ]);
  assert.equal(body.sandbox.expiresAt, until.expiresAt);
  // An expiry is required, and must be ahead.
  for (const [given, code] of [
    [undefined, undefined],
    [{ expiresAt: "next week" }, undefined],
    [{ expiresAt: stamp }, "expiry_past"],
  ] as const) {
    const refused = await f.request("POST", "/versions/sbv_1/publish", given);
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { code?: string }).code, code);
  }
  assert.equal(f.published.length, 1);
  const back = await f.request("POST", "/sbx_1/unpublish");
  assert.equal(back.status, 200);
  assert.equal(
    ((await back.json()) as { sandbox: { status: string } }).sandbox.status,
    "draft",
  );
  // Only a passing build, only an admin, only its own.
  const unready = await fixture("owner", { unready: true }).request(
    "POST",
    "/versions/sbv_1/publish",
    until,
  );
  assert.equal(unready.status, 409);
  assert.equal(((await unready.json()) as { code: string }).code, "not_ready");
  // Only over an approved bounty.
  const unapproved = await fixture("owner", { unapproved: true }).request(
    "POST",
    "/versions/sbv_1/publish",
    until,
  );
  assert.equal(unapproved.status, 409);
  assert.equal(
    ((await unapproved.json()) as { code: string }).code,
    "price_not_approved",
  );
  assert.equal(
    (await fixture("member").request("POST", "/versions/sbv_1/publish", until))
      .status,
    403,
  );
  assert.equal(
    (await fixture("member").request("POST", "/sbx_1/unpublish")).status,
    403,
  );
  assert.equal(
    (await f.request("POST", "/versions/sbv_x/publish", until)).status,
    404,
  );
  assert.equal((await f.request("POST", "/sbx_9/unpublish")).status, 404);
});

test("a bounty's sandbox is created by admins, cut from the repository its sizing touches, and listed for members", async () => {
  const f = fixture();
  const sourceOf = async (bountyId: string) => {
    const response = await f.request("POST", "", { bountyId });
    assert.equal(response.status, 201, bountyId);
    return ((await response.json()) as { sandbox: StoredSandbox }).sandbox
      .sourceRepoId;
  };
  const created = await f.request("POST", "", { bountyId: "bty_1" });
  assert.equal(created.status, 201);
  const made = ((await created.json()) as { sandbox: StoredSandbox }).sandbox;
  assert.deepEqual(
    [made.id, made.bountyId, made.sourceRepoId],
    ["sbx_1", "bty_1", "ghr_1"],
  );
  assert.equal(await sourceOf("bty_web"), "ghr_2");
  // One the workspace still has, among some it no longer does.
  assert.equal(await sourceOf("bty_gone"), "ghr_2");
  // A repository is enrichment: a sandbox is made without one when the
  // bounty is unsized, touches none, touches several, or touches only
  // repositories gone, removed or not a source.
  for (const bountyId of ["bty_2", "bty_none", "bty_both", "bty_removed"])
    assert.equal(await sourceOf(bountyId), null, bountyId);
  const taken = await f.request("POST", "", { bountyId: "bty_taken" });
  assert.equal(taken.status, 409);
  assert.equal(
    ((await taken.json()) as { code: string }).code,
    "bounty_has_sandbox",
  );
  const noBounty = await f.request("POST", "", { bountyId: "bty_x" });
  assert.equal(noBounty.status, 404);
  assert.equal(
    ((await noBounty.json()) as { code: string }).code,
    "bounty_not_found",
  );
  // A repository disconnected since the sizing named it is told apart from
  // a missing bounty, so the person asking can see what to change.
  const noRepo = await f.request("POST", "", { bountyId: "bty_raced" });
  assert.equal(noRepo.status, 404);
  assert.deepEqual(await noRepo.json(), {
    error: "The repository is not connected to this workspace any more.",
    code: "repo_not_found",
  });
  // No sandbox without its bounty, and no repository named for it: its
  // sizing names that.
  for (const body of [
    { sourceRepoId: "ghr_1" },
    { bountyId: "bty_1", sourceRepoId: "ghr_1" },
    { nope: true },
  ])
    assert.equal((await f.request("POST", "", body)).status, 400);
  assert.equal(
    (await fixture("member").request("POST", "", { bountyId: "bty_1" })).status,
    403,
  );
  const list = await fixture("member").request("GET", "");
  assert.equal(list.status, 200);
  assert.deepEqual(
    ((await list.json()) as { sandboxes: StoredSandbox[] }).sandboxes.map(
      (s) => s.id,
    ),
    ["sbx_1"],
  );
  assert.equal((await f.request("GET", "/sbx_1")).status, 200);
  assert.equal(
    (await f.request("GET", "/sbx_1", undefined, "org_2")).status,
    404,
  );
  assert.equal((await f.request("GET", "/sbx_1/versions")).status, 200);
  assert.equal((await f.request("GET", "/sbx_9/versions")).status, 404);
});

test("a sandbox made without a repository has the one its sizing touches linked once, by an admin", async () => {
  const f = fixture();
  // What is sent is not read: the sizing says which repository it is.
  const linked = await f.request("PUT", "/sbx_bare/source", {
    sourceRepoId: "ghr_2",
  });
  assert.equal(linked.status, 200);
  const made = ((await linked.json()) as { sandbox: StoredSandbox }).sandbox;
  assert.deepEqual([made.id, made.sourceRepoId], ["sbx_bare", "ghr_1"]);
  assert.deepEqual(f.linked, [{ id: "sbx_bare", sourceRepoId: "ghr_1" }]);
  const code = async (response: Response) => [
    response.status,
    ((await response.json()) as { code?: string }).code,
  ];
  // Its versions are bound to the repository it has.
  assert.deepEqual(await code(await f.request("PUT", "/sbx_linked/source")), [
    409,
    "source_linked",
  ]);
  assert.deepEqual(await code(await f.request("PUT", "/sbx_raced/source")), [
    404,
    "repo_not_found",
  ]);
  // Several, none, or no sizing yet: there is no one repository to cut.
  for (const id of ["sbx_both", "sbx_none", "sbx_unsized"])
    assert.deepEqual(
      await code(await f.request("PUT", `/${id}/source`)),
      [409, "no_touched_repository"],
      id,
    );
  assert.deepEqual(await code(await f.request("PUT", "/sbx_9/source")), [
    404,
    undefined,
  ]);
  assert.equal(
    (await f.request("PUT", "/sbx_bare/source", undefined, "org_2")).status,
    404,
  );
  assert.equal(
    (await fixture("member").request("PUT", "/sbx_bare/source")).status,
    403,
  );
  assert.deepEqual(f.linked.length, 3);
});

test("a version pins the slice artifacts by hash, snapshots the approved task and writes the scope", async () => {
  const f = fixture();
  const body = {
    sliceRunId: "arn_slice",
    title: "Fix it",
    specSummary: "Summary",
    complexity: "M",
    proposalId: "bpr_1",
    aliasRules: [{ before: "Acme", after: "Widget", kind: "identifier" }],
    dependencyChoices: { pg: "approved-package" },
    acceptanceTests: [
      {
        path: "tests/private/fix.test.ts",
        text: "x",
        expectedBaseline: "fail",
      },
    ],
  };
  const response = await f.request("POST", "/sbx_1/versions", body);
  assert.equal(response.status, 201);
  const json = (await response.json()) as {
    version: StoredSandboxVersion;
    source: StoredVersionSource;
  };
  assert.equal(json.version.id, "sbv_1");
  assert.equal(json.source.sourceCommitSha, "a".repeat(40));
  const input = f.created[0] as {
    source: StoredVersionSource & { approvedTask: ApprovedTaskSnapshot };
    tags: string[];
  };
  assert.equal(input.source.manifestSha256, sha(manifestText));
  assert.equal(input.source.contractSha256, sha(contractText));
  assert.equal(input.source.sliceRunId, "arn_slice");
  assert.equal(input.source.sourceSnapshotId, "rsn_1");
  assert.deepEqual(input.tags, []);
  assert.equal(
    input.source.transformConfigSha256,
    transformConfigHash({
      aliasRules: [
        { before: "Acme", after: "Widget", kind: "identifier", paths: [] },
      ],
      dependencyChoices: { pg: "approved-package" },
      acceptanceTests: [
        {
          path: "tests/private/fix.test.ts",
          text: "x",
          expectedBaseline: "fail",
        },
      ],
    }),
  );
  assert.equal(
    input.source.approvedTaskSha256,
    approvedTaskHash(input.source.approvedTask),
  );
  assert.equal(input.source.approvedTask.spec?.specRevision, 2);
  assert.equal(input.source.approvedTask.pricing?.amountMinor, 10500);
  // A new version names the sandbox's bounty, at the current schema.
  assert.equal(input.source.approvedTask.schemaVersion, 3);
  if (input.source.approvedTask.schemaVersion === 3)
    assert.equal(input.source.approvedTask.bountyId, "bty_1");
  assert.equal(input.source.approvedTask.selectedBy, "user_1");
  assert.deepEqual(input.source.scope.editablePaths, ["src/app.ts"]);
  assert.deepEqual(
    input.source.scope.dependencies.map((d) => [d.name, d.resolution]),
    [["pg", "approved-package"]],
  );
  // Without a proposal the task carries no spec or price; a proposal with no spec carries price only.
  await f.request("POST", "/sbx_1/versions", {
    sliceRunId: "arn_slice",
    title: "T",
    specSummary: "S",
    complexity: "S",
  });
  const bare = f.created[1] as { source: StoredVersionSource };
  assert.equal(bare.source.approvedTask.spec, null);
  assert.equal(bare.source.approvedTask.pricing, null);
  await f.request("POST", "/sbx_1/versions", {
    sliceRunId: "arn_slice",
    title: "T",
    specSummary: "S",
    complexity: "S",
    proposalId: "bpr_nospec",
  });
  const priced = f.created[2] as { source: StoredVersionSource };
  assert.equal(priced.source.approvedTask.spec, null);
  assert.equal(priced.source.approvedTask.pricing?.complexity, "S");
});

test("a sandbox with no repository has no version to cut", async () => {
  const f = fixture();
  const response = await f.request("POST", "/sbx_bare/versions", {
    sliceRunId: "arn_slice",
    title: "Fix it",
    specSummary: "Summary",
    complexity: "M",
  });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "no_source");
  assert.equal(f.created.length, 0);
  // Its repository unlinked between the read and the write: the same answer.
  const raced = await f.request("POST", "/sbx_unlinked/versions", {
    sliceRunId: "arn_slice",
    title: "Fix it",
    specSummary: "Summary",
    complexity: "M",
    dependencyChoices: { pg: "approved-package" },
  });
  assert.equal(raced.status, 409);
  assert.equal(((await raced.json()) as { code: string }).code, "no_source");
});

test("version creation refuses what it cannot pin", async () => {
  const f = fixture();
  const base = { title: "T", specSummary: "S", complexity: "M" };
  assert.equal(
    (await f.request("POST", "/sbx_1/versions", { ...base })).status,
    400,
  );
  assert.equal(
    (
      await fixture("member").request("POST", "/sbx_1/versions", {
        ...base,
        sliceRunId: "arn_slice",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("POST", "/sbx_9/versions", {
        ...base,
        sliceRunId: "arn_slice",
      })
    ).status,
    404,
  );
  const aliases = await f.request("POST", "/sbx_1/versions", {
    ...base,
    sliceRunId: "arn_slice",
    aliasRules: [{ before: "A", after: "A", kind: "identifier" }],
  });
  assert.equal(aliases.status, 400);
  const typo = await f.request("POST", "/sbx_1/versions", {
    ...base,
    sliceRunId: "arn_slice",
    dependencyChoices: { pgg: "runtime-mock" },
  });
  assert.equal(typo.status, 400);
  assert.equal(
    ((await typo.json()) as { code: string }).code,
    "dependency_choice_unknown",
  );
  assert.equal(f.created.length, 0);
  assert.equal(
    ((await aliases.json()) as { code: string }).code,
    "alias_rules_invalid",
  );
  assert.equal(
    (
      await f.request("POST", "/sbx_1/versions", {
        ...base,
        sliceRunId: "arn_missing",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("POST", "/sbx_1/versions", {
        ...base,
        sliceRunId: "arn_graph",
      })
    ).status,
    404,
  );
  const queued = await fixture("owner", { sliceStatus: "queued" }).request(
    "POST",
    "/sbx_1/versions",
    { ...base, sliceRunId: "arn_slice" },
  );
  assert.equal(queued.status, 409);
  assert.equal(
    ((await queued.json()) as { code: string }).code,
    "slice_not_ready",
  );
  assert.equal(
    (
      await fixture("owner", { corrupt: true }).request(
        "POST",
        "/sbx_1/versions",
        { ...base, sliceRunId: "arn_slice" },
      )
    ).status,
    502,
  );
  assert.equal(
    (
      await fixture("owner", { unparsable: true }).request(
        "POST",
        "/sbx_1/versions",
        { ...base, sliceRunId: "arn_slice" },
      )
    ).status,
    502,
  );
  assert.equal(
    (
      await f.request("POST", "/sbx_1/versions", {
        ...base,
        sliceRunId: "arn_slice",
        proposalId: "bpr_x",
      })
    ).status,
    404,
  );
  // Another bounty's proposal: its spec and price are not this bounty's.
  const elsewhere = await f.request("POST", "/sbx_1/versions", {
    ...base,
    sliceRunId: "arn_slice",
    proposalId: "bpr_other",
  });
  assert.equal(elsewhere.status, 409);
  assert.equal(
    ((await elsewhere.json()) as { code: string }).code,
    "proposal_mismatch",
  );
  assert.equal(f.created.length, 0);
  const spec = await f.request("POST", "/sbx_1/versions", {
    ...base,
    sliceRunId: "arn_slice",
    proposalId: "bpr_1",
    specRevision: 9,
  });
  assert.equal(spec.status, 404);
  assert.equal(
    ((await spec.json()) as { code: string }).code,
    "spec_not_found",
  );
  const mismatch = await f.request("POST", "/sbx_1/versions", {
    ...base,
    sliceRunId: "arn_other",
  });
  assert.equal(mismatch.status, 409);
  assert.equal(
    ((await mismatch.json()) as { code: string }).code,
    "slice_mismatch",
  );
});

test("members read a version without its private source; admins read provenance and replay", async () => {
  const member = await fixture("member").request("GET", "/versions/sbv_1");
  assert.equal(member.status, 200);
  const memberBody = (await member.json()) as { source?: unknown };
  assert.equal(memberBody.source, undefined);
  const admin = await fixture("admin").request("GET", "/versions/sbv_1");
  const adminBody = (await admin.json()) as { source: StoredVersionSource };
  assert.equal(adminBody.source.sliceRunId, "arn_slice");
  assert.equal(adminBody.source.approvedTask.pricing?.amountMinor, 10500);
  assert.equal((await fixture().request("GET", "/versions/sbv_x")).status, 404);
  const replay = await fixture().request("GET", "/versions/sbv_1/replay");
  assert.equal(replay.status, 200);
  const replayBody = (await replay.json()) as {
    ok: boolean;
    sourceCommitSha?: string;
  };
  assert.equal(replayBody.ok, true);
  assert.equal(replayBody.sourceCommitSha, "a".repeat(40));
  const gone = (await (
    await fixture().request("GET", "/versions/sbv_gone/replay")
  ).json()) as { ok: boolean; reason?: string };
  assert.deepEqual([gone.ok, gone.reason], [false, "source_unavailable"]);
  assert.equal(
    (await fixture().request("GET", "/versions/sbv_x/replay")).status,
    404,
  );
  assert.equal(
    (await fixture("member").request("GET", "/versions/sbv_1/replay")).status,
    403,
  );
});

test("admins read the files a version's build wrote, as text where it is text", async () => {
  const f = fixture("admin", { built: true });
  const listed = await f.request("GET", "/versions/sbv_1/files");
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("Cache-Control"), "no-store");
  const list = (await listed.json()) as {
    run: { id: string; status: string } | null;
    files: { path: string; sizeBytes: number; sha256: string }[];
  };
  assert.deepEqual(list.run, { id: "arn_build", status: "succeeded" });
  assert.deepEqual(
    list.files.map(({ path }) => path),
    builtFiles.map(({ path }) => path),
  );
  // Storage keys stay on the server.
  assert.equal(JSON.stringify(list).includes("runs/arn_build"), false);

  const read = async (path: string) => {
    const response = await f.request(
      "GET",
      `/versions/sbv_1/files/content?path=${encodeURIComponent(path)}`,
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        text?: string | null;
        omitted?: string | null;
        sizeBytes?: number;
      },
    };
  };
  const source = await read("project/src/index.ts");
  assert.equal(source.status, 200);
  assert.deepEqual(
    [source.body.text, source.body.omitted],
    ["export const sum = 1;\n", null],
  );
  // Hidden tests are part of the private sandbox an admin reads.
  assert.equal(
    (await read("private/hidden.test.ts")).body.text,
    "test('hidden', () => {});\n",
  );
  assert.deepEqual([(await read("project/logo.png")).body.omitted], ["binary"]);
  const huge = await read("project/huge.json");
  assert.deepEqual(
    [huge.body.text, huge.body.omitted, huge.body.sizeBytes],
    [null, "too_large", 1_000_001],
  );
  // Only a path the run recorded; nothing is joined into a storage key.
  assert.equal((await read("project/../private/hidden.test.ts")).status, 404);
  assert.equal((await read("")).status, 400);
});

test("a build still running shows the project it generated, as provisional", async () => {
  const f = fixture("owner", { built: true, previewing: true });
  const list = (await (
    await f.request("GET", "/versions/sbv_1/files")
  ).json()) as {
    run: { status: string };
    files: { path: string }[];
    provisional: boolean;
  };
  assert.equal(list.run.status, "running");
  assert.equal(list.provisional, true);
  assert.ok(list.files.length > 0);
  assert.ok(list.files.every(({ path }) => path.startsWith("project/")));
  assert.equal(JSON.stringify(list).includes("runs/arn_build"), false);
  const source = await f.request(
    "GET",
    "/versions/sbv_1/files/content?path=project%2Fsrc%2Findex.ts",
  );
  assert.equal(
    ((await source.json()) as { text: string }).text,
    "export const sum = 1;\n",
  );
  // What it has not written yet is not there.
  assert.equal(
    (
      await f.request(
        "GET",
        "/versions/sbv_1/files/content?path=private%2Fhidden.test.ts",
      )
    ).status,
    404,
  );
});

test("a version's files are for admins, and empty until it is built", async () => {
  const member = fixture("member", { built: true });
  assert.equal(
    (await member.request("GET", "/versions/sbv_1/files")).status,
    403,
  );
  assert.equal(
    (
      await member.request(
        "GET",
        "/versions/sbv_1/files/content?path=project%2Fsrc%2Findex.ts",
      )
    ).status,
    403,
  );
  const unbuilt = await fixture().request("GET", "/versions/sbv_1/files");
  assert.deepEqual(await unbuilt.json(), {
    run: null,
    files: [],
    provisional: false,
  });
  assert.equal(
    (
      await fixture().request(
        "GET",
        "/versions/sbv_1/files/content?path=project%2Fsrc%2Findex.ts",
      )
    ).status,
    404,
  );
  assert.equal(
    (await fixture().request("GET", "/versions/sbv_x/files")).status,
    404,
  );
  assert.equal(
    (
      await fixture("owner", { built: true }).request(
        "GET",
        "/versions/sbv_1/files",
        undefined,
        "org_2",
      )
    ).status,
    404,
  );
});

test("draft changes rehash the transform and recompute the scope; frozen versions refuse", async () => {
  const f = fixture();
  const titled = await f.request("PATCH", "/versions/sbv_1", {
    title: "Renamed",
  });
  assert.equal(titled.status, 200);
  assert.deepEqual(f.patches[0], { title: "Renamed" });
  const choices = await f.request("PATCH", "/versions/sbv_1", {
    dependencyChoices: { pg: "approved-package" },
  });
  assert.equal(choices.status, 200);
  const patch = f.patches[1] as {
    transformConfigSha256: string;
    expectedTransformConfigSha256: string;
    scope: { dependencies: { resolution: string }[] };
    aliasRules: unknown[];
  };
  assert.equal(patch.scope.dependencies[0]?.resolution, "approved-package");
  // Merged onto the transform as read; the store refuses it if that moved.
  assert.equal(patch.expectedTransformConfigSha256, "1".repeat(64));
  assert.equal(
    patch.transformConfigSha256,
    transformConfigHash({
      aliasRules: [],
      dependencyChoices: { pg: "approved-package" },
      acceptanceTests: [],
    }),
  );
  assert.deepEqual(patch.aliasRules, []);
  assert.equal((await f.request("PATCH", "/versions/sbv_1", {})).status, 400);
  const typo = await f.request("PATCH", "/versions/sbv_1", {
    dependencyChoices: { pgg: "runtime-mock" },
  });
  assert.equal(typo.status, 400);
  assert.deepEqual(
    ((await typo.json()) as { code: string; names: string[] }).names,
    ["pgg"],
  );
  assert.equal(
    (
      await f.request("PATCH", "/versions/sbv_1", {
        aliasRules: [{ before: "A", after: "A", kind: "identifier" }],
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request("PATCH", "/versions/sbv_x", { title: "x" })).status,
    404,
  );
  assert.equal(
    (
      await fixture("member").request("PATCH", "/versions/sbv_1", {
        title: "x",
      })
    ).status,
    403,
  );
  const frozen = await fixture("owner", { frozen: true }).request(
    "PATCH",
    "/versions/sbv_1",
    { title: "x" },
  );
  assert.equal(frozen.status, 409);
  assert.equal(((await frozen.json()) as { code: string }).code, "frozen");
  const raced = await fixture("owner", { conflict: true }).request(
    "PATCH",
    "/versions/sbv_1",
    { acceptanceTests: [] },
  );
  assert.equal(raced.status, 409);
  assert.equal(
    ((await raced.json()) as { code: string }).code,
    "version_changed",
  );
  assert.equal(
    (
      await fixture("owner", { corrupt: true }).request(
        "PATCH",
        "/versions/sbv_1",
        { dependencyChoices: {} },
      )
    ).status,
    502,
  );
});

test("a build queues a run carrying every hash and records it on the draft", async () => {
  const f = fixture();
  const response = await f.request("POST", "/versions/sbv_1/build");
  assert.equal(response.status, 202);
  assert.equal(
    ((await response.json()) as { run: StoredAnalysisRun }).run.id,
    "arn_build",
  );
  assert.deepEqual(f.enqueued[0], {
    snapshotId: "rsn_1",
    tool: "sandbox_build",
    params: {
      // Long enough for an agent to write hidden tests.
      deadlineMinutes: 60,
      sliceRunId: "arn_slice",
      sandboxVersionId: "sbv_1",
      manifestSha256: sha(manifestText),
      contractSha256: sha(contractText),
      transformConfigSha256: "1".repeat(64),
      approvedTaskSha256: "2".repeat(64),
      // The organization's names, then its repository's, once each.
      vocabulary: ["acme-corp", "acme", "ghr-1"],
      // The snapshot's data model, for an agent writing fixtures.
      dataModelRunId: "arn_model",
    },
    requestedBy: "user_1",
    maxActive: 3,
  });
  // A snapshot with none names none.
  const bare = fixture("owner", { noDataModel: true });
  await bare.request("POST", "/versions/sbv_1/build");
  const queued = bare.enqueued[0] as { params: Record<string, unknown> };
  assert.equal("dataModelRunId" in queued.params, false);
  assert.deepEqual(f.builds[0], {
    versionId: "sbv_1",
    runId: "arn_build",
    expected: "1".repeat(64),
  });
  assert.deepEqual(f.removed, ["logs/old.log"]);
  assert.equal(f.launches(), 1);
  assert.equal(
    (await fixture("member").request("POST", "/versions/sbv_1/build")).status,
    403,
  );
  assert.equal((await f.request("POST", "/versions/sbv_x/build")).status, 404);
  assert.equal(
    (
      await fixture("owner", { frozen: true }).request(
        "POST",
        "/versions/sbv_1/build",
      )
    ).status,
    409,
  );
  const task = await fixture("owner", { noSpec: true }).request(
    "POST",
    "/versions/sbv_1/build",
  );
  assert.equal(task.status, 409);
  assert.equal(
    ((await task.json()) as { code: string }).code,
    "task_not_ready",
  );
  const blocked = await fixture("owner", { blocked: true }).request(
    "POST",
    "/versions/sbv_1/build",
  );
  assert.equal(
    ((await blocked.json()) as { code: string }).code,
    "scope_blocked",
  );
  const limit = await fixture("owner", { limit: true }).request(
    "POST",
    "/versions/sbv_1/build",
  );
  assert.equal(limit.status, 409);
  assert.equal(((await limit.json()) as { code: string }).code, "run_limit");
  const moved = await fixture("owner", { recordFails: true }).request(
    "POST",
    "/versions/sbv_1/build",
  );
  assert.equal(moved.status, 409);
  assert.equal(
    ((await moved.json()) as { code: string }).code,
    "version_changed",
  );
});

test("a version copies a fixtures run's set into its transform, checked against the slice", async () => {
  const f = fixture("owner", { seam: true });
  const body = {
    sliceRunId: "arn_slice",
    title: "Fix it",
    specSummary: "Summary",
    complexity: "M",
    proposalId: "bpr_1",
    fixtureRunId: "arn_fixtures",
  };
  const response = await f.request("POST", "/sbx_1/versions", body);
  assert.equal(response.status, 201);
  const input = f.created[0] as {
    source: { fixtures: unknown; transformConfigSha256: string };
  };
  const fixtures = {
    fixtureRunId: "arn_fixtures",
    fixtures: [seamFixture],
    scenario: "console.log(1);",
  };
  assert.deepEqual(input.source.fixtures, fixtures);
  assert.equal(
    input.source.transformConfigSha256,
    transformConfigHash({
      aliasRules: [],
      dependencyChoices: {},
      acceptanceTests: [],
      fixtures,
    }),
  );
  assert.notEqual(
    transformConfigHash({
      aliasRules: [],
      dependencyChoices: {},
      acceptanceTests: [],
    }),
    input.source.transformConfigSha256,
  );
  for (const [fixtureRunId, status, code] of [
    ["arn_missing", 404, undefined],
    ["arn_graph", 404, undefined],
    ["arn_fixtures_running", 409, "fixtures_not_ready"],
    ["arn_fixtures_elsewhere", 409, "fixtures_mismatch"],
    ["arn_fixtures_bad", 502, "artifacts_unavailable"],
    ["arn_fixtures_gone", 502, "artifacts_unavailable"],
  ] as const) {
    const refused = await f.request("POST", "/sbx_1/versions", {
      ...body,
      fixtureRunId,
    });
    assert.equal(refused.status, status, fixtureRunId);
    if (code !== undefined)
      assert.equal(((await refused.json()) as { code: string }).code, code);
  }
  // Without the cut module, the same fixtures name nothing the slice mocks.
  const plain = await fixture().request("POST", "/sbx_1/versions", body);
  assert.equal(plain.status, 400);
  assert.equal(
    ((await plain.json()) as { code: string }).code,
    "fixtures_invalid",
  );
});

test("a draft copies, writes or drops fixtures, and a changed set rehashes the transform", async () => {
  const f = fixture("owner", { seam: true });
  assert.equal(
    (
      await f.request("PATCH", "/versions/sbv_1", {
        fixtureRunId: "arn_fixtures",
      })
    ).status,
    200,
  );
  const copied = f.patches[0] as {
    fixtures: { fixtureRunId: string };
    transformConfigSha256: string;
    expectedTransformConfigSha256: string;
  };
  assert.equal(copied.fixtures.fixtureRunId, "arn_fixtures");
  assert.equal(copied.expectedTransformConfigSha256, "1".repeat(64));
  await f.request("PATCH", "/versions/sbv_1", {
    fixtures: { fixtures: [seamFixture], scenario: null },
  });
  assert.deepEqual((f.patches[1] as { fixtures: unknown }).fixtures, {
    fixtureRunId: null,
    fixtures: [seamFixture],
    scenario: null,
  });
  await f.request("PATCH", "/versions/sbv_1", { fixtureRunId: null });
  const dropped = f.patches[2] as {
    fixtures: unknown;
    transformConfigSha256: string;
  };
  assert.equal(dropped.fixtures, null);
  assert.equal(
    dropped.transformConfigSha256,
    transformConfigHash({
      aliasRules: [],
      dependencyChoices: {},
      acceptanceTests: [],
      fixtures: null,
    }),
  );
  // A title change leaves the fixtures alone.
  await f.request("PATCH", "/versions/sbv_1", { title: "Renamed" });
  assert.equal("fixtures" in (f.patches[3] as object), false);
  assert.equal(
    (
      await f.request("PATCH", "/versions/sbv_1", {
        fixtureRunId: "arn_fixtures",
        fixtures: { fixtures: [], scenario: null },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("PATCH", "/versions/sbv_1", {
        fixtureRunId: "arn_fixtures_elsewhere",
      })
    ).status,
    409,
  );
  const invalid = await fixture().request("PATCH", "/versions/sbv_1", {
    fixtures: { fixtures: [seamFixture], scenario: null },
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    ((await invalid.json()) as { code: string }).code,
    "fixtures_invalid",
  );
  const unreadable = await fixture("owner", { corrupt: true }).request(
    "PATCH",
    "/versions/sbv_1",
    { fixtureRunId: "arn_fixtures" },
  );
  assert.equal(unreadable.status, 502);
});

test("hashed but malformed nested slice artifacts and unsupported versions are unavailable", async () => {
  for (const overrides of [
    { manifest: { ...manifest, schemaVersion: 2 } },
    {
      manifest: {
        ...manifest,
        included: [{ ...manifest.included[0], path: 12 }],
      },
    },
    {
      contract: {
        ...contract,
        outbound: [{ module: "lib/db.ts", symbols: null }],
      },
    },
    { contract: { ...contract, schemaVersion: 2 } },
  ]) {
    const response = await fixture("owner", overrides).request(
      "POST",
      "/sbx_1/versions",
      {
        sliceRunId: "arn_slice",
        title: "Draft",
        specSummary: "Summary",
        complexity: "M",
        tags: [],
        aliasRules: [],
        dependencyChoices: {},
        acceptanceTests: [],
      },
    );
    assert.equal(response.status, 502);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "artifacts_unavailable",
    );
  }
});

/** A generated version: the starter run where the slice was. */
const generatedSource: StoredVersionSource = {
  ...source,
  sandboxVersionId: "sbv_gen",
  origin: "starter",
  sourceSnapshotId: null,
  sourceCommitSha: null,
  sliceRunId: null,
  manifestSha256: null,
  contractSha256: null,
  starterRunId: "arn_starter",
  buildRunId: "arn_starter",
};
const starterRun: StoredAnalysisRun = {
  ...sliceRun,
  id: "arn_starter",
  snapshotId: null,
  repoId: null,
  tool: "sandbox_starter",
  toolVersion: "sandbox_starter@1",
  status: "queued",
  params: {
    deadlineMinutes: 60,
    agent: "starter",
    sandboxVersionId: "sbv_gen",
    approvedTaskSha256: "2".repeat(64),
    stack: ["TypeScript"],
  },
};

function starterFixture(
  role = "owner",
  overrides: Partial<{
    sandbox: Partial<StoredSandbox> | null;
    bounty: Record<string, unknown> | null;
    /** The workspace's repositories; one TypeScript source by default. */
    repos: GithubRepoSummary[];
    proposal: boolean;
    /** The repositories its proposal says the work touches; none unless said. */
    touched: string[];
    /** Approved unless said: a draft proposal is not generated from. */
    proposalStatus: "proposed" | "approved";
    limit: boolean;
    created: "ok" | "source_linked" | "not-found" | "starter_in_progress";
    /** The newest version's starter run, still under way. */
    inFlight: boolean;
    /** What the bounty's sources hold, as `heldContext` reads it. */
    context: unknown;
  }> = {},
) {
  const enqueued: { snapshotId: string | null; input: unknown }[] = [];
  const created: { sandboxId: string; input: unknown }[] = [];
  const patches: unknown[] = [];
  const removed: string[] = [];
  let launches = 0;
  const bare = { ...sandbox, sourceRepoId: null };
  const stored = {
    version: { ...version, id: "sbv_gen" },
    source: generatedSource,
  };
  const options = {
    sandboxes: {
      create: async (
        owner: string,
        input: { bountyId: string; sourceRepoId: string | null },
      ) => ({
        ok: true,
        sandbox: { ...bare, organizationId: owner, ...input },
      }),
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbx_1" && overrides.sandbox !== null
          ? { ...bare, ...overrides.sandbox }
          : null,
      createVersion: async (
        _owner: string,
        sandboxId: string,
        input: { id: string },
      ) => {
        created.push({ sandboxId, input });
        const result = overrides.created ?? "ok";
        return result === "ok"
          ? {
              ok: true,
              version: { ...version, id: input.id, version: 2 },
              source: { ...generatedSource, sandboxVersionId: input.id },
            }
          : { ok: false, reason: result };
      },
      listVersions: async () =>
        overrides.inFlight === true ? [stored.version] : [],
      getVersion: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbv_gen" ? stored : null,
      updateDraft: async (_owner: string, _id: string, patch: unknown) => {
        patches.push(patch);
        return { ok: true, ...stored };
      },
      replayContext: async () => ({
        source: generatedSource,
        snapshot: null,
        sliceRun: null,
      }),
    },
    runs: {
      get: async (_owner: string, id: string) =>
        overrides.inFlight === true && id === starterRun.id
          ? { ...starterRun, status: "running" }
          : null,
      enqueue: async (
        _owner: string,
        snapshotId: string | null,
        input: { params: { sandboxVersionId: string } },
      ) => {
        enqueued.push({ snapshotId, input });
        return overrides.limit === true
          ? { ok: false, reason: "run_limit" }
          : {
              ok: true,
              created: true,
              run: {
                ...starterRun,
                params: { ...starterRun.params, ...input.params },
              },
              obsoleteLogKey: "logs/old.log",
            };
      },
    },
    artifacts: { list: async () => [] },
    objects: {
      get: async () => undefined,
      remove: async (key: string) => {
        removed.push(key);
      },
    },
    bounties: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "bty_1" && overrides.bounty !== null
          ? {
              id: "bty_1",
              title: "Sum a cart",
              description: "The cart adds up its prices.",
              stack: ["Zod"],
              version: 1,
              approval: { version: 1, approvedBy: "user_1", approvedAt: stamp },
              ...overrides.bounty,
            }
          : null,
    },
    repos: {
      list: async (owner: string) =>
        owner !== "org_1"
          ? []
          : (overrides.repos ?? [
              workspaceRepo("ghr_1", { stack: ["TypeScript"] }),
            ]),
    },
    proposals: {
      liveForBounty: async () =>
        overrides.proposal === false ? null : "bpr_1",
      get: async (_owner: string, id: string) =>
        id === "bpr_1"
          ? {
              id,
              bountyId: "bty_1",
              revision: 3,
              complexity: "M",
              amountMinor: 10500,
              currency: "USD",
              status: overrides.proposalStatus ?? "approved",
              decidedAt:
                overrides.proposalStatus === "proposed"
                  ? null
                  : "2026-10-02T00:00:00.000Z",
              specRevision: 2,
              repositories: (overrides.touched ?? []).map((repoId) => ({
                repoId,
                snapshotId: `rsn_${repoId}`,
              })),
            }
          : null,
    },
    specs: {
      get: async (_owner: string, proposalId: string, revision: number) =>
        proposalId === "bpr_1" && revision === 2
          ? {
              revision,
              specHash: "s".repeat(64),
              draft: source.approvedTask.spec?.draft,
            }
          : null,
    },
    ensureWorker: async () => {
      launches++;
    },
    ...(overrides.context === undefined
      ? {}
      : { contextFor: async () => overrides.context }),
    now: () => new Date(stamp),
  } as unknown as SandboxRouteOptions;
  const app = new Hono<{ Variables: AuthVariables }>();
  // As `requireMembership` does: the owner is the path's, so a request for
  // another workspace reads that workspace's rows, of which there are none.
  app.use("/api/v1/orgs/:orgId/*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    c.set("member", {
      role,
      organizationId: c.req.param("orgId"),
    } as never);
    await next();
  });
  mountSandboxRoutes(app, options);
  const request = (method: string, path: string, body?: unknown) =>
    app.request(`/api/v1/orgs/org_1/sandboxes${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  return {
    request,
    enqueued,
    created,
    patches,
    removed,
    launches: () => launches,
  };
}

test("a sandbox with no repository has a version generated from its bounty, by an admin", async () => {
  const f = starterFixture();
  const response = await f.request("POST", "/sbx_1/starter");
  assert.equal(response.status, 202);
  const body = (await response.json()) as {
    version: { id: string };
    source: { origin: string; starterRunId: string };
    run: { tool: string; snapshotId: string | null };
  };
  assert.equal(body.source.origin, "starter");
  assert.equal(body.run.tool, "sandbox_starter");
  assert.equal(body.run.snapshotId, null);
  // The run is queued first, with no snapshot, naming the version to come.
  const queued = f.enqueued[0];
  assert.equal(queued?.snapshotId, null);
  const params = queued?.input as {
    tool: string;
    params: {
      agent: string;
      sandboxVersionId: string;
      approvedTaskSha256: string;
      stack: string[];
    };
  };
  assert.equal(params.tool, "sandbox_starter");
  assert.equal(params.params.agent, "starter");
  // The repositories' detected stack, then what the bounty adds.
  assert.deepEqual(params.params.stack, ["TypeScript", "Zod"]);
  const made = f.created[0]?.input as {
    id: string;
    title: string;
    specSummary: string;
    complexity: string;
    tags: string[];
    source: {
      origin: string;
      starterRunId: string;
      approvedTask: ApprovedTaskSnapshot;
      approvedTaskSha256: string;
      transformConfigSha256: string;
      acceptanceTests: unknown[];
    };
  };
  assert.equal(made.id, params.params.sandboxVersionId);
  assert.equal(body.version.id, made.id);
  assert.equal(made.source.origin, "starter");
  assert.equal(made.source.starterRunId, "arn_starter");
  assert.equal(made.title, "Sum a cart");
  assert.equal(made.specSummary, "The cart adds up its prices.");
  assert.equal(made.complexity, "M");
  assert.deepEqual(made.tags, ["TypeScript", "Zod"]);
  // The task is the bounty's own text, with its live proposal's spec and price.
  assert.equal(made.source.approvedTask.title, "Sum a cart");
  assert.equal(
    made.source.approvedTask.summary,
    "The cart adds up its prices.",
  );
  assert.equal(made.source.approvedTask.bountyId, "bty_1");
  assert.equal(made.source.approvedTask.spec?.specRevision, 2);
  assert.equal(made.source.approvedTask.pricing?.status, "approved");
  assert.equal(
    made.source.approvedTaskSha256,
    approvedTaskHash(made.source.approvedTask),
  );
  assert.equal(
    params.params.approvedTaskSha256,
    made.source.approvedTaskSha256,
  );
  assert.equal(
    made.source.transformConfigSha256,
    transformConfigHash({
      aliasRules: [],
      dependencyChoices: {},
      acceptanceTests: [],
    }),
  );
  assert.deepEqual(f.removed, ["logs/old.log"]);
  assert.equal(f.launches(), 1);
});

test("a generated version follows the stack of the repositories its work touches, else of any", async () => {
  const repos = [
    workspaceRepo("ghr_1", { stack: ["TypeScript", "React"] }),
    workspaceRepo("ghr_2", { stack: ["typescript", "Postgres"] }),
    workspaceRepo("ghr_gone", { stack: ["Go"], syncStatus: "gone" }),
  ];
  const stackOf = async (touched: string[]) => {
    const f = starterFixture("admin", {
      repos,
      touched,
      bounty: { stack: ["Zod"] },
    });
    assert.equal((await f.request("POST", "/sbx_1/starter")).status, 202);
    return (f.enqueued[0]?.input as { params: { stack: string[] } }).params
      .stack;
  };
  // A frontend-free bounty is not written in the frontend's stack.
  assert.deepEqual(await stackOf(["ghr_2"]), [
    "TypeScript",
    "PostgreSQL",
    "Zod",
  ]);
  // One it touches that is no longer connected is not one it is done in;
  // with none of them left, it is any of the workspace's.
  assert.deepEqual(await stackOf(["ghr_2", "ghr_gone"]), [
    "TypeScript",
    "PostgreSQL",
    "Zod",
  ]);
  assert.deepEqual(await stackOf(["ghr_gone", "ghr_old"]), [
    "TypeScript",
    "React",
    "PostgreSQL",
    "Zod",
  ]);
});

test("a generated version follows the stack of every repository the workspace has connected", async () => {
  const f = starterFixture("admin", {
    repos: [
      workspaceRepo("ghr_1", { stack: ["TypeScript", "React"] }),
      workspaceRepo("ghr_2", { stack: ["typescript", "Postgres"] }),
      workspaceRepo("ghr_3", { stack: null }),
      // Neither is one a bounty's work may touch.
      workspaceRepo("ghr_gone", { stack: ["Go"], syncStatus: "gone" }),
      workspaceRepo("ghr_pub", { stack: ["Rust"], role: "sandbox" }),
    ],
    bounty: { stack: ["Zod", "React"] },
  });
  const response = await f.request("POST", "/sbx_1/starter");
  assert.equal(response.status, 202);
  const params = f.enqueued[0]?.input as { params: { stack: string[] } };
  // Each once, under the catalog's names, the bounty's own after.
  assert.deepEqual(params.params.stack, [
    "TypeScript",
    "React",
    "PostgreSQL",
    "Zod",
  ]);
});

test("a generated version keeps its listing within bounds", async () => {
  const f = starterFixture("admin", {
    repos: [],
    bounty: {
      title: `  ${"t".repeat(130)}  `,
      description: "d".repeat(5_000),
      stack: ["TypeScript", "A name far too long to be a listing tag"],
    },
  });
  const response = await f.request("POST", "/sbx_1/starter");
  assert.equal(response.status, 202);
  const made = f.created[0]?.input as {
    title: string;
    specSummary: string;
    complexity: string;
    tags: string[];
    source: { approvedTask: ApprovedTaskSnapshot };
  };
  assert.equal(made.title.length, 120);
  assert.equal(made.specSummary.length, 4_000);
  assert.equal(made.complexity, "M");
  assert.deepEqual(made.tags, ["TypeScript"]);
  // The full description is the task; only the listing is cut.
  assert.equal(made.source.approvedTask.summary.length, 5_000);
});

test("generating is refused for members, a linked sandbox, an off-Node or empty stack, an empty bounty and one not approved", async () => {
  const cases: [ReturnType<typeof starterFixture>, number, string | null][] = [
    [starterFixture("member"), 403, null],
    [starterFixture("owner", { sandbox: null }), 404, null],
    [starterFixture("owner", { bounty: null }), 404, null],
    [
      starterFixture("owner", { sandbox: { sourceRepoId: "ghr_1" } }),
      409,
      "source_linked",
    ],
    [
      starterFixture("owner", {
        repos: [workspaceRepo("ghr_1", { stack: ["Python"] })],
        bounty: { stack: ["Django"] },
      }),
      409,
      "stack_unsupported",
    ],
    [
      starterFixture("owner", { repos: [], bounty: { stack: [] } }),
      409,
      "stack_empty",
    ],
    [
      starterFixture("owner", { bounty: { description: "  " } }),
      409,
      "task_not_ready",
    ],
    // A bounty with no proposal, a draft one, or a scope not approved is
    // not generated from.
    [starterFixture("owner", { proposal: false }), 409, "step_held"],
    [starterFixture("owner", { proposalStatus: "proposed" }), 409, "step_held"],
    [starterFixture("owner", { bounty: { approval: null } }), 409, "step_held"],
    [starterFixture("owner", { limit: true }), 409, "run_limit"],
    [
      starterFixture("owner", { created: "source_linked" }),
      409,
      "source_linked",
    ],
    [starterFixture("owner", { created: "not-found" }), 404, null],
    // One version is generated at a time: a second Generate, a double
    // click, is refused while the first is under way, before or under the
    // store's lock.
    [starterFixture("owner", { inFlight: true }), 409, "starter_in_progress"],
    [
      starterFixture("owner", { created: "starter_in_progress" }),
      409,
      "starter_in_progress",
    ],
  ];
  for (const [f, status, code] of cases) {
    const response = await f.request("POST", "/sbx_1/starter");
    assert.equal(response.status, status);
    if (code !== null)
      assert.equal(((await response.json()) as { code: string }).code, code);
  }
  // Nothing was queued for a refusal before the run.
  assert.equal(cases[3]?.[0].enqueued.length, 0);
  assert.equal(cases[13]?.[0].enqueued.length, 0);
});

test("a generated version changes its listing, but not its transform or build, and has nothing to replay", async () => {
  const f = starterFixture();
  const read = (await (await f.request("GET", "/versions/sbv_gen")).json()) as {
    source: { origin: string; sliceRunId: string | null; starterRunId: string };
  };
  assert.equal(read.source.origin, "starter");
  assert.equal(read.source.sliceRunId, null);
  assert.equal(read.source.starterRunId, "arn_starter");
  assert.equal(
    (await f.request("PATCH", "/versions/sbv_gen", { title: "Renamed" }))
      .status,
    200,
  );
  for (const change of [
    { acceptanceTests: [] },
    { aliasRules: [] },
    { dependencyChoices: {} },
    { fixtureRunId: null },
  ]) {
    const refused = await f.request("PATCH", "/versions/sbv_gen", change);
    assert.equal(refused.status, 409);
    assert.equal(
      ((await refused.json()) as { code: string }).code,
      "generated_version",
    );
  }
  assert.equal(f.patches.length, 1);
  const build = await f.request("POST", "/versions/sbv_gen/build");
  assert.equal(build.status, 409);
  assert.equal(
    ((await build.json()) as { code: string }).code,
    "generated_version",
  );
  assert.equal(f.enqueued.length, 0);
  const replay = (await (
    await f.request("GET", "/versions/sbv_gen/replay")
  ).json()) as { ok: boolean; detail: string };
  assert.equal(replay.ok, false);
  assert.match(replay.detail, /generated, not sliced/);
});

test("a generated version freezes the context its bounty holds into its task", async () => {
  const jira = {
    key: "APP-1",
    issueType: "Story",
    status: null,
    statusCategory: null,
    priority: "High",
    labels: [],
    components: [],
    fixVersions: [],
    parentKey: null,
    dueDate: null,
    storyPoints: 3,
    originalEstimateSeconds: null,
    remainingEstimateSeconds: null,
    votes: null,
    watchers: null,
    subtaskCount: 0,
    links: [],
    updated: null,
  };
  const f = starterFixture("owner", {
    context: {
      jira: { version: 2, content: jira, ref: "APP-1" },
      github: null,
    },
  });
  const response = await f.request("POST", "/sbx_1/starter");
  assert.equal(response.status, 202);
  const input = f.created[0]?.input as {
    source: {
      approvedTask: { context?: unknown };
      approvedTaskSha256: string;
    };
  };
  // What it said, by version: the starter agent reads it from the task.
  assert.deepEqual(input.source.approvedTask.context, {
    jira: { version: 2, content: jira },
    github: null,
  });
  // And the task's hash covers it, as it covers the rest of the task.
  const without = starterFixture();
  await without.request("POST", "/sbx_1/starter");
  const plain = without.created[0]?.input as {
    source: { approvedTask: { context?: unknown }; approvedTaskSha256: string };
  };
  assert.deepEqual(plain.source.approvedTask.context, {
    jira: null,
    github: null,
  });
  assert.notEqual(
    plain.source.approvedTaskSha256,
    input.source.approvedTaskSha256,
  );
});

test("a linked sandbox's slice is its sizing's profile of the approved spec", async () => {
  const read = async (
    overrides: Parameters<typeof fixture>[1],
    id = "sbx_1",
    role = "owner",
  ) => {
    const response = await fixture(role, overrides).request(
      "GET",
      `/${id}/slice`,
    );
    return {
      status: response.status,
      slice: ((await response.json()) as { slice?: Record<string, unknown> })
        .slice,
    };
  };
  assert.deepEqual(await read({ profile: {} }), {
    status: 200,
    slice: {
      status: "ready",
      code: null,
      reason: null,
      specRevision: 2,
      scopeRunId: "arn_scope",
      sliceRunId: "arn_slice",
    },
  });
  assert.equal(
    (await read({ profile: { status: "scoping", sliceRunId: null } })).slice
      ?.status,
    "scoping",
  );
  // Matched by the repository's name once the snapshot has moved on.
  assert.equal(
    (await read({ profile: { snapshotId: "rsn_newer" } })).slice?.status,
    "ready",
  );
  assert.equal(
    (
      await read({
        profile: { snapshotId: "rsn_other", repository: "acme/other" },
      })
    ).slice?.status,
    "none",
  );
  const failed = await read({
    profile: { status: "failed", errorCode: "scope_failed" },
  });
  assert.equal(failed.slice?.status, "failed");
  assert.equal(failed.slice?.code, "scope_failed");
  assert.match(String(failed.slice?.reason), /scope agent/);
  assert.equal((await read({ profile: null })).slice?.status, "none");
  assert.deepEqual(
    (await read({ profile: {} }, "sbx_bare")).slice?.code,
    "no_source",
  );
  assert.deepEqual(
    (await read({ profile: {}, held: "price" })).slice?.code,
    "task_not_ready",
  );
  // Without the profiler, nothing is sliced from here.
  assert.equal((await read({})).slice?.code, "unconfigured");
  assert.equal((await read({ profile: {} }, "sbx_1", "member")).status, 403);
  assert.equal((await read({ profile: {} }, "sbx_x")).status, 404);
});

test("slicing asks for the sizing's profile until its slice is ready", async () => {
  const none = fixture("owner", { profile: null, bounty: true });
  const asked = await none.request("POST", "/sbx_1/slice");
  assert.equal(asked.status, 202);
  assert.deepEqual(none.requested, [
    {
      owner: "org_1",
      input: {
        proposalId: "bpr_1",
        specRevision: 2,
        specHash: "s".repeat(64),
        snapshotId: "rsn_1",
      },
    },
  ]);
  assert.deepEqual(await asked.json(), {
    slice: {
      status: "none",
      code: null,
      reason: null,
      specRevision: 2,
      scopeRunId: null,
      sliceRunId: null,
    },
    version: null,
    source: null,
    run: null,
  });

  const scoping = fixture("owner", {
    profile: { status: "scoping", sliceRunId: null },
    bounty: true,
  });
  const waiting = await scoping.request("POST", "/sbx_1/slice");
  assert.equal(waiting.status, 202);
  assert.equal(
    ((await waiting.json()) as { slice: { status: string } }).slice.status,
    "scoping",
  );
  assert.deepEqual(scoping.requested, []);
  // Remembered as the asker's, for the cutter once the slice is ready.
  assert.deepEqual(scoping.cuts, [
    { asked: "sbx_1", owner: "org_1", actor: "user_1" },
  ]);
  assert.deepEqual(scoping.created, []);
  assert.deepEqual(scoping.enqueued, []);

  const failed = await fixture("owner", {
    profile: { status: "failed", errorCode: "slice_failed" },
    bounty: true,
  }).request("POST", "/sbx_1/slice");
  assert.equal(failed.status, 409);
  assert.equal(
    ((await failed.json()) as { code: string }).code,
    "slice_failed",
  );
  const bare = await fixture("owner", { profile: {}, bounty: true }).request(
    "POST",
    "/sbx_bare/slice",
  );
  assert.equal(((await bare.json()) as { code: string }).code, "no_source");
  const held = await fixture("owner", { profile: {}, held: "price" }).request(
    "POST",
    "/sbx_1/slice",
  );
  assert.equal(held.status, 409);
  assert.equal(((await held.json()) as { code: string }).code, "step_held");
  assert.equal(
    (
      await fixture("member", { profile: {}, bounty: true }).request(
        "POST",
        "/sbx_1/slice",
      )
    ).status,
    403,
  );
});

test("a ready slice is cut into a draft from the bounty and built", async () => {
  const f = fixture("owner", { profile: {}, bounty: true, noVersions: true });
  const response = await f.request("POST", "/sbx_1/slice");
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    slice: { status: string };
    version: { id: string };
    source: { sliceRunId: string };
    run: { id: string };
  };
  assert.equal(body.slice.status, "ready");
  assert.equal(body.version.id, "sbv_1");
  assert.equal(body.source.sliceRunId, "arn_slice");
  assert.equal(body.run.id, "arn_build");
  const input = f.created[0] as {
    title: string;
    specSummary: string;
    complexity: string;
    tags: string[];
    source: {
      sliceRunId: string;
      approvedTask: ApprovedTaskSnapshot;
      proposalVersion: number | null;
    };
  };
  // One trimmed line, and the title again for a bounty with no description.
  assert.equal(input.title, "Fix the login");
  assert.equal(input.specSummary, "Fix the login");
  assert.equal(input.complexity, "M");
  assert.deepEqual(input.tags, ["TypeScript"]);
  assert.equal(input.source.sliceRunId, "arn_slice");
  assert.equal(input.source.approvedTask.spec?.specRevision, 2);
  assert.equal(input.source.approvedTask.pricing?.status, "approved");
  assert.deepEqual(
    (f.enqueued[0] as { tool: string; params: { sliceRunId: string } }).tool,
    "sandbox_build",
  );
  assert.deepEqual(f.builds[0], {
    versionId: "sbv_1",
    runId: "arn_build",
    expected: "1".repeat(64),
  });

  // A request remembered while the slice was in flight is answered.
  assert.deepEqual(f.cuts, [{ cleared: "sbx_1", owner: "org_1" }]);

  // Unless the cap refuses the build: the draft is cut, and the request
  // stays for the cutter's next pass to build it.
  const capped = fixture("owner", {
    profile: {},
    bounty: true,
    noVersions: true,
    limit: true,
  });
  const refused = await capped.request("POST", "/sbx_1/slice");
  assert.equal(((await refused.json()) as { code: string }).code, "run_limit");
  assert.equal(capped.created.length, 1);
  assert.deepEqual(capped.cuts, []);

  // The newest draft cut from the same slice is built again, not cut twice.
  const again = fixture("owner", { profile: {}, bounty: true });
  assert.equal((await again.request("POST", "/sbx_1/slice")).status, 201);
  assert.deepEqual(again.created, []);
  assert.equal(again.enqueued.length, 1);

  // One cut from another slice is not: a new draft is cut, which the
  // store refuses here for a slice of another repository.
  const other = fixture("owner", {
    profile: { sliceRunId: "arn_other" },
    bounty: true,
  });
  const mismatch = await other.request("POST", "/sbx_1/slice");
  assert.equal(other.created.length, 1);
  assert.equal(
    ((await mismatch.json()) as { code: string }).code,
    "slice_mismatch",
  );
});

test("two cuts of one slice at once make one draft and one build", async () => {
  // Both read the sandbox's versions before either cut: the cutter's pass
  // and a person's slice, racing.
  const f = fixture("owner", {
    profile: {},
    bounty: true,
    noVersions: true,
    lockedCut: true,
  });
  const responses = await Promise.all([
    f.request("POST", "/sbx_1/slice"),
    f.request("POST", "/sbx_1/slice"),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [201, 201],
  );
  assert.equal(f.created.length, 1);
  // Both build the one draft, which the queue answers with one run.
  assert.deepEqual(
    new Set(
      f.enqueued.map(
        (each) =>
          (each as { params: { sandboxVersionId: string } }).params
            .sandboxVersionId,
      ),
    ),
    new Set(["sbv_1"]),
  );
});

test("a slice with a preparation is cut with its fixtures, and built naming it", async () => {
  const f = fixture("owner", {
    profile: { preparedRunId: "arn_fixtures" },
    bounty: true,
    noVersions: true,
    seam: true,
  });
  const response = await f.request("POST", "/sbx_1/slice");
  assert.equal(response.status, 201);
  const input = f.created[0] as {
    source: { fixtures: { fixtureRunId: string } | null };
  };
  assert.equal(input.source.fixtures?.fixtureRunId, "arn_fixtures");
  const build = f.enqueued[0] as {
    tool: string;
    params: { preparedRunId?: string };
  };
  assert.equal(build.tool, "sandbox_build");
  assert.equal(build.params.preparedRunId, "arn_fixtures");

  // Prepared fixtures that do not fit the slice are left to the build.
  const misfit = fixture("owner", {
    profile: { preparedRunId: "arn_fixtures" },
    bounty: true,
    noVersions: true,
  });
  assert.equal((await misfit.request("POST", "/sbx_1/slice")).status, 201);
  assert.equal(misfit.created.length, 1);
  assert.equal(
    (misfit.created[0] as { source: { fixtures: unknown } }).source.fixtures,
    null,
  );

  // One not yet done is neither attached nor named.
  const running = fixture("owner", {
    profile: { preparedRunId: "arn_fixtures_running" },
    bounty: true,
    noVersions: true,
    seam: true,
  });
  assert.equal((await running.request("POST", "/sbx_1/slice")).status, 201);
  assert.equal(
    (running.created[0] as { source: { fixtures: unknown } }).source.fixtures,
    null,
  );
  assert.equal(
    (running.enqueued[0] as { params: { preparedRunId?: string } }).params
      .preparedRunId,
    undefined,
  );
});

test("a sandbox whose publication is live is not sliced again until unpublished", async () => {
  const live = fixture("owner", {
    profile: {},
    bounty: true,
    publishedUntil: "2026-10-03T00:00:00.000Z",
  });
  const refused = await live.request("POST", "/sbx_1/slice");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: SLICE_PUBLISHED_REASON,
    code: "published",
  });
  assert.deepEqual(live.created, []);
  assert.deepEqual(live.enqueued, []);
  // A publication that has expired, by the routes' clock, holds nothing.
  const expired = fixture("owner", {
    profile: {},
    bounty: true,
    publishedUntil: "2026-10-01T00:00:00.000Z",
  });
  assert.equal((await expired.request("POST", "/sbx_1/slice")).status, 201);
});

test("a slice whose scope has blockers is cut but not built", async () => {
  const f = fixture("owner", {
    profile: {},
    bounty: true,
    noVersions: true,
    blocked: true,
  });
  const response = await f.request("POST", "/sbx_1/slice");
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    source: { scope: { blockers: unknown[] } };
    run: unknown;
  };
  assert.equal(body.run, null);
  assert.equal(body.source.scope.blockers.length, 1);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.enqueued, []);
});

test("a sandbox is made with its first version sliced, when its sizing touches a repository", async () => {
  const f = fixture("owner", { profile: {}, bounty: true, noVersions: true });
  const response = await f.request("POST", "/start", { bountyId: "bty_1" });
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    sandbox: { id: string; sourceRepoId: string | null };
    slice: { status: string };
    version: { id: string };
    run: { id: string };
  };
  // Cut from the one its sizing touches, which nobody picks.
  assert.deepEqual(f.made, [{ bountyId: "bty_1", sourceRepoId: "ghr_1" }]);
  assert.deepEqual(
    [body.sandbox.id, body.sandbox.sourceRepoId],
    ["sbx_1", "ghr_1"],
  );
  assert.equal(body.slice.status, "ready");
  assert.equal(body.version.id, "sbv_1");
  assert.equal(body.run.id, "arn_build");
  assert.equal(f.created.length, 1);

  // A slice its sizing has not taken is asked for; the sandbox is made
  // all the same, to follow it.
  const none = fixture("owner", { profile: null, bounty: true });
  const asked = await none.request("POST", "/start", { bountyId: "bty_1" });
  assert.equal(asked.status, 201);
  const pending = (await asked.json()) as {
    sandbox: { id: string };
    slice: { status: string };
    version: unknown;
    run: unknown;
  };
  assert.equal(pending.sandbox.id, "sbx_1");
  assert.equal(pending.slice.status, "none");
  assert.equal(pending.version, null);
  assert.equal(pending.run, null);
  assert.equal(none.requested.length, 1);

  // A slice that failed is refused once the sandbox is made, which stays.
  const failed = fixture("owner", {
    profile: { status: "failed", errorCode: "slice_failed" },
    bounty: true,
  });
  const refused = await failed.request("POST", "/start", {
    bountyId: "bty_1",
  });
  assert.equal(refused.status, 409);
  assert.equal(
    ((await refused.json()) as { code: string }).code,
    "slice_failed",
  );
  assert.equal(failed.made.length, 1);
});

test("starting a sandbox is an admin's, once per bounty, from its bounty alone", async () => {
  const taken = await fixture().request("POST", "/start", {
    bountyId: "bty_taken",
  });
  assert.equal(taken.status, 409);
  assert.equal(
    ((await taken.json()) as { code: string }).code,
    "bounty_has_sandbox",
  );
  const gone = await fixture().request("POST", "/start", { bountyId: "bty_x" });
  assert.equal(gone.status, 404);
  for (const body of [{ bountyId: "bty_1", sourceRepoId: "ghr_1" }, {}])
    assert.equal((await fixture().request("POST", "/start", body)).status, 400);
  const member = fixture("member", { profile: {}, bounty: true });
  assert.equal(
    (await member.request("POST", "/start", { bountyId: "bty_1" })).status,
    403,
  );
  assert.deepEqual(member.made, []);
});

test("a sandbox is made with its first version generated, when its sizing touches no repository", async () => {
  const f = starterFixture();
  const response = await f.request("POST", "/start", { bountyId: "bty_1" });
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    sandbox: { id: string; sourceRepoId: string | null };
    slice: unknown;
    source: { origin: string };
    run: { tool: string };
  };
  assert.deepEqual(
    [body.sandbox.id, body.sandbox.sourceRepoId],
    ["sbx_1", null],
  );
  assert.equal(body.slice, null);
  assert.equal(body.source.origin, "starter");
  assert.equal(body.run.tool, "sandbox_starter");
  assert.equal(f.created.length, 1);
  assert.equal(f.launches(), 1);

  // A starter refused is said, with the sandbox made.
  const limited = await starterFixture("owner", { limit: true }).request(
    "POST",
    "/start",
    { bountyId: "bty_1" },
  );
  assert.equal(limited.status, 409);
  assert.equal(((await limited.json()) as { code: string }).code, "run_limit");
});
