import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import type {
  StoredAnalysisRun,
  StoredArtifact,
  StoredSandbox,
  StoredSandboxVersion,
  StoredVersionSource,
} from "@sandbox-factory/db";
import { OPERATION_POLICY } from "sandbox-factory";
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

/** What a built version's run wrote, some of it not text or too big to show. */
const builtFiles = [
  { path: "project/src/index.ts", body: "export const sum = 1;\n" },
  { path: "private/hidden.test.ts", body: "test('hidden', () => {});\n" },
  { path: "project/logo.png", body: "\u0000PNG" },
  { path: "project/huge.json", body: "x".repeat(1_000_001) },
];

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
    /** The version has no passing build to publish. */
    unready: boolean;
  }> = {},
) {
  const published: { versionId: string; actor: string }[] = [];
  const manifestText = JSON.stringify(overrides.manifest ?? manifest);
  const contractText = JSON.stringify(overrides.contract ?? contract);
  const created: unknown[] = [];
  const patches: unknown[] = [];
  const builds: unknown[] = [];
  const enqueued: unknown[] = [];
  const removed: string[] = [];
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
        input.bountyId === "bty_x"
          ? { ok: false, reason: "bounty_not_found" }
          : input.bountyId === "bty_taken"
            ? { ok: false, reason: "bounty_has_sandbox" }
            : input.sourceRepoId === "ghr_pub"
              ? { ok: false, reason: "repo_role" }
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
      linkSource: async (owner: string, id: string, sourceRepoId: string) =>
        owner !== "org_1" || id === "sbx_9"
          ? { ok: false, reason: "not-found" }
          : id === "sbx_1" && sourceRepoId !== sandbox.sourceRepoId
            ? { ok: false, reason: "source_linked" }
            : sourceRepoId === "ghr_pub"
              ? { ok: false, reason: "repo_role" }
              : sourceRepoId === "ghr_x"
                ? { ok: false, reason: "repo_not_found" }
                : { ok: true, sandbox: { ...sandbox, id, sourceRepoId } },
      get: async (owner: string, id: string) =>
        owner !== "org_1"
          ? null
          : id === "sbx_1"
            ? sandbox
            : id === "sbx_bare"
              ? { ...sandbox, id: "sbx_bare", sourceRepoId: null }
              : id === "sbx_unlinked"
                ? { ...sandbox, id: "sbx_unlinked" }
                : null,
      createVersion: async (
        _owner: string,
        sandboxId: string,
        input: unknown,
      ) => {
        created.push(input);
        const typed = input as { source: { sliceRunId: string } };
        return typed.source.sliceRunId === "arn_other"
          ? { ok: false, reason: "slice_mismatch" }
          : sandboxId === "sbx_1"
            ? { ok: true, ...stored }
            : sandboxId === "sbx_unlinked"
              ? { ok: false, reason: "no_source" }
              : { ok: false, reason: "not-found" };
      },
      listVersions: async () => [version],
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
      publishVersion: async (owner: string, id: string, actor: string) => {
        if (owner !== "org_1" || id !== "sbv_1")
          return { ok: false, reason: "not-found" };
        if (overrides.unready === true)
          return { ok: false, reason: "not_ready" };
        published.push({ versionId: id, actor });
        return {
          ok: true,
          sandbox: {
            ...sandbox,
            status: "published",
            currentVersionId: id,
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
            ? { ...buildRun, status: "succeeded" }
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
          : runId === "arn_build"
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
    proposals: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && (id === "bpr_1" || id === "bpr_other")
          ? {
              id,
              bountyId: id === "bpr_1" ? "bty_1" : "bty_2",
              revision: 3,
              complexity: "M",
              amountMinor: 10500,
              currency: "USD",
              status: "approved",
              decidedAt: stamp,
              specRevision: 2,
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
    now: () => new Date(stamp),
  } as unknown as SandboxRouteOptions;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "user_1",
      email: "u@example.test",
      name: "User",
    } as never);
    c.set("member", { role, organizationId: "org_1" } as never);
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
    launches: () => launches,
  };
}

