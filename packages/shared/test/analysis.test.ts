import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisRunDtoSchema,
  artifactDtoSchema,
  enqueueAnalysisSchema,
  enqueueFixturesSchema,
  enqueueScopeSchema,
  enqueueSliceSchema,
  fixtureSetSchema,
  fixtureSubmissionSchema,
  repositoryProposalListSchema,
  scopeProposalSchema,
  scopeSubmissionSchema,
  sliceBoundarySummarySchema,
  sliceParamsSchema,
} from "../src/analysis.js";

test("analysis defaults are canonical and tool parameters are bounded", () => {
  assert.deepEqual(enqueueAnalysisSchema.parse({ tool: "graphify" }), {
    tool: "graphify",
    params: { deadlineMinutes: 30 },
  });
  for (const body of [
    { tool: "other" },
    { tool: "slice" },
    { tool: "graphify", params: { deadlineMinutes: 121 } },
    { tool: "graphify", params: { includeInferred: true } },
    { tool: "graphify", organizationId: "foreign" },
  ])
    assert.equal(enqueueAnalysisSchema.safeParse(body).success, false);
});
test("slice requests take repository paths and a bounded budget", () => {
  assert.deepEqual(enqueueSliceSchema.parse({ entryPoints: ["src/main.ts"] }), {
    entryPoints: ["src/main.ts"],
    budget: { maxFiles: 40, maxDepth: 3 },
    includeInferred: false,
    deadlineMinutes: 30,
  });
  assert.equal(
    enqueueSliceSchema.parse({ entryPoints: ["src"], budget: { maxFiles: 5 } })
      .budget.maxDepth,
    3,
  );
  for (const body of [
    { entryPoints: [] },
    { entryPoints: ["/etc/passwd"] },
    { entryPoints: ["src/../secret"] },
    { entryPoints: ["src//a"] },
    { entryPoints: ["src\\a"] },
    { entryPoints: ["./a"] },
    { entryPoints: Array.from({ length: 51 }, (_, i) => `f${i}`) },
    { entryPoints: ["a"], budget: { maxFiles: 0 } },
    { entryPoints: ["a"], budget: { maxFiles: 201 } },
    { entryPoints: ["a"], graphRunId: "chosen-by-client" },
  ])
    assert.equal(
      enqueueSliceSchema.safeParse(body).success,
      false,
      JSON.stringify(body),
    );
  const stored = {
    deadlineMinutes: 30,
    graphRunId: "arn_g",
    entryPoints: ["a.ts", "b.ts"],
    budget: { maxFiles: 40, maxDepth: 3 },
    includeInferred: false,
  };
  assert.equal(sliceParamsSchema.safeParse(stored).success, true);
  assert.equal(
    sliceParamsSchema.safeParse({ ...stored, entryPoints: ["b.ts", "a.ts"] })
      .success,
    false,
  );
  assert.equal(
    sliceParamsSchema.safeParse({ ...stored, entryPoints: ["a.ts", "a.ts"] })
      .success,
    false,
  );
  assert.equal(
    sliceParamsSchema.safeParse({ ...stored, graphRunId: "" }).success,
    false,
  );
});
test("run DTOs discriminate parameters by tool", () => {
  const common = {
    id: "arn_1",
    snapshotId: "rsn_1",
    repoId: "ghr_1",
    toolVersion: "v",
    status: "queued",
    attempt: 0,
    maxAttempts: 2,
    errorCode: null,
    errorDetail: null,
    startedAt: null,
    finishedAt: null,
    deadlineAt: null,
    createdAt: "2026-10-02T00:00:00Z",
  };
  assert.equal(
    analysisRunDtoSchema.safeParse({
      ...common,
      tool: "graphify",
      params: { deadlineMinutes: 30 },
    }).success,
    true,
  );
  const slice = {
    ...common,
    tool: "slice",
    params: {
      deadlineMinutes: 30,
      graphRunId: "arn_0",
      entryPoints: ["src/main.ts"],
      budget: { maxFiles: 40, maxDepth: 3 },
      includeInferred: false,
    },
  };
  assert.equal(analysisRunDtoSchema.safeParse(slice).success, true);
  assert.equal(
    analysisRunDtoSchema.safeParse({ ...slice, tool: "graphify" }).success,
    false,
  );
  assert.equal(
    analysisRunDtoSchema.safeParse({
      ...common,
      tool: "slice",
      params: { deadlineMinutes: 30 },
    }).success,
    false,
  );
  assert.equal(
    analysisRunDtoSchema.safeParse({ ...common, tool: "deepwiki", params: {} })
      .success,
    false,
  );
});
test("artifact wire schema rejects private object keys", () => {
  const value = {
    id: "a",
    runId: "r",
    kind: "graph_json",
    path: "graph.json",
    contentType: "application/json",
    sizeBytes: 1,
    sha256: "a".repeat(64),
    meta: null,
    createdAt: "2026-10-02T00:00:00Z",
  };
  assert.equal(artifactDtoSchema.safeParse(value).success, true);
  assert.equal(
    artifactDtoSchema.safeParse({ ...value, kind: "stub" }).success,
    true,
  );
  assert.equal(
    artifactDtoSchema.safeParse({ ...value, objectKey: "private/key" }).success,
    false,
  );
});
test("boundary summaries parse what the console renders", () => {
  const summary = {
    schemaVersion: 1,
    language: "typescript",
    stubCoverage: "full",
    ready: true,
    counts: {
      includedFiles: 1,
      includedBytes: 2,
      outboundModules: 0,
      inboundModules: 0,
      stubs: 0,
      publicSymbols: 0,
      externals: 0,
      blockers: 0,
    },
    included: ["src/main.ts"],
    outbound: [
      {
        module: "src/util.ts",
        symbols: ["helper"],
        importedBy: ["src/main.ts"],
        truncated: false,
      },
    ],
    inbound: [],
    externals: {
      packages: [{ specifier: "pg", service: "postgres" }],
      environment: ["DATABASE_URL"],
    },
    blockers: [
      {
        code: "unresolved_import",
        file: "src/main.ts",
        location: "L4",
        detail: "x",
      },
    ],
    truncated: false,
  };
  assert.equal(sliceBoundarySummarySchema.safeParse(summary).success, true);
  assert.equal(
    sliceBoundarySummarySchema.safeParse({ ...summary, stubCoverage: "none" })
      .success,
    false,
  );
  assert.equal(
    sliceBoundarySummarySchema.safeParse({
      ...summary,
      blockers: [{ code: "other", file: null, location: null, detail: "" }],
    }).success,
    false,
  );
});

