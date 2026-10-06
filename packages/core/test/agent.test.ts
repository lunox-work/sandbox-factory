import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIXTURE_LIMITS,
  fixtureMockPath,
  fixtureProblems,
  isFixturesParams,
  isSandboxBuildParams,
  isScopeParams,
  isSliceParams,
  isDependencyCruiserParams,
  isDeepwikiParams,
  readsGraph,
  readsSource,
  CONTEXT_BUILDERS,
  scenarioProblems,
  scopeProblems,
  sliceRequestOf,
  toolOfParams,
  toolVersionOf,
  ANALYSIS_TOOLS,
} from "../src/index.js";
import type {
  BoundaryModule,
  SandboxFixture,
  ScopeSubmission,
} from "../src/index.js";

const task = {
  deadlineMinutes: 30,
  proposalId: "p1",
  specRevision: 2,
  specHash: "h",
};
const scope = { ...task, agent: "scope" as const, graphRunId: "g1" };
const fixtures = { ...task, agent: "fixtures" as const, sliceRunId: "s1" };
const slice = {
  deadlineMinutes: 30,
  graphRunId: "g1",
  entryPoints: ["src/a.ts"],
  budget: { maxFiles: 40, maxDepth: 3 },
  includeInferred: false,
};

test("agent parameters name their tool, and a scope run is never a slice", () => {
  assert.equal(toolOfParams(scope), "scope");
  assert.equal(toolOfParams(fixtures), "fixtures");
  assert.equal(toolOfParams(slice), "slice");
  assert.equal(toolOfParams({ deadlineMinutes: 30 }), "graphify");
  assert.equal(isSliceParams(scope), false);
  assert.equal(isScopeParams(fixtures), false);
  assert.equal(isFixturesParams(scope), false);
  assert.equal(isSandboxBuildParams(fixtures), false);
  assert.equal(isScopeParams(slice), false);
});

test("a context builder names itself, and slices, scopes and the map-reading builders read a graph", () => {
  const cruise = {
    deadlineMinutes: 30,
    builder: "dependency_cruiser" as const,
  };
  const wiki = { deadlineMinutes: 30, builder: "deepwiki" as const };
  assert.equal(toolOfParams(cruise), "dependency_cruiser");
  assert.equal(toolOfParams(wiki), "deepwiki");
  assert.equal(isSliceParams(cruise), false);
  assert.equal(isDependencyCruiserParams(cruise), true);
  assert.equal(isDependencyCruiserParams(wiki), false);
  assert.equal(isDeepwikiParams(wiki), true);
  assert.equal(isDeepwikiParams(slice), false);
  assert.deepEqual(ANALYSIS_TOOLS.filter(readsGraph), [
    "abstractions",
    "data_model",
    "slice",
    "scope",
  ]);
  assert.deepEqual(ANALYSIS_TOOLS.filter(readsSource).length, 9);
  for (const builder of CONTEXT_BUILDERS)
    assert.ok(ANALYSIS_TOOLS.includes(builder));
});

test("every tool has a version", () => {
  for (const tool of ANALYSIS_TOOLS) assert.match(toolVersionOf(tool), /@/);
  assert.equal(toolVersionOf("scope"), "scope@3");
  assert.equal(toolVersionOf("fixtures"), "fixtures@2");
});

const submission: ScopeSubmission = {
  entryPoints: [
    { path: "src/b.ts", reason: "the handler" },
    { path: "src/a.ts", reason: "the rules" },
  ],
  budget: { maxFiles: 10, maxDepth: 0 },
  includeInferred: false,
  seams: [{ module: "src/db.ts", kind: "database", reason: "queries" }],
  summary: "Fix the rule.",
  risks: [],
};

test("a scope submission becomes the canonical slice request", () => {
  assert.deepEqual(sliceRequestOf(submission), {
    entryPoints: ["src/a.ts", "src/b.ts"],
    budget: { maxFiles: 10, maxDepth: 0 },
    includeInferred: false,
  });
});