test("an admin publishes a version whose build passed, and unpublishes the sandbox", async () => {
  const f = fixture();
  const response = await f.request("POST", "/versions/sbv_1/publish");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    sandbox: { status: string; currentVersionId: string };
    version: { frozenAt: string | null };
    source: { approvedBy: string | null };
  };
  assert.equal(body.sandbox.status, "published");
  assert.equal(body.sandbox.currentVersionId, "sbv_1");
  assert.equal(body.version.frozenAt, stamp);
  assert.equal(body.source.approvedBy, "user_1");
  assert.deepEqual(f.published, [{ versionId: "sbv_1", actor: "user_1" }]);
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
  );
  assert.equal(unready.status, 409);
  assert.equal(((await unready.json()) as { code: string }).code, "not_ready");
  assert.equal(
    (await fixture("member").request("POST", "/versions/sbv_1/publish")).status,
    403,
  );
  assert.equal(
    (await fixture("member").request("POST", "/sbx_1/unpublish")).status,
    403,
  );
  assert.equal(
    (await f.request("POST", "/versions/sbv_x/publish")).status,
    404,
  );
  assert.equal((await f.request("POST", "/sbx_9/unpublish")).status, 404);
});

test("a bounty's sandbox is created by admins, with or without a repository, and listed for members", async () => {
  const f = fixture();
  const created = await f.request("POST", "", {
    bountyId: "bty_1",
    sourceRepoId: "ghr_1",
  });
  assert.equal(created.status, 201);
  const made = ((await created.json()) as { sandbox: StoredSandbox }).sandbox;
  assert.deepEqual(
    [made.id, made.bountyId, made.sourceRepoId],
    ["sbx_1", "bty_1", "ghr_1"],
  );
  // A repository is enrichment: a sandbox is made without one.
  const bare = await f.request("POST", "", { bountyId: "bty_2" });
  assert.equal(bare.status, 201);
  assert.equal(
    ((await bare.json()) as { sandbox: StoredSandbox }).sandbox.sourceRepoId,
    null,
  );
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
  assert.equal(
    (
      await f.request("POST", "", {
        bountyId: "bty_1",
        sourceRepoId: "ghr_pub",
      })
    ).status,
    409,
  );
  // A repository disconnected since the bounty named it is told apart from
  // a missing bounty, so the person asking can see what to change.
  const noRepo = await f.request("POST", "", {
    bountyId: "bty_1",
    sourceRepoId: "ghr_x",
  });
  assert.equal(noRepo.status, 404);
  assert.deepEqual(await noRepo.json(), {
    error: "The repository is not connected to this workspace any more.",
    code: "repo_not_found",
  });
  // No sandbox without its bounty.
  assert.equal(
    (await f.request("POST", "", { sourceRepoId: "ghr_1" })).status,
    400,
  );
  assert.equal((await f.request("POST", "", { nope: true })).status, 400);
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

test("a sandbox made without a repository has one linked once, by an admin", async () => {
  const f = fixture();
  const linked = await f.request("PUT", "/sbx_bare/source", {
    sourceRepoId: "ghr_1",
  });
  assert.equal(linked.status, 200);
  const made = ((await linked.json()) as { sandbox: StoredSandbox }).sandbox;
  assert.deepEqual([made.id, made.sourceRepoId], ["sbx_bare", "ghr_1"]);
  const code = async (response: Response) => [
    response.status,
    ((await response.json()) as { code?: string }).code,
  ];
  // Its versions are bound to the repository it has.
  assert.deepEqual(
    await code(
      await f.request("PUT", "/sbx_1/source", { sourceRepoId: "ghr_2" }),
    ),
    [409, "source_linked"],
  );
  assert.deepEqual(
    await code(
      await f.request("PUT", "/sbx_bare/source", { sourceRepoId: "ghr_pub" }),
    ),
    [409, "repo_role"],
  );
  assert.deepEqual(
    await code(
      await f.request("PUT", "/sbx_bare/source", { sourceRepoId: "ghr_x" }),
    ),
    [404, "repo_not_found"],
  );
  assert.deepEqual(
    await code(
      await f.request("PUT", "/sbx_9/source", { sourceRepoId: "ghr_1" }),
    ),
    [404, undefined],
  );
  assert.equal(
    (
      await f.request(
        "PUT",
        "/sbx_bare/source",
        { sourceRepoId: "ghr_1" },
        "org_2",
      )
    ).status,
    404,
  );
  for (const body of [
    {},
    { sourceRepoId: "" },
    { sourceRepoId: "ghr_1", x: 1 },
  ])
    assert.equal(
      (await f.request("PUT", "/sbx_bare/source", body)).status,
      400,
    );
  assert.equal(
    (
      await fixture("member").request("PUT", "/sbx_bare/source", {
        sourceRepoId: "ghr_1",
      })
    ).status,
    403,
  );
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
  assert.deepEqual(await unbuilt.json(), { run: null, files: [] });
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
      deadlineMinutes: 30,
      sliceRunId: "arn_slice",
      sandboxVersionId: "sbv_1",
      manifestSha256: sha(manifestText),
      contractSha256: sha(contractText),
      transformConfigSha256: "1".repeat(64),
      approvedTaskSha256: "2".repeat(64),
    },
    requestedBy: "user_1",
    maxActive: 3,
  });
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
    repoStack: string[] | null;
    proposal: boolean;
    /** Approved unless said: a draft proposal is not generated from. */
    proposalStatus: "proposed" | "approved";
    limit: boolean;
    created: "ok" | "source_linked" | "not-found";
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
      get: async () => null,
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
              repoId: "ghr_1",
              stack: ["Zod"],
              ...overrides.bounty,
            }
          : null,
    },
    repos: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "ghr_1" && overrides.repoStack !== null
          ? { id, stack: overrides.repoStack ?? ["TypeScript"] }
          : null,
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
    now: () => new Date(stamp),
  } as unknown as SandboxRouteOptions;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    c.set("member", { role, organizationId: "org_1" } as never);
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
  // The repository's detected stack, then what the bounty adds.
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