const runBase = {
  id: "r1",
  snapshotId: "snap",
  repoId: "repo",
  toolVersion: "scope@1",
  status: "succeeded",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  startedAt: null,
  finishedAt: null,
  deadlineAt: null,
  createdAt: "2026-10-03T00:00:00.000Z",
};
const task = { proposalId: "p1", specRevision: 3, specHash: "h" };

test("agent runs name a proposal's spec revision and discriminate by tool", () => {
  const scope = analysisRunDtoSchema.parse({
    ...runBase,
    tool: "scope",
    params: { ...task, agent: "scope", graphRunId: "g1" },
  });
  assert.equal(scope.tool, "scope");
  assert.equal(scope.params.deadlineMinutes, 30);
  assert.equal(
    analysisRunDtoSchema.safeParse({
      ...runBase,
      tool: "fixtures",
      params: { ...task, agent: "fixtures", sliceRunId: "s1" },
    }).success,
    true,
  );
  for (const params of [
    { ...task, agent: "fixtures", graphRunId: "g1" },
    { ...task, agent: "scope", graphRunId: "g1", specRevision: 0 },
    { agent: "scope", graphRunId: "g1" },
  ])
    assert.equal(
      analysisRunDtoSchema.safeParse({ ...runBase, tool: "scope", params })
        .success,
      false,
    );
  assert.deepEqual(enqueueScopeSchema.parse({ proposalId: "p1" }), {
    proposalId: "p1",
    deadlineMinutes: 60,
  });
  assert.equal(
    enqueueFixturesSchema.safeParse({ proposalId: "p1", graphRunId: "g" })
      .success,
    false,
  );
});

const submission = {
  entryPoints: [{ path: "src/a.ts", reason: "the rule the ticket changes" }],
  budget: { maxFiles: 20, maxDepth: 1 },
  includeInferred: false,
  seams: [{ module: "src/db.ts", kind: "database", reason: "queries" }],
  summary: "Fix the discount rule.",
  risks: ["The rule reads a feature flag."],
};
const usage = {
  model: "claude-opus-5-5",
  turns: 7,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 5000,
  cacheWriteTokens: 900,
};

test("scope submissions are bounded and proposals carry their check and usage", () => {
  assert.equal(scopeSubmissionSchema.safeParse(submission).success, true);
  for (const bad of [
    { ...submission, entryPoints: [] },
    { ...submission, entryPoints: [{ path: "../x", reason: "r" }] },
    {
      ...submission,
      seams: [{ module: "src/db.ts", kind: "cache", reason: "r" }],
    },
    { ...submission, summary: "" },
    { ...submission, extra: true },
  ])
    assert.equal(scopeSubmissionSchema.safeParse(bad).success, false);
  assert.equal(
    scopeProposalSchema.safeParse({
      ...submission,
      schemaVersion: 1,
      toolVersion: "scope@1",
      sourceSnapshotId: "snap",
      sourceCommitSha: "abc",
      graphRunId: "g1",
      proposalId: "p1",
      specRevision: 3,
      check: {
        stubCoverage: "full",
        ready: true,
        includedFiles: 4,
        outboundModules: 2,
        blockers: 0,
      },
      usage,
    }).success,
    true,
  );
});

test("fixture submissions name a call shape and carry a scenario", () => {
  const fixtures = {
    fixtures: [
      {
        module: "src/db.ts",
        symbol: "db",
        member: "users.find",
        call: "call",
        implementation: "async (id) => ({ id })",
        reason: "a known user",
      },
    ],
    scenario: "console.log(await run());",
    summary: "Walks the discount.",
  };
  assert.equal(fixtureSubmissionSchema.safeParse(fixtures).success, true);
  assert.equal(
    fixtureSubmissionSchema.safeParse({ ...fixtures, scenario: "" }).success,
    false,
  );
  assert.equal(
    fixtureSetSchema.safeParse({
      ...fixtures,
      schemaVersion: 1,
      toolVersion: "fixtures@1",
      sliceRunId: "s1",
      sourceSnapshotId: "snap",
      sourceCommitSha: "abc",
      proposalId: "p1",
      specRevision: 3,
      usage,
    }).success,
    true,
  );
});

test("a repository's proposals name their spec revision and board", () => {
  const proposal = {
    id: "bpr_1",
    issueKey: "SHOP-1",
    title: null,
    status: "approved",
    specRevision: 2,
    boardId: "jbd_1",
    boardName: "Shop",
    createdAt: "2026-10-03T00:00:00.000Z",
  };
  assert.equal(
    repositoryProposalListSchema.safeParse({ proposals: [proposal] }).success,
    true,
  );
  assert.equal(
    repositoryProposalListSchema.safeParse({
      proposals: [{ ...proposal, specRevision: null }],
    }).success,
    false,
  );
});
