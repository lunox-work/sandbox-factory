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
  sourceRepoId: "ghr_1",
  ticketIds: ["tkt_1"],
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
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  sliceRunId: "arn_slice",
  manifestSha256: sha(manifestText),
  contractSha256: sha(contractText),
  transformConfigSha256: "1".repeat(64),
  approvedTaskSha256: "2".repeat(64),
  approvedTask: {
    schemaVersion: 2,
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
    ticketIds: ["tkt_1"],
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
  }> = {},
) {
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
      create: async (owner: string, input: { sourceRepoId: string }) =>
        input.sourceRepoId === "ghr_pub"
          ? { ok: false, reason: "repo_role" }
          : input.sourceRepoId === "ghr_x"
            ? { ok: false, reason: "repo_not_found" }
            : { ok: true, sandbox: { ...sandbox, organizationId: owner } },
      list: async () => [sandbox],
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbx_1" ? sandbox : null,
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
        owner === "org_1" && id === "bpr_1"
          ? {
              id,
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
    launches: () => launches,
  };
}

test("sandboxes are created from owned source repositories by admins and listed for members", async () => {
  const f = fixture();
  const created = await f.request("POST", "", {
    sourceRepoId: "ghr_1",
    ticketIds: ["tkt_1"],
  });
  assert.equal(created.status, 201);
  assert.equal(
    ((await created.json()) as { sandbox: StoredSandbox }).sandbox.id,
    "sbx_1",
  );
  assert.equal(
    (await f.request("POST", "", { sourceRepoId: "ghr_pub" })).status,
    409,
  );
  assert.equal(
    (await f.request("POST", "", { sourceRepoId: "ghr_x" })).status,
    404,
  );
  assert.equal((await f.request("POST", "", { nope: true })).status, 400);
  assert.equal(
    (await fixture("member").request("POST", "", { sourceRepoId: "ghr_1" }))
      .status,
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
  // A new version names the sandbox's tickets, at the current schema.
  assert.deepEqual(input.source.approvedTask.ticketIds, ["tkt_1"]);
  assert.equal(input.source.approvedTask.schemaVersion, 2);
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