test("a generated version keeps its listing within bounds", async () => {
  const f = starterFixture("admin", {
    repoStack: null,
    bounty: {
      title: `  ${"t".repeat(130)}  `,
      description: "d".repeat(5_000),
      repoId: null,
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

test("generating is refused for members, a linked sandbox, an off-Node stack, an empty bounty and one not approved", async () => {
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
        repoStack: ["Python"],
        bounty: { stack: ["Django"] },
      }),
      409,
      "stack_unsupported",
    ],
    [
      starterFixture("owner", { bounty: { description: "  " } }),
      409,
      "task_not_ready",
    ],
    // A bounty with no proposal, or a draft one, is not generated from.
    [starterFixture("owner", { proposal: false }), 409, "task_not_ready"],
    [
      starterFixture("owner", { proposalStatus: "proposed" }),
      409,
      "task_not_ready",
    ],
    [starterFixture("owner", { limit: true }), 409, "run_limit"],
    [
      starterFixture("owner", { created: "source_linked" }),
      409,
      "source_linked",
    ],
    [starterFixture("owner", { created: "not-found" }), 404, null],
  ];
  for (const [f, status, code] of cases) {
    const response = await f.request("POST", "/sbx_1/starter");
    assert.equal(response.status, status);
    if (code !== null)
      assert.equal(((await response.json()) as { code: string }).code, code);
  }
  // Nothing was queued for a refusal before the run.
  assert.equal(cases[3]?.[0].enqueued.length, 0);
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
