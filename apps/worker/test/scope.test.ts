import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StoredArtifact } from "@sandbox-factory/db";
import type {
  FixtureSet,
  SandboxFixture,
  ScopeProposal,
  SpecDraft,
} from "sandbox-factory";
import { AnalysisError } from "../src/errors.js";
import type { AgentModel, AgentTurn } from "../src/agent/loop.js";
import type { AgentTask, ToolInputs } from "../src/tools/adapter.js";
import {
  FIXTURE_CHECK_PATH,
  checkFixtures,
  fixtureCheckSource,
  isSingleFunctionExpression,
} from "../src/tools/fixtures-check.js";
import {
  FIXTURE_CHECKS_MAX,
  createFixturesAdapter,
} from "../src/tools/fixtures.js";
import { SCOPE_CHECKS_MAX, createScopeAdapter } from "../src/tools/scope.js";
import { readIncludedSource } from "../src/tools/slice-run.js";
import { contextIndex, contextModel, contextRun } from "./context-fixtures.js";
import {
  fixture,
  graph,
  graphRun,
  sha,
  slice,
  sliceRun,
  stamp,
} from "./fixture-slice.js";

const draft: SpecDraft = {
  feature: "Service labels",
  background: [],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "run labels a thing",
      steps: [{ keyword: "When", text: "run is called" }],
      origin: "draft",
    },
  ],
  openQuestions: [],
  assumptions: [],
};
const task: AgentTask = {
  issueKey: "SHOP-7",
  specRevision: 2,
  specHash: "h",
  draft,
};
const limits = { maxTurns: 10, maxTokens: 1_000_000 };
const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 20,
  cacheWriteTokens: 1,
};
const call = (
  name: string,
  input: unknown,
  id = `${name}-${Math.random()}`,
) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const turn = (content: unknown[], stopReason = "tool_use"): AgentTurn => ({
  content: content as AgentTurn["content"],
  stopReason,
  usage,
});
function scripted(turns: AgentTurn[]): AgentModel & {
  results: unknown[][];
  prompts: string[];
} {
  const results: unknown[][] = [];
  const prompts: string[] = [];
  return {
    model: "test-model",
    results,
    prompts,
    async turn(request) {
      const last = request.messages.at(-1);
      if (request.messages.length === 1)
        prompts.push(JSON.stringify(last?.content ?? ""));
      else if (Array.isArray(last?.content)) results.push(last.content);
      const next = turns.shift();
      if (next === undefined) return turn([], "refusal");
      return next;
    },
  };
}
const contentOf = (result: unknown): { content: string; is_error?: boolean } =>
  result as { content: string; is_error?: boolean };