test("seams must be modules the request cuts, each once", () => {
  assert.deepEqual(scopeProblems(submission, ["src/db.ts"]), []);
  const problems = scopeProblems(
    {
      ...submission,
      entryPoints: [...submission.entryPoints, submission.entryPoints[0]!],
      seams: [
        ...submission.seams,
        { module: "src/db.ts", kind: "database", reason: "again" },
        { module: "src/rules.ts", kind: "other", reason: "pure" },
      ],
    },
    ["src/db.ts"],
  );
  assert.equal(problems.length, 3);
  assert.match(
    problems[0] ?? "",
    /src\/b\.ts is listed as an entry point twice/,
  );
  assert.match(problems.join("\n"), /src\/db\.ts is listed as a seam twice/);
  assert.match(
    problems.join("\n"),
    /src\/rules\.ts is not a module this request cuts/,
  );
});

const outbound: BoundaryModule[] = [
  {
    module: "src/db.ts",
    symbols: [
      {
        name: "db",
        kind: "variable",
        declaration: "export declare const db: Db;",
      },
      {
        name: "Client",
        kind: "class",
        declaration: "export declare class Client {}",
      },
      {
        name: "Row",
        kind: "interface",
        declaration: "export interface Row {}",
      },
    ],
    importedBy: ["src/a.ts"],
    stubPath: "stubs/src/db.d.ts",
  },
];
const fixture = (over: Partial<SandboxFixture>): SandboxFixture => ({
  module: "src/db.ts",
  symbol: "db",
  member: "users.find",
  call: "call",
  implementation: 'async (id) => ({ id, name: "Ada" })',
  reason: "a known user",
  ...over,
});

test("a fixture's mock path is the name the generated runtime records", () => {
  assert.equal(fixtureMockPath(fixture({})), "module:src/db.ts.db.users.find");
  assert.equal(
    fixtureMockPath(
      fixture({ symbol: "Client", member: null, call: "construct" }),
    ),
    "new module:src/db.ts.Client",
  );
});

test("fixtures must name mocked values and be self-contained function expressions", () => {
  assert.deepEqual(
    fixtureProblems(
      [
        fixture({}),
        fixture({
          symbol: "Client",
          member: null,
          call: "construct",
          implementation: "function () { return {}; }",
        }),
      ],
      outbound,
    ),
    [],
  );
  const problems = fixtureProblems(
    [
      fixture({ module: "src/other.ts" }),
      fixture({ symbol: "missing" }),
      fixture({ symbol: "Row", member: null }),
      fixture({ member: "a.b.c.d.e" }),
      fixture({ member: "bad-name" }),
      fixture({
        implementation: "x".repeat(FIXTURE_LIMITS.implementationChars + 1),
      }),
      fixture({ implementation: "const x = 1" }),
      fixture({ implementation: '() => require("fs")' }),
      fixture({
        implementation: 'async () => { const m = await import("x"); }',
      }),
      fixture({}),
    ],
    outbound,
  );
  const details = problems.map(
    (problem) => `${problem.fixture}: ${problem.detail}`,
  );
  assert.match(
    details.join("\n"),
    /0: src\/other\.ts is not a module the slice mocks/,
  );
  assert.match(details.join("\n"), /1: src\/db\.ts exports no missing/);
  assert.match(details.join("\n"), /2: Row is a type/);
  assert.match(details.join("\n"), /3: a\.b\.c\.d\.e must be up to 4/);
  assert.match(details.join("\n"), /4: bad-name must be/);
  assert.match(details.join("\n"), /5: The implementation is longer/);
  assert.match(
    details.join("\n"),
    /6: The implementation must be one function expression/,
  );
  assert.match(details.join("\n"), /7: The implementation must not import/);
  assert.match(details.join("\n"), /8: The implementation must not import/);
  assert.match(
    details.join("\n"),
    /9: module:src\/db\.ts\.db\.users\.find is given behaviour twice/,
  );
  const many = Array.from({ length: FIXTURE_LIMITS.fixtures + 1 }, (_, index) =>
    fixture({ member: `m${index}` }),
  );
  assert.deepEqual(fixtureProblems(many, outbound)[0], {
    fixture: null,
    detail: `At most ${FIXTURE_LIMITS.fixtures} fixtures are kept.`,
  });
});

test("a scenario must be present and bounded", () => {
  assert.deepEqual(scenarioProblems("console.log(1);"), []);
  assert.match(scenarioProblems("  \n")[0]?.detail ?? "", /empty/);
  assert.match(
    scenarioProblems("x".repeat(FIXTURE_LIMITS.scenarioChars + 1))[0]?.detail ??
      "",
    /longer than/,
  );
});