const graphBytes = Buffer.from(JSON.stringify(graph()));
const graphArtifacts: StoredArtifact[] = [
  {
    id: "art_graph",
    runId: graphRun.id,
    kind: "graph_json",
    path: "graph.json",
    objectKey: "runs/arn_graph/lease/graph.json",
    contentType: "application/json",
    sizeBytes: graphBytes.byteLength,
    sha256: sha(graphBytes),
    meta: null,
    createdAt: stamp,
  },
];
async function inputs(
  overrides: Partial<ToolInputs> = {},
): Promise<ToolInputs> {
  const { artifacts, objects } = await slice();
  return {
    getRun: async (id) =>
      id === graphRun.id ? graphRun : id === sliceRun.id ? sliceRun : null,
    listArtifacts: async (id) =>
      id === graphRun.id ? graphArtifacts : id === sliceRun.id ? artifacts : [],
    readArtifact: async (key) =>
      key === graphArtifacts[0]?.objectKey ? graphBytes : objects.get(key),
    getVersion: async () => null,
    getTask: async (id, revision) =>
      id === "bpr_1" && revision === 2 ? task : null,
    recordBuildOutput: async () => false,
    recordStarterOutput: async () => false,
    ...overrides,
  };
}
const scopeParams = {
  deadlineMinutes: 30,
  agent: "scope" as const,
  graphRunId: graphRun.id,
  proposalId: "bpr_1",
  specRevision: 2,
  specHash: "h",
};
const fixturesParams = {
  deadlineMinutes: 30,
  agent: "fixtures" as const,
  sliceRunId: sliceRun.id,
  proposalId: "bpr_1",
  specRevision: 2,
  specHash: "h",
};
async function runTool(
  adapter: ReturnType<typeof createScopeAdapter>,
  params: unknown,
  toolInputs?: ToolInputs,
) {
  const out = await mkdtemp(join(tmpdir(), "agent-tool-"));
  const lines: string[] = [];
  try {
    const files = await adapter.run({
      sourceDir: fixture,
      outDir: out,
      params: params as never,
      run: { snapshotId: "rsn_1", commitSha: "a".repeat(40) },
      inputs: toolInputs ?? (await inputs()),
      signal: new AbortController().signal,
      log: (line) => lines.push(line),
    });
    const texts = await Promise.all(
      files.map((file) => readFile(file.absolutePath, "utf8")),
    );
    return { files, texts, lines };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
const isCode = (code: string) => (error: unknown) =>
  error instanceof AnalysisError && error.code === code;

const submission = {
  entryPoints: [
    { path: "src/app.ts", reason: "run is what the ticket changes" },
  ],
  maxFiles: 5,
  maxDepth: 0,
  includeInferred: false,
  seams: [
    { module: "lib/helpers.ts", kind: "other", reason: "a label source" },
  ],
  summary: "The developer changes how run labels a thing.",
  risks: ["The service is mocked."],
  pattern: { path: "lib/helpers.ts", reason: "it labels things already" },
};

test("the scope agent checks candidates with the slice itself and records a verified proposal", async () => {
  const model = scripted([
    turn([
      call("check_scope", {
        entryPoints: ["src/app.ts"],
        maxFiles: 5,
        maxDepth: 0,
        includeInferred: false,
      }),
      call("check_scope", {
        entryPoints: ["nowhere.ts"],
        maxFiles: 5,
        maxDepth: 0,
        includeInferred: false,
      }),
      call("check_scope", { entryPoints: [] }),
      call("graph_neighbours", { path: "src/app.ts" }),
      call("read_file", { path: "src/app.ts", startLine: null, endLine: null }),
    ]),
    turn([
      call("submit_scope", {
        ...submission,
        seams: [{ module: "src/local.ts", kind: "other", reason: "not cut" }],
      }),
    ]),
    turn([call("submit_scope", { ...submission, summary: "" })]),
    turn([
      call("submit_scope", {
        ...submission,
        entryPoints: [{ path: "x.ts", reason: "r" }],
      }),
    ]),
    turn([
      call("submit_scope", {
        ...submission,
        pattern: { path: "lib/nowhere.ts", reason: "imagined" },
      }),
    ]),
    turn([call("submit_scope", submission)]),
  ]);
  const { files, texts, lines } = await runTool(
    createScopeAdapter({ model, limits }),
    scopeParams,
  );
  assert.match(model.prompts[0] ?? "", /Ticket SHOP-7/);
  assert.match(model.prompts[0] ?? "", /files\./);
  const first = (model.results[0] ?? []).map(contentOf);
  const report = JSON.parse(first[0]?.content ?? "{}") as {
    included: string[];
    outbound: { module: string }[];
  };
  assert.deepEqual(report.included, ["src/app.ts"]);
  assert.ok(
    report.outbound.some((module) => module.module === "lib/helpers.ts"),
  );
  assert.match(first[1]?.content ?? "", /includes nothing/);
  assert.equal(first[2]?.is_error, true);
  assert.match(first[3]?.content ?? "", /src\/app\.ts uses:/);
  assert.match(first[4]?.content ?? "", /src\/app\.ts lines 1-/);
  assert.match(
    contentOf((model.results[1] ?? [])[0]).content,
    /src\/local\.ts is not a module this request cuts/,
  );
  assert.match(contentOf((model.results[2] ?? [])[0]).content, /Invalid input/);
  assert.match(
    contentOf((model.results[3] ?? [])[0]).content,
    /includes nothing/,
  );
  assert.match(
    contentOf((model.results[4] ?? [])[0]).content,
    /lib\/nowhere\.ts is not a file in the repository/,
  );
  assert.equal(files.length, 1);
  assert.equal(files[0]?.kind, "scope_proposal");
  const proposal = JSON.parse(texts[0] ?? "{}") as ScopeProposal;
  assert.deepEqual(files[0]?.meta, proposal);
  assert.equal(proposal.graphRunId, graphRun.id);
  assert.deepEqual(proposal.budget, { maxFiles: 5, maxDepth: 0 });
  assert.equal(proposal.check.includedFiles, 1);
  assert.ok(proposal.check.outboundModules >= 3);
  assert.deepEqual(proposal.pattern, submission.pattern);
  assert.equal(proposal.usage.turns, 6);
  assert.equal(proposal.usage.cacheReadTokens, 120);
  assert.ok(lines.includes("Scope agent started."));
  assert.ok(
    lines.some((line) => /^Scope proposal recorded: 1 entry points/.test(line)),
  );
});

test("the scope agent runs out of checks, and fails cleanly without a model, a task or an answer", async () => {
  const request = {
    entryPoints: ["src/app.ts"],
    maxFiles: 5,
    maxDepth: 0,
    includeInferred: false,
  };
  const greedy = scripted([
    turn(
      Array.from({ length: SCOPE_CHECKS_MAX + 1 }, () =>
        call("check_scope", request),
      ),
    ),
  ]);
  await assert.rejects(
    runTool(createScopeAdapter({ model: greedy, limits }), scopeParams),
    isCode("agent_incomplete"),
  );
  const checks = (greedy.results[0] ?? []).map(contentOf);
  assert.match(checks.at(-1)?.content ?? "", /No checks are left/);
  assert.equal(
    checks.filter((check) => check.is_error !== true).length,
    SCOPE_CHECKS_MAX,
  );
  await assert.rejects(
    runTool(createScopeAdapter({ model: null, limits }), scopeParams),
    isCode("agent_unavailable"),
  );
  await assert.rejects(
    runTool(createScopeAdapter({ model: scripted([]), limits }), {
      deadlineMinutes: 30,
    }),
    isCode("tool_failed"),
  );
  await assert.rejects(
    runTool(createScopeAdapter({ model: scripted([]), limits }), {
      ...scopeParams,
      specHash: "stale",
    }),
    isCode("tool_failed"),
  );
  await assert.rejects(
    runTool(createScopeAdapter({ model: scripted([]), limits }), {
      ...scopeParams,
      graphRunId: "arn_missing",
    }),
    isCode("graph_unavailable"),
  );
});

const passing: SandboxFixture = {
  module: "lib/helpers.ts",
  symbol: "label",
  member: null,
  call: "call",
  implementation: '() => "demo"',
  reason: "a readable label",
};
const mistyped: SandboxFixture = {
  module: "lib/service.ts",
  symbol: "createService",
  member: null,
  call: "call",
  implementation: "(options) => ({ describe: (label) => ({ id: label }) })",
  reason: "a service without its private parts",
};
const scenario = [
  'import { run } from "../src/app.js";',
  'import { recordedCalls } from "./mock.js";',
  'console.log(run({ name: "demo", retries: 1, nested: { enabled: true } }));',
  "console.log(recordedCalls().length);",
  "",
].join("\n");

test("fixtures are type-checked against the declarations they stand in for", async () => {
  const { manifest, contract, objects, artifacts } = await slice();
  const stubs = [];
  for (const artifact of artifacts.filter((a) => a.kind === "stub"))
    stubs.push({
      module:
        contract.outbound.find((m) => m.stubPath === artifact.path)?.module ??
        "",
      text: objects.get(artifact.objectKey)?.toString("utf8") ?? "",
    });
  const included = await readIncludedSource(fixture, manifest);
  const base = {
    root: fixture,
    sourceOptions: { strict: true, target: "ES2022" },
    included,
    stubs,
    packages: ["pg"],
    contract,
  };
  assert.deepEqual(checkFixtures({ ...base, fixtures: [passing], scenario }), {
    ok: true,
    problems: [],
  });
  const failed = checkFixtures({
    ...base,
    fixtures: [passing, mistyped],
    scenario: `${scenario}run(42);\n`,
  });
  assert.equal(failed.ok, false);
  assert.match(
    failed.problems.join("\n"),
    /Fixture 1 \(module:lib\/service\.ts\.createService\): TS2739 .*missing the following properties/,
  );
  assert.match(failed.problems.join("\n"), /Walkthrough line 5: TS2345/);
  const invalid = checkFixtures({
    ...base,
    fixtures: [{ ...passing, module: "lib/nowhere.ts" }],
    scenario: " ",
  });
  assert.deepEqual(invalid.problems, [
    "Fixture 0: lib/nowhere.ts is not a module the slice mocks.",
    "Walkthrough: The scenario is empty.",
  ]);
  const source = fixtureCheckSource([
    {
      ...mistyped,
      member: "a.b",
      call: "construct",
      implementation: "() =>\n  ({})",
    },
  ]);
  assert.match(
    source.text,
    /import type \* as __m0 from "\.\.\/lib\/service\.js";/,
  );
  assert.match(
    source.text,
    /ConstructorParameters<typeof __m0\["createService"\]\["a"\]\["b"\]>/,
  );
  assert.deepEqual(source.lines, [[3, 6]]);
  assert.equal(FIXTURE_CHECK_PATH, "sandbox/fixtures.check.ts");
  // Text that closes the call and adds statements is not one expression.
  for (const text of [
    "() => 1",
    "async (a) => {\n  return a;\n}",
    "function (x) { return x; }",
  ])
    assert.equal(isSingleFunctionExpression(text), true, text);
  for (const text of [
    "() => 1); globalThis.leak = 1; (() => 2",
    "1 + 1",
    "() => 1; 2",
  ])
    assert.equal(isSingleFunctionExpression(text), false, text);
  const injected = checkFixtures({
    ...base,
    fixtures: [
      {
        ...passing,
        implementation: '() => "a"); globalThis.x = 1; (() => "b"',
      },
    ],
    scenario,
  });
  assert.match(injected.problems.join("\n"), /exactly one function expression/);
});

test("the fixtures agent records a set only once it compiles", async () => {
  const model = scripted([
    turn([
      call("check_fixtures", { fixtures: [mistyped], scenario }),
      call("check_fixtures", { fixtures: "no" }),
    ]),
    turn([
      call("submit_fixtures", {
        fixtures: [mistyped],
        scenario,
        summary: "Shows run.",
      }),
    ]),
    turn([call("submit_fixtures", { fixtures: [], scenario: "" })]),
    turn([
      call("submit_fixtures", {
        fixtures: [passing],
        scenario,
        summary: "Shows run labelling a thing.",
      }),
    ]),
  ]);
  const { files, texts, lines } = await runTool(
    createFixturesAdapter({ model, limits }),
    fixturesParams,
  );
  assert.match(
    model.prompts[0] ?? "",
    /Cut modules and their declaration stubs/,
  );
  assert.match(model.prompts[0] ?? "", /lib\/helpers\.ts/);
  const first = (model.results[0] ?? []).map(contentOf);
  assert.match(first[0]?.content ?? "", /TS2739/);
  assert.match(first[1]?.content ?? "", /Invalid input/);
  assert.match(contentOf((model.results[1] ?? [])[0]).content, /TS2739/);
  assert.match(contentOf((model.results[2] ?? [])[0]).content, /Invalid input/);
  assert.equal(files[0]?.kind, "fixture_set");
  const set = JSON.parse(texts[0] ?? "{}") as FixtureSet;
  assert.deepEqual(files[0]?.meta, set);
  assert.deepEqual(set.fixtures, [passing]);
  assert.equal(set.sliceRunId, sliceRun.id);
  assert.equal(set.scenario, scenario);
  assert.ok(lines.includes("Fixture set recorded: 1 fixtures."));
});

test("the fixtures agent runs out of checks and refuses a missing model, task or slice", async () => {
  const greedy = scripted([
    turn(
      Array.from({ length: FIXTURE_CHECKS_MAX + 1 }, () =>
        call("check_fixtures", { fixtures: [passing], scenario }),
      ),
    ),
  ]);
  await assert.rejects(
    runTool(createFixturesAdapter({ model: greedy, limits }), fixturesParams),
    isCode("agent_incomplete"),
  );
  assert.match(
    contentOf((greedy.results[0] ?? []).at(-1)).content,
    /No checks are left/,
  );
  await assert.rejects(
    runTool(createFixturesAdapter({ model: null, limits }), fixturesParams),
    isCode("agent_unavailable"),
  );
  await assert.rejects(
    runTool(
      createFixturesAdapter({ model: scripted([]), limits }),
      scopeParams,
    ),
    isCode("tool_failed"),
  );
  await assert.rejects(
    runTool(createFixturesAdapter({ model: scripted([]), limits }), {
      ...fixturesParams,
      specRevision: 3,
    }),
    isCode("tool_failed"),
  );
  await assert.rejects(
    runTool(
      createFixturesAdapter({ model: scripted([]), limits }),
      fixturesParams,
      await inputs({
        getRun: async () => ({ ...sliceRun, status: "running" }),
      }),
    ),
    isCode("slice_unavailable"),
  );
});

/** The slice fixture's inputs, with succeeded context runs beside them. */
async function contextInputs(): Promise<ToolInputs> {
  const base = await inputs();
  const served = [
    contextRun("arn_abstractions", "abstractions", contextIndex),
    contextRun("arn_model", "data_model", contextModel),
  ];
  return {
    ...base,
    getRun: async (id) =>
      served.find((entry) => entry.run.id === id)?.run ?? base.getRun(id),
    listArtifacts: async (id) => {
      const entry = served.find((candidate) => candidate.run.id === id);
      return entry === undefined ? base.listArtifacts(id) : [entry.artifact];
    },
    readArtifact: async (key) =>
      served.find((entry) => entry.artifact.objectKey === key)?.bytes ??
      base.readArtifact(key),
  };
}

test("with the context builders, the scope agent names an accessor module as a database seam and check_scope agrees", async () => {
  const model = scripted([
    turn([
      call("data_model", { entity: null }),
      call("module_surface", { path: "lib/service.ts" }),
      call("data_model", { entity: "things" }),
    ]),
    turn([
      call("submit_scope", {
        ...submission,
        seams: [
          {
            module: "lib/service.ts",
            kind: "database",
            reason: "The accessor that reads and writes things.",
          },
        ],
      }),
    ]),
  ]);
  const { files, texts } = await runTool(
    createScopeAdapter({ model, limits }),
    {
      ...scopeParams,
      abstractionsRunId: "arn_abstractions",
      dataModelRunId: "arn_model",
    },
    await contextInputs(),
  );
  const prompt = model.prompts[0] ?? "";
  assert.match(prompt, /The abstractions index describes 2 modules/);
  assert.match(prompt, /where a `database` seam belongs/);
  assert.match(prompt, /lib\/service\.ts: owners, things/);
  const [overview, surface, entity] = (model.results[0] ?? []).map(contentOf);
  assert.match(
    overview?.content ?? "",
    /Accessors, most entities first \(1\):\nlib\/service\.ts/,
  );
  assert.match(surface?.content ?? "", /createService \(function, L18\)/);
  assert.match(entity?.content ?? "", /^things → table app\.things/);
  const proposal = JSON.parse(texts[0] ?? "{}") as ScopeProposal;
  assert.equal(files[0]?.kind, "scope_proposal");
  assert.deepEqual(
    proposal.seams.map((seam) => [seam.module, seam.kind]),
    [["lib/service.ts", "database"]],
  );
  assert.ok(proposal.check.outboundModules >= 1);
});

test("a scope or fixtures run fails cleanly when a context run it names is gone", async () => {
  await assert.rejects(
    runTool(
      createScopeAdapter({ model: scripted([]), limits }),
      { ...scopeParams, abstractionsRunId: "arn_gone" },
      await contextInputs(),
    ),
    isCode("context_unavailable"),
  );
  await assert.rejects(
    runTool(
      createScopeAdapter({ model: scripted([]), limits }),
      { ...scopeParams, dataModelRunId: "arn_abstractions" },
      await contextInputs(),
    ),
    isCode("context_unavailable"),
  );
  await assert.rejects(
    runTool(
      createFixturesAdapter({ model: scripted([]), limits }),
      { ...fixturesParams, dataModelRunId: "arn_gone" },
      await contextInputs(),
    ),
    isCode("context_unavailable"),
  );
});

test("with a data model, the fixtures agent reads the entities its samples must obey", async () => {
  const model = scripted([
    turn([call("data_model", { entity: "things" })]),
    turn([
      call("submit_fixtures", {
        fixtures: [passing],
        scenario,
        summary: "Things are labelled.",
      }),
    ]),
  ]);
  const { files } = await runTool(
    createFixturesAdapter({ model, limits }),
    { ...fixturesParams, dataModelRunId: "arn_model" },
    await contextInputs(),
  );
  assert.match(model.prompts[0] ?? "", /data model has 2 entities/);
  assert.match(
    contentOf((model.results[0] ?? [])[0]).content,
    /state: enum as state, required, default 'new', one of new \| done/,
  );
  assert.equal(files[0]?.kind, "fixture_set");
});
