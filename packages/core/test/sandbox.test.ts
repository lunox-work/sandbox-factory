import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  applyAliases,
  approvedTaskReadiness,
  baselineVerdict,
  buildSummary,
  declarationPath,
  descriptorPublic,
  enumMembers,
  freezeReadiness,
  generateProject,
  invertAliasRules,
  renameFile,
  OPERATION_POLICY,
  packageNameOf,
  relativeSpecifier,
  replayOf,
  resolveScope,
  submissionVerdict,
  unknownDependencyChoices,
  runtimeKindOf,
  runtimePath,
  SANDBOX_BUILD_RUN_VERSION,
  SANDBOX_TOOLCHAIN,
  toolOfParams,
  toolVersionOf,
  validateAliasRules,
} from "../src/index.js";
import type {
  AliasRule,
  ApprovedTaskSnapshot,
  BoundaryContract,
  SandboxBuildManifest,
  SliceManifest,
  VersionSourceRecord,
} from "../src/index.js";

const rule = (
  before: string,
  after: string,
  kind: AliasRule["kind"] = "identifier",
  paths: string[] = [],
): AliasRule => ({ before, after, kind, paths });

test("alias rules are validated as a set: empty, identity, duplicates, chains and casing", () => {
  const problems = validateAliasRules([
    rule("", "x"),
    rule("same", "same"),
    rule("Acme", "Widget"),
    rule("Acme", "Other"),
    rule("Zed", "Widget"),
    rule("Widget", "Final"),
    rule("acme", "Lower"),
    rule("bad name", "ok"),
    rule("../x", "y", "path"),
    { before: "a", after: "b", kind: "weird" as never, paths: [] },
  ]).problems.map((problem) => problem.code);
  for (const code of [
    "empty",
    "identity",
    "duplicate_source",
    "duplicate_target",
    "chained",
    "casing_variant",
    "invalid_identifier",
    "invalid_path",
    "unsupported_kind",
  ])
    assert.ok(
      problems.includes(code as never),
      `${code} missing in ${problems.join()}`,
    );
  assert.equal(validateAliasRules([rule("Acme", "Widget")]).ok, true);
  assert.equal(
    validateAliasRules(
      Array.from({ length: 501 }, (_, i) => rule(`a${i}`, `b${i}`)),
    ).problems[0]?.code,
    "too_many",
  );
  // Rules in disjoint scopes may chain without interacting.
  assert.equal(
    validateAliasRules([
      rule("a", "b", "identifier", ["src/x.ts"]),
      rule("b", "c", "identifier", ["lib/y.ts"]),
    ]).ok,
    true,
  );
});

test("aliases apply to whole identifiers only, rename paths, and prove the inverse", () => {
  const files = [
    {
      path: "src/acme/app.ts",
      text: "import { AcmeClient } from './client.js';\nconst acmeClientX = new AcmeClient(); // AcmeClient\n",
    },
    { path: "lib/other.ts", text: "export const AcmeClient = 1;\n" },
  ];
  const result = applyAliases(files, [
    rule("AcmeClient", "WidgetClient", "identifier", ["src"]),
    rule("src/acme", "src/vendor", "path"),
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.renames, [
    { from: "src/acme/app.ts", to: "src/vendor/app.ts" },
  ]);
  assert.equal(
    result.files[0]?.text,
    "import { WidgetClient } from './client.js';\nconst acmeClientX = new WidgetClient(); // WidgetClient\n",
  );
  // Out of scope: untouched.
  assert.equal(result.files[1]?.text, files[1]?.text);
  assert.deepEqual(result.applied, [3, 1]);
  const inverse = invertAliasRules([rule("a", "b"), rule("c", "d")]);
  assert.deepEqual(
    inverse.map((r) => [r.before, r.after]),
    [
      ["d", "c"],
      ["b", "a"],
    ],
  );
});

test("a public file reads back in its private names through the inverse table", () => {
  const rules = [
    rule("AcmeClient", "WidgetClient"),
    rule("Acme", "the vendor", "text", ["src"]),
  ];
  const private_ = {
    path: "src/app.ts",
    text: "// Acme's client\nnew AcmeClient();\n",
  };
  const applied = applyAliases([private_], rules);
  assert.equal(applied.ok, true);
  const stored = applied.files[0];
  assert.ok(stored !== undefined);
  assert.equal(stored.text, "// the vendor's client\nnew WidgetClient();\n");
  assert.deepEqual(renameFile(stored, invertAliasRules(rules)), private_);
  // A scoped rule leaves a file outside its scope alone.
  assert.equal(
    renameFile(
      { path: "README.md", text: "the vendor" },
      invertAliasRules(rules),
    ).text,
    "the vendor",
  );
});

test("a target already present in the text is a collision, not a silent merge", () => {
  const collision = applyAliases(
    [{ path: "a.ts", text: "const Widget = 1; const Acme = Widget;" }],
    [rule("Acme", "Widget")],
  );
  assert.equal(collision.ok, false);
  assert.equal(collision.problems[0]?.code, "target_collision");
  assert.equal(collision.files.length, 0);
  const invalid = applyAliases([], [rule("x", "x")]);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.problems[0]?.code, "identity");
  const text = applyAliases(
    [{ path: "README.md", text: "Acme Corp ships AcmeCorp" }],
    [rule("Acme Corp", "Widget Co", "text")],
  );
  assert.equal(text.ok, true);
  assert.equal(text.files[0]?.text, "Widget Co ships AcmeCorp");
  // Two files aliased onto one path collide.
  const shared = applyAliases(
    [
      { path: "a/x.ts", text: "" },
      { path: "b/x.ts", text: "" },
    ],
    [rule("a", "b", "path")],
  );
  assert.equal(shared.ok, false);
  assert.ok(shared.problems.some((p) => p.code === "target_collision"));
});

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
      sizeBytes: 10,
      operations: ["edit"],
    },
  ],
  synthetic: [
    {
      path: "stubs/lib/service.d.ts",
      kind: "stub",
      generator: "typescript-declaration-emit",
      generatorVersion: "typescript@5.9.3",
      sha256: "e".repeat(64),
      sizeBytes: 5,
    },
  ],
  requiredBuildInputs: {
    configs: ["package.json"],
    packages: [
      { name: "pg", version: "^8.11.0", declaredIn: "package.json" },
      { name: "zod", version: "^4.0.0", declaredIn: "package.json" },
      { name: "left-pad", version: null, declaredIn: null },
    ],
  },
  cuts: {
    outbound: [
      {
        from: "src/app.ts",
        to: "lib/service.ts",
        relation: "imports",
        specifier: "../lib/service.js",
        location: "L1",
        targetSymbol: null,
      },
      {
        from: "src/app.ts",
        to: "lib/alias.ts",
        relation: "imports",
        specifier: "@lib/alias",
        location: "L2",
        targetSymbol: null,
      },
    ],
    inbound: [],
  },
  internalImports: [],
  externals: {
    packages: [{ specifier: "pg", service: "postgres", files: ["src/app.ts"] }],
    environment: [{ name: "DATABASE_URL", files: ["src/app.ts"] }],
  },
  communities: [0],
  blockers: [],
  policy: OPERATION_POLICY,
  boundaryContractSha256: "f".repeat(64),
  meta: {
    includedFiles: 1,
    includedBytes: 10,
    outboundCuts: 2,
    inboundCuts: 0,
    stubCoverage: "full",
    externals: 2,
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
  outbound: [
    {
      module: "lib/service.ts",
      symbols: [
        {
          name: "ServiceOptions",
          kind: "interface",
          declaration: "export interface ServiceOptions {}",
        },
        {
          name: "createService",
          kind: "function",
          declaration: "export declare function createService(): Service;",
        },
        {
          name: "Service",
          kind: "class",
          declaration: "export declare class Service {}",
        },
        {
          name: "Mode",
          kind: "enum",
          declaration:
            'export declare enum Mode { Fast = 0, Slow = 2, Named = "n", Next }',
        },
        {
          name: "default",
          kind: "variable",
          declaration:
            "declare const _default: number; export default _default;",
        },
      ],
      importedBy: ["src/app.ts"],
      stubPath: "stubs/lib/service.d.ts",
    },
    {
      module: "lib/alias.ts",
      symbols: [
        {
          name: "fromAlias",
          kind: "variable",
          declaration: "export declare const fromAlias: string;",
        },
      ],
      importedBy: ["src/app.ts"],
      stubPath: "stubs/lib/alias.d.ts",
    },
  ],
  inbound: [
    {
      module: "src/app.ts",
      symbols: [
        {
          name: "run",
          kind: "function",
          declaration: "export declare function run(): void;",
        },
        {
          name: "Options",
          kind: "type",
          declaration: "export type Options = {};",
        },
      ],
      importedBy: ["consumers/cli.ts"],
      stubPath: null,
    },
  ],
  stubCoverage: "full",
  compilation: {
    attempted: true,
    ok: true,
    diagnostics: [],
    shimmedPackages: ["pg"],
  },
  blockers: [],
};

test("a mock needs no pin, and a choice must name a package the slice requires", () => {
  const mocked = resolveScope({
    manifest,
    contract,
    choices: { "left-pad": "runtime-mock" },
  });
  assert.deepEqual(mocked.blockers, []);
  assert.deepEqual(
    mocked.dependencies.find((d) => d.name === "left-pad"),
    {
      name: "left-pad",
      kind: "package",
      version: null,
      resolution: "runtime-mock",
      detail: "Replaced by a generated recording mock package.",
    },
  );
  // Installing still needs the pin.
  assert.equal(
    resolveScope({
      manifest,
      contract,
      choices: { "left-pad": "approved-package" },
    }).blockers[0]?.code,
    "dependency_unresolved",
  );
  assert.deepEqual(
    unknownDependencyChoices(manifest, {
      zod: "runtime-mock",
      "lfet-pad": "runtime-mock",
      axios: "approved-package",
    }),
    ["axios", "lfet-pad"],
  );
  assert.deepEqual(
    unknownDependencyChoices(manifest, { pg: "runtime-mock" }),
    [],
  );
});

test("scope resolution classifies every dependency and blocks what it cannot satisfy", () => {
  const scope = resolveScope({
    manifest,
    contract,
    choices: { zod: "runtime-mock" },
  });
  assert.deepEqual(scope.editablePaths, ["src/app.ts"]);
  assert.deepEqual(scope.generatedPaths, ["stubs/lib/service.d.ts"]);
  assert.deepEqual(scope.permittedOperations, ["edit"]);
  assert.deepEqual(
    scope.dependencies.map((d) => [d.name, d.kind, d.resolution]),
    [
      ["lib/alias.ts", "module", "runtime-mock"],
      ["lib/service.ts", "module", "runtime-mock"],
      ["left-pad", "package", "unresolved"],
      ["pg", "package", "runtime-mock"],
      ["zod", "package", "runtime-mock"],
    ],
  );
  assert.deepEqual(
    scope.blockers.map((b) => b.code),
    ["dependency_unresolved"],
  );
  const partial = resolveScope({
    manifest: {
      ...manifest,
      meta: { ...manifest.meta, ready: false, stubCoverage: "partial" },
      blockers: [
        {
          code: "dynamic_dependency",
          file: "src/app.ts",
          location: "L9",
          detail: "computed import",
        },
      ],
    },
    contract: {
      ...contract,
      stubCoverage: "partial",
      outbound: [
        {
          module: "lib/x.ts",
          symbols: [{ name: "x", kind: "unknown", declaration: null }],
          importedBy: [],
          stubPath: null,
        },
      ],
    },
  });
  assert.deepEqual(
    partial.blockers.map((b) => b.code),
    [
      "slice_not_ready",
      "partial_signature_coverage",
      "dependency_unresolved",
      "dependency_unresolved",
      "dependency_unresolved",
    ],
  );
  assert.equal(packageNameOf("@aws-sdk/client-s3/dist"), "@aws-sdk/client-s3");
  assert.equal(packageNameOf("pg/lib"), "pg");
});

const source: VersionSourceRecord = {
  sandboxVersionId: "sbv_1",
  origin: "slice",
  sourceSnapshotId: "rsn_1",
  sliceRunId: "arn_slice",
  manifestSha256: "m".repeat(64),
  starterRunId: null,
  starterSha256: null,
  transformConfigSha256: "t".repeat(64),
  approvedTaskSha256: "a".repeat(64),
  aliasRules: [rule("Acme", "Widget")],
  contractSha256: "c".repeat(64),
  harnessSha256: "h".repeat(64),
  toolchainDigest: "d".repeat(64),
  buildRunId: "arn_build",
  roundTripRunId: "arn_rt",
  disclosureRunId: "arn_scan",
  approvedBy: "user_1",
  approvedAt: "2026-10-02T00:00:00.000Z",
};

test("freeze needs matching evidence for every gate, and replay never substitutes a branch", () => {
  const evidence = {
    buildManifestSha256: source.manifestSha256,
    buildTransformSha256: source.transformConfigSha256,
    buildApprovedTaskSha256: source.approvedTaskSha256,
    baselineOk: true,
    roundTripOk: true,
    disclosureBlocking: 0,
  };
  assert.deepEqual(freezeReadiness(source, evidence), {
    ready: true,
    reasons: [],
  });
  const stale = freezeReadiness(
    {
      ...source,
      harnessSha256: null,
      toolchainDigest: null,
      approvedBy: null,
      disclosureRunId: null,
      roundTripRunId: null,
    },
    {
      ...evidence,
      buildManifestSha256: "x",
      buildTransformSha256: "y",
      buildApprovedTaskSha256: "z",
      baselineOk: false,
      roundTripOk: false,
      disclosureBlocking: null,
    },
  );
  assert.equal(stale.ready, false);
  assert.equal(stale.reasons.length, 9);
  const noBuild = freezeReadiness(
    { ...source, buildRunId: null },
    { ...evidence, disclosureBlocking: 2 },
  );
  assert.ok(noBuild.reasons.includes("No build run is recorded."));
  assert.ok(
    noBuild.reasons.includes("The disclosure scan has blocking findings."),
  );
  const replay = replayOf(
    source,
    { commitSha: "a".repeat(40), repoGone: false },
    { status: "succeeded", artifactsPresent: true },
  );
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.sourceCommitSha, "a".repeat(40));
  for (const [snapshot, run] of [
    [null, null],
    [{ commitSha: "a", repoGone: true }, null],
    [{ commitSha: "a", repoGone: false }, null],
    [
      { commitSha: "a", repoGone: false },
      { status: "failed", artifactsPresent: false },
    ],
  ] as const) {
    const result = replayOf(source, snapshot, run);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "source_unavailable");
  }
  // A generated version has no source at all to replay.
  const generated = replayOf(
    {
      ...source,
      origin: "starter",
      sourceSnapshotId: null,
      sliceRunId: null,
      manifestSha256: null,
      contractSha256: null,
      starterRunId: "arn_starter",
      starterSha256: "s".repeat(64),
    },
    { commitSha: "a".repeat(40), repoGone: false },
    { status: "succeeded", artifactsPresent: true },
  );
  assert.equal(generated.ok, false);
  if (!generated.ok) assert.match(generated.detail, /generated, not sliced/);
});

test("an approved task snapshot is ready only with a usable spec and an approved price", () => {
  const snapshot: ApprovedTaskSnapshot = {
    schemaVersion: 3,
    title: "Fix the thing",
    summary: "It is broken.",
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
            kind: "happy-path" as never,
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
      decidedAt: null,
    },
    selectedBy: "user_1",
    selectedAt: "2026-10-02T00:00:00.000Z",
    bountyId: "bty_1",
  };
  assert.deepEqual(approvedTaskReadiness(snapshot), {
    ready: true,
    reasons: [],
  });
  // Versions frozen under the older links are still read the same way.
  const { bountyId: _bountyId, ...selection } = snapshot;
  assert.deepEqual(
    approvedTaskReadiness({
      ...selection,
      schemaVersion: 2,
      ticketIds: ["tkt_1", "tkt_2"],
    }),
    { ready: true, reasons: [] },
  );
  assert.deepEqual(
    approvedTaskReadiness({
      ...selection,
      schemaVersion: 1,
      jiraIssueIds: ["jri_1"],
    }),
    { ready: true, reasons: [] },
  );
  const bad = approvedTaskReadiness({
    ...snapshot,
    title: " ",
    summary: "",
    spec: {
      ...snapshot.spec!,
      draft: { ...snapshot.spec!.draft, scenarios: [] },
    },
    pricing: { ...snapshot.pricing!, status: "proposed" },
  });
  assert.equal(bad.reasons.length, 4);
  assert.equal(
    approvedTaskReadiness({ ...snapshot, spec: null, pricing: null }).reasons
      .length,
    1,
  );
});

test("the baseline verdict accepts only expected hidden-test outcomes over a green harness", () => {
  const ok = baselineVerdict({
    steps: [
      {
        name: "install",
        argv: ["npm", "ci"],
        exitCode: 0,
        timedOut: false,
        ok: true,
        path: null,
      },
      {
        name: "private-test",
        argv: [],
        exitCode: 1,
        timedOut: false,
        ok: true,
        path: "tests/private/a.test.ts",
      },
    ],
    privateTests: [
      {
        path: "tests/private/a.test.ts",
        expected: "fail",
        observed: "fail",
        ok: true,
      },
    ],
  });
  assert.deepEqual(ok, { ok: true, reasons: [] });
  const bad = baselineVerdict({
    steps: [
      {
        name: "build",
        argv: [],
        exitCode: 2,
        timedOut: false,
        ok: false,
        path: null,
      },
      {
        name: "public-tests",
        argv: [],
        exitCode: null,
        timedOut: true,
        ok: false,
        path: null,
      },
    ],
    privateTests: [
      {
        path: "tests/private/a.test.ts",
        expected: "pass",
        observed: "fail",
        ok: false,
      },
      {
        path: "tests/private/b.test.ts",
        expected: "pass",
        observed: "error",
        ok: false,
      },
    ],
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.reasons, [
    "build exited with 2.",
    "public-tests timed out.",
    "tests/private/a.test.ts was expected to pass on the baseline and failed.",
    "tests/private/b.test.ts could not run.",
  ]);
});

test("path helpers map TypeScript paths to their emitted and declaration forms", () => {
  assert.equal(
    relativeSpecifier("src/app.ts", "lib/service.ts"),
    "../lib/service.js",
  );
  assert.equal(relativeSpecifier("src/app.ts", "src/util.ts"), "./util.js");
  assert.equal(relativeSpecifier("a/b/c.ts", "a/d.mts"), "../d.mjs");
  assert.equal(
    relativeSpecifier("x.ts", "sandbox/mock.js"),
    "./sandbox/mock.js",
  );
  assert.equal(runtimePath("a.tsx"), "a.js");
  assert.equal(runtimePath("a.cts"), "a.cjs");
  assert.equal(runtimePath("a.d.ts"), "a.js");
  assert.equal(runtimePath("a.json"), "a.json");
  assert.equal(declarationPath("lib/x.ts"), "lib/x.d.ts");
  assert.equal(declarationPath("lib/x.tsx"), "lib/x.d.ts");
  assert.equal(declarationPath("lib/x.mts"), "lib/x.d.mts");
  assert.equal(declarationPath("lib/x.cts"), "lib/x.d.cts");
  assert.equal(declarationPath("lib/x.jsx"), "lib/x.d.ts");
  assert.equal(declarationPath("lib/x.d.ts"), "lib/x.d.ts");
  assert.equal(declarationPath("lib/x"), "lib/x.d.ts");
  assert.deepEqual(
    enumMembers("enum E { A, B = 5, C, D = 'd', 'quoted' = 1 }"),
    [
      { name: "A", value: 0 },
      { name: "B", value: 5 },
      { name: "C", value: 6 },
      { name: "D", value: "d" },
      { name: "quoted", value: 1 },
    ],
  );
  assert.equal(enumMembers("enum E { A = compute() }"), null);
  assert.equal(enumMembers("enum E { = }"), null);
  assert.equal(enumMembers("not an enum"), null);
  assert.equal(toolVersionOf("sandbox_build"), SANDBOX_BUILD_RUN_VERSION);
  assert.equal(
    toolOfParams({
      deadlineMinutes: 1,
      sliceRunId: "a",
      sandboxVersionId: "b",
      manifestSha256: "",
      contractSha256: "",
      transformConfigSha256: "",
      approvedTaskSha256: "",
    }),
    "sandbox_build",
  );
  assert.equal(toolOfParams({ deadlineMinutes: 1 }), "graphify");
  assert.equal(toolOfParams(manifest.params), "slice");
});

function project(
  overrides: Partial<Parameters<typeof generateProject>[0]> = {},
) {
  return generateProject({
    version: {
      sandboxId: "sbx_1",
      versionId: "sbv_1",
      version: 1,
      title: "Fix the widget",
      specSummary: "Make it work.",
      complexity: "M",
      tags: ["typescript"],
    },
    manifest,
    contract,
    sources: [
      {
        originalPath: "src/app.ts",
        path: "src/app.ts",
        text: 'import { createService, type ServiceOptions } from "../lib/service.js";\nimport { fromAlias } from "@lib/alias";\nimport pg, { Client as PgClient, type Pool } from "pg";\nimport type { PoolConfig } from "pg";\nimport { z } from "zod";\nimport { readFileSync } from "node:fs";\nexport function run() { return createService(); }\n',
      },
    ],
    stubs: [
      {
        module: "lib/service.ts",
        path: "lib/service.ts",
        text: 'import type { Config } from "./types.js";\nexport declare function createService(): Service;\n',
      },
      {
        module: "lib/alias.ts",
        path: "lib/alias.ts",
        text: "export declare const fromAlias: string;\n",
      },
      {
        module: "lib/types.ts",
        path: "lib/types.ts",
        text: "export interface Config {}\n",
      },
    ],
    spec: {
      feature: "Widget",
      background: ["a widget exists"],
      scenarios: [
        {
          id: "s1",
          kind: "happy-path" as never,
          title: 'It "works"',
          steps: [
            { keyword: "Given", text: "a thing" },
            { keyword: "Then", text: "it works" },
          ],
          origin: "draft",
        },
      ],
      openQuestions: [],
      assumptions: [],
    },
    dependencies: resolveScope({ manifest, contract }).dependencies.filter(
      (d) => d.resolution !== "unresolved",
    ),
    acceptanceTests: [
      {
        path: "tests/private/fix.test.ts",
        text: "import { test } from 'node:test'; test('x', () => {});",
        expectedBaseline: "fail",
      },
      { path: "tests/public/evil.test.ts", text: "", expectedBaseline: "pass" },
      {
        path: "tests/private/../x.test.ts",
        text: "",
        expectedBaseline: "pass",
      },
    ],
    knownSpecifiers: ["fs", "path", "node:fs"],
    compilerOptions: { strict: false, outDir: "dist", target: "ES2020" },
    ...overrides,
  });
}

test("the generated project is standalone: rewritten imports, stubs beside mocks, mock packages, tests and config", () => {
  const result = project();
  const byPath = new Map(result.files.map((file) => [file.path, file]));
  const app = byPath.get("src/app.ts");
  assert.equal(app?.class, "source");
  assert.match(app?.text ?? "", /from "\.\.\/lib\/alias\.js"/);
  assert.match(app?.text ?? "", /from "\.\.\/lib\/service\.js"/);
  assert.match(app?.text ?? "", /from "pg"/);
  assert.deepEqual(result.importRewrites, [
    { file: "src/app.ts", from: "@lib/alias", to: "../lib/alias.js" },
  ]);
  assert.equal(byPath.get("lib/service.d.ts")?.class, "stub");
  const runtime = byPath.get("lib/service.js");
  assert.equal(runtime?.class, "mock");
  assert.match(
    runtime?.text ?? "",
    /import \{ createMock \} from "\.\.\/sandbox\/mock\.js";/,
  );
  assert.match(
    runtime?.text ?? "",
    /export const createService = mock\["createService"\];/,
  );
  assert.match(
    runtime?.text ?? "",
    /export const Service = mock\["Service"\];/,
  );
  assert.match(
    runtime?.text ?? "",
    /export const Mode = Object\.freeze\(\{ "Fast": 0, "0": "Fast", "Slow": 2, "2": "Slow", "Named": "n", "Next": 3, "3": "Next" \}\);/,
  );
  assert.match(runtime?.text ?? "", /export default mock\.default;/);
  assert.doesNotMatch(runtime?.text ?? "", /ServiceOptions/);
  assert.equal(byPath.get("lib/types.js")?.text, "export {};\n");
  assert.equal(byPath.get("lib/types.d.ts")?.class, "stub");
  // The service package is a local mock package with the imported names.
  const pgIndex = byPath.get("mocks/pg/index.js");
  assert.match(pgIndex?.text ?? "", /export default mock;/);
  assert.match(pgIndex?.text ?? "", /export const Client = mock\["Client"\];/);
  assert.doesNotMatch(pgIndex?.text ?? "", /Pool/);
  assert.doesNotMatch(pgIndex?.text ?? "", /PgClient/);
  assert.match(
    byPath.get("mocks/pg/index.d.ts")?.text ?? "",
    /export const Client: any;/,
  );
  assert.match(byPath.get("mocks/pg/package.json")?.text ?? "", /"name": "pg"/);
  const pkg = JSON.parse(byPath.get("package.json")?.text ?? "{}") as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
    engines: { node: string };
  };
  assert.deepEqual(pkg.dependencies, { pg: "file:mocks/pg", zod: "^4.0.0" });
  assert.deepEqual(pkg.devDependencies, {
    typescript: SANDBOX_TOOLCHAIN.typescript,
  });
  assert.equal(pkg.engines.node, SANDBOX_TOOLCHAIN.nodeRange);
  assert.match(pkg.scripts["test"] ?? "", /tests\/public/);
  assert.doesNotMatch(pkg.scripts["test"] ?? "", /private/);
  const tsconfig = JSON.parse(byPath.get("tsconfig.json")?.text ?? "{}") as {
    compilerOptions: Record<string, unknown>;
  };
  assert.equal(tsconfig.compilerOptions["strict"], false);
  assert.equal(tsconfig.compilerOptions["target"], "ES2020");
  assert.equal(tsconfig.compilerOptions["outDir"], undefined);
  assert.equal(tsconfig.compilerOptions["module"], "NodeNext");
  assert.match(
    byPath.get("sandbox/ambient.d.ts")?.text ?? "",
    /declare module "zod";/,
  );
  assert.match(
    byPath.get("sandbox/ambient.d.ts")?.text ?? "",
    /declare module "pg";/,
  );
  // Bare Node module names resolve too, not only `node:` ones.
  assert.match(
    byPath.get("sandbox/ambient.d.ts")?.text ?? "",
    /declare module "fs";\ndeclare module "fs\/\*";/,
  );
  assert.match(
    byPath.get("sandbox/run.ts")?.text ?? "",
    /import\("\.\.\/src\/app\.js"\)/,
  );
  assert.equal(
    byPath
      .get("sandbox.env")
      ?.text.includes("DATABASE_URL=sandbox-fixture-database-url"),
    true,
  );
  assert.match(
    byPath.get(".gitignore")?.text ?? "",
    /^node_modules\/\nsandbox\/run\.js\nsrc\/app\.js\ntests\/private\/fix\.test\.js\ntests\/public\/interface\.test\.js\ntests\/public\/spec\.test\.js\n$/,
  );
  // Tests: public interface and scenarios, private ones only where allowed.
  const iface = byPath.get("tests/public/interface.test.ts");
  assert.equal(iface?.public, true);
  assert.match(iface?.text ?? "", /await import\("\.\.\/\.\.\/src\/app\.js"\)/);
  assert.match(iface?.text ?? "", /module\["run"\]/);
  assert.doesNotMatch(iface?.text ?? "", /Options/);
  const spec = byPath.get("tests/public/spec.test.ts");
  assert.match(
    spec?.text ?? "",
    /test\("s1: It \\"works\\"", \{ todo: true \}/,
  );
  assert.match(spec?.text ?? "", /\/\/ Background: a widget exists/);
  assert.match(spec?.text ?? "", /\/\/ Then it works/);
  assert.equal(byPath.get("tests/private/fix.test.ts")?.public, false);
  assert.equal(byPath.has("tests/public/evil.test.ts"), false);
  assert.deepEqual(
    result.blockers.map((b) => [b.code, b.file]),
    [
      ["test_path_invalid", "tests/public/evil.test.ts"],
      ["test_path_invalid", "tests/private/../x.test.ts"],
    ],
  );
  assert.deepEqual(result.publicTests, [
    "tests/public/interface.test.ts",
    "tests/public/spec.test.ts",
  ]);
  assert.equal(result.descriptor.versionId, "sbv_1");
  assert.deepEqual(result.descriptor.editablePaths, ["src/app.ts"]);
  assert.deepEqual(
    descriptorPublic(JSON.parse(byPath.get("sandbox-task.json")?.text ?? "")),
    { ok: true, offending: [] },
  );
  assert.deepEqual(
    descriptorPublic({ a: { aliasRules: [], b: [{ sourceCommitSha: "x" }] } }),
    {
      ok: false,
      offending: ["a.aliasRules", "a.b[0].sourceCommitSha"],
    },
  );
  const readme = byPath.get("README.md")?.text ?? "";
  assert.match(readme, /# Fix the widget/);
  assert.match(readme, /`@lib\/alias` → `\.\.\/lib\/alias\.js`/);
  assert.match(readme, /zod@\^4\.0\.0/);
  // Deterministic.
  assert.deepEqual(project().files, result.files);
  // Sorted.
  assert.deepEqual(
    result.files.map((f) => f.path),
    [...result.files.map((f) => f.path)].sort(),
  );
});

test("the generator refuses what it cannot explain: unknown bare imports, missing stubs, unknown symbol kinds", () => {
  const result = project({
    sources: [
      {
        originalPath: "src/app.ts",
        path: "src/app.ts",
        text: 'import x from "mystery";\nimport y from "@lib/alias";\n',
      },
    ],
    stubs: [{ module: "lib/alias.ts", path: "lib/alias.ts", text: "" }],
    contract: {
      ...contract,
      outbound: [
        {
          module: "lib/service.ts",
          symbols: [],
          importedBy: [],
          stubPath: null,
        },
        {
          module: "lib/alias.ts",
          symbols: [
            { name: "fromAlias", kind: "unknown", declaration: null },
            { name: "Bad", kind: "enum", declaration: "enum Bad { A = f() }" },
          ],
          importedBy: [],
          stubPath: null,
        },
      ],
      inbound: [],
    },
    spec: null,
    acceptanceTests: [],
  });
  assert.deepEqual(result.blockers.map((b) => b.code).sort(), [
    "import_unrewritable",
    "mock_unsupported",
    "mock_unsupported",
    "mock_unsupported",
  ]);
  const alias = result.files.find((f) => f.path === "lib/alias.js");
  assert.equal(alias?.text.includes("export {};"), true);
  // With nothing inbound, the interface test checks the entry points load.
  assert.match(
    result.files.find((f) => f.path === "tests/public/interface.test.ts")
      ?.text ?? "",
    /src\/app\.ts loads/,
  );
  assert.match(
    result.files.find((f) => f.path === "tests/public/spec.test.ts")?.text ??
      "",
    /names no scenarios yet/,
  );
  const empty = project({
    sources: [],
    stubs: [],
    contract: { ...contract, outbound: [], inbound: [] },
    manifest: {
      ...manifest,
      entryPoints: [],
      externals: { packages: [], environment: [] },
    },
    dependencies: [],
    acceptanceTests: [],
    spec: null,
  });
  assert.match(
    empty.files.find((f) => f.path === "sandbox/run.ts")?.text ?? "",
    /No entry points/,
  );
  assert.match(
    empty.files.find((f) => f.path === "README.md")?.text ?? "",
    /No editable files/,
  );
  const conflict = project({
    sources: [{ originalPath: "a.ts", path: "package.json", text: "" }],
    acceptanceTests: [],
  });
  assert.ok(conflict.blockers.some((b) => b.code === "path_conflict"));
});

test("imports inside the slice follow path aliases and moved files; JavaScript sources are refused", () => {
  const edge = (from: string, to: string, specifier: string) => ({
    from,
    to,
    relation: "imports",
    specifier,
    location: null,
    targetSymbol: null,
  });
  const result = project({
    manifest: {
      ...manifest,
      internalImports: [
        edge("src/app.ts", "src/util.ts", "@/util"),
        edge("src/app.ts", "src/acme/a.ts", "./acme/a.js"),
        edge("src/acme/a.ts", "src/util.ts", "../util.js"),
        edge("src/acme/a.ts", "src/acme/b.ts", "./b.js"),
      ],
    },
    sources: [
      {
        originalPath: "src/app.ts",
        path: "src/app.ts",
        text: 'import { u } from "@/util";\nimport { a } from "./acme/a.js";\nimport { s } from "../lib/service.js";\nimport { gone } from "./unrecorded.js";\n// import old from "@/removed";\n/**\n * import { example } from "doc-only";\n */\n',
      },
      {
        originalPath: "src/util.ts",
        path: "src/util.ts",
        text: "export const u = 1;\n",
      },
      {
        originalPath: "src/acme/a.ts",
        path: "src/vendor/a.ts",
        text: 'import { u } from "../util.js";\nimport { b } from "./b.js";\nexport const a = u + b;\n',
      },
      {
        originalPath: "src/acme/b.ts",
        path: "src/vendor/b.ts",
        text: "export const b = 1;\n",
      },
      {
        originalPath: "src/legacy.js",
        path: "src/legacy.js",
        text: "module.exports = 1;\n",
      },
    ],
    acceptanceTests: [],
  });
  assert.deepEqual(result.importRewrites, [
    { file: "src/app.ts", from: "./acme/a.js", to: "./vendor/a.js" },
    { file: "src/app.ts", from: "@/util", to: "./util.js" },
  ]);
  const app = result.files.find((f) => f.path === "src/app.ts")?.text ?? "";
  assert.match(app, /from "\.\/util\.js"/);
  assert.match(app, /from "\.\/vendor\/a\.js"/);
  // A cut module's relative import and one the graph never saw stay put.
  assert.match(app, /from "\.\.\/lib\/service\.js"/);
  assert.match(app, /from "\.\/unrecorded\.js"/);
  // Both ends moved together: the relative imports still hold.
  assert.equal(
    result.files.find((f) => f.path === "src/vendor/a.ts")?.text,
    'import { u } from "../util.js";\nimport { b } from "./b.js";\nexport const a = u + b;\n',
  );
  // Commented-out and documented imports are neither rewritten nor blocked.
  assert.deepEqual(
    result.blockers.map((b) => [b.code, b.file]),
    [["language_unsupported", "src/legacy.js"]],
  );
  assert.match(
    result.files.find((f) => f.path === "tsconfig.json")?.text ?? "",
    /"\*\*\/\*\.tsx"/,
  );
});

test("a mock exports a name that is not an identifier under its string name", () => {
  const result = project({
    contract: {
      ...contract,
      outbound: [
        {
          module: "lib/service.ts",
          symbols: [
            {
              name: "delete",
              kind: "function",
              declaration: "export declare function remove(): void;",
            },
            {
              name: "ok",
              kind: "variable",
              declaration: "export declare const ok: number;",
            },
          ],
          importedBy: ["src/app.ts"],
          stubPath: "stubs/lib/service.d.ts",
        },
      ],
      inbound: [],
    },
    acceptanceTests: [],
  });
  const runtime =
    result.files.find((f) => f.path === "lib/service.js")?.text ?? "";
  assert.match(
    runtime,
    /const __export0 = mock\["delete"\];\nexport \{ __export0 as "delete" \};/,
  );
  assert.match(runtime, /export const ok = mock\["ok"\];/);
});

test("an unknown kind is read from its declaration before it blocks a mock", () => {
  const of = (kind: string, declaration: string | null) =>
    runtimeKindOf({ name: "X", kind, declaration });
  assert.equal(
    of("unknown", 'export type { Thing } from "./origin.js";'),
    "type",
  );
  assert.equal(of("unknown", "export interface X {}"), "type");
  assert.equal(of("unknown", "type X = string;"), "type");
  assert.equal(of("unknown", "export declare const enum X { A }"), "enum");
  assert.equal(of("unknown", "export declare function X(): void;"), "value");
  assert.equal(of("unknown", "export declare abstract class X {}"), "value");
  assert.equal(of("unknown", "export { X } from './y.js';"), "value");
  assert.equal(of("unknown", "export default X;"), "value");
  assert.equal(of("unknown", null), "unknown");
  assert.equal(of("unknown", "   "), "unknown");
  assert.equal(of("unknown", "weird text"), "unknown");
  assert.equal(of("interface", null), "type");
  assert.equal(of("class", null), "value");
  assert.equal(of("enum", null), "enum");
});

test("the build summary bounds what the console sees", () => {
  const build: SandboxBuildManifest = {
    schemaVersion: 1,
    toolVersion: SANDBOX_BUILD_RUN_VERSION,
    sandboxVersionId: "sbv_1",
    sourceSnapshotId: "rsn_1",
    sourceCommitSha: "a".repeat(40),
    sliceRunId: "arn_slice",
    manifestSha256: "m".repeat(64),
    contractSha256: "c".repeat(64),
    transformConfigSha256: "t".repeat(64),
    approvedTaskSha256: "a".repeat(64),
    toolchain: SANDBOX_TOOLCHAIN,
    toolchainDigest: "d".repeat(64),
    evaluator: { provider: "fake", environmentId: "job", templateDigest: null },
    files: [
      {
        path: "src/app.ts",
        sha256: "1".repeat(64),
        sizeBytes: 1,
        class: "source",
        public: true,
      },
      {
        path: "tests/private/x.test.ts",
        sha256: "2".repeat(64),
        sizeBytes: 1,
        class: "test-private",
        public: false,
      },
      {
        path: "tests/public/x.test.ts",
        sha256: "3".repeat(64),
        sizeBytes: 1,
        class: "test-public",
        public: true,
      },
      {
        path: "lib/a.js",
        sha256: "4".repeat(64),
        sizeBytes: 1,
        class: "mock",
        public: true,
      },
    ],
    importRewrites: [{ file: "a", from: "b", to: "c" }],
    renames: [],
    dependencies: [],
    harnessSha256: "h".repeat(64),
    publicTestsSha256: "p".repeat(64),
    privateTestsSha256: "q".repeat(64),
    publicProjectSha256: "r".repeat(64),
    baseline: {
      executions: [],
      steps: [
        {
          name: "install",
          argv: [],
          exitCode: 0,
          timedOut: false,
          ok: true,
          path: null,
        },
        {
          name: "private-test",
          argv: [],
          exitCode: 1,
          timedOut: false,
          ok: true,
          path: "tests/private/x.test.ts",
        },
      ],
      privateTests: [],
      ok: true,
      reasons: [],
    },
    blockers: [],
    ready: true,
  };
  const summary = buildSummary(build);
  assert.equal(summary.files, 4);
  assert.equal(summary.publicFiles, 3);
  assert.equal(summary.privateTests, 1);
  assert.equal(summary.publicTests, 1);
  assert.equal(summary.mocks, 1);
  assert.deepEqual(summary.baseline?.steps, [
    { name: "install", ok: true },
    { name: "private-test tests/private/x.test.ts", ok: true },
  ]);
  assert.equal(buildSummary({ ...build, baseline: null }).baseline, null);
});

test("fixtures give mocked calls default behaviour, and a walkthrough replaces the dev script", async () => {
  const scenario = [
    'import { run } from "../src/app.js";',
    'import { recordedCalls } from "./mock.js";',
    '// import { gone } from "./gone.js";',
    "console.log(run(), recordedCalls().length);",
    "",
  ].join("\n");
  const result = project({
    fixtures: [
      {
        module: "lib/service.ts",
        symbol: "createService",
        member: null,
        call: "call",
        implementation: "() => ({ id: 1 })\n",
        reason: "a service",
      },
    ],
    scenario,
  });
  const byPath = new Map(result.files.map((file) => [file.path, file]));
  const runtime = byPath.get("lib/service.js")?.text ?? "";
  assert.match(
    runtime,
    /import \{ createMock, fixture \} from "\.\.\/sandbox\/mock\.js";/,
  );
  assert.match(
    runtime,
    /fixture\("module:lib\/service\.ts\.createService", \(\) => \(\{ id: 1 \}\)\);/,
  );
  assert.equal(byPath.get("sandbox/run.ts")?.text, scenario);
  assert.match(
    byPath.get("README.md")?.text ?? "",
    /1 mocked call has default behaviour[\s\S]*walkthrough of the task's main scenario/,
  );
  assert.equal(
    result.blockers.some((blocker) => blocker.file === "sandbox/run.ts"),
    false,
  );
  // The runtime itself: fixtures answer, installed implementations override
  // them, and resetting keeps them.
  const dir = await mkdtemp(join(tmpdir(), "mock-runtime-"));
  try {
    const file = join(dir, "mock.mjs");
    await writeFile(file, byPath.get("sandbox/mock.js")?.text ?? "");
    const mock = (await import(pathToFileURL(file).href)) as {
      createMock(origin: string): Record<
        string,
        (...args: unknown[]) => unknown
      > & {
        new (...args: unknown[]): unknown;
      };
      fixture(path: string, fn: (...args: unknown[]) => unknown): void;
      mockImplementation(
        path: string,
        fn: (...args: unknown[]) => unknown,
      ): void;
      resetMocks(): void;
      recordedCalls(): { name: string }[];
    };
    const service = mock.createMock("module:lib/service.ts");
    mock.fixture("module:lib/service.ts.find", (id) => ({ id }));
    mock.fixture("new module:lib/service.ts.Client", () => ({ open: true }));
    assert.deepEqual(service["find"]?.(7), { id: 7 });
    assert.deepEqual(
      new (service["Client"] as unknown as new () => unknown)(),
      {
        open: true,
      },
    );
    mock.mockImplementation("module:lib/service.ts.find", () => "override");
    assert.equal(service["find"]?.(7), "override");
    mock.resetMocks();
    assert.deepEqual(service["find"]?.(8), { id: 8 });
    assert.equal(mock.recordedCalls().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const invalid = project({
    fixtures: [
      {
        module: "lib/nowhere.ts",
        symbol: "x",
        member: null,
        call: "call",
        implementation: "() => 1",
        reason: "",
      },
    ],
    scenario:
      'import { a } from "../src/missing.js";\nimport { b } from "../../outside.js";\nimport { c } from "../lib/service.js";\n',
  });
  assert.deepEqual(
    invalid.blockers
      .filter((blocker) =>
        ["fixture_invalid", "import_unrewritable"].includes(blocker.code),
      )
      .map((blocker) => `${blocker.code} ${blocker.file}: ${blocker.detail}`),
    [
      "fixture_invalid lib/nowhere.ts: lib/nowhere.ts is not a module the slice mocks.",
      "import_unrewritable sandbox/run.ts: ../src/missing.js does not resolve to a file in the project.",
      "import_unrewritable sandbox/run.ts: ../../outside.js does not resolve to a file in the project.",
    ],
  );
});

test("a submission passes only when every public and hidden test passed", () => {
  const all = { passed: 4, total: 4 };
  assert.equal(submissionVerdict({ public: all, hidden: all }), "passed");
  // A public suite with nothing in it does not hold a submission back.
  assert.equal(
    submissionVerdict({ public: { passed: 0, total: 0 }, hidden: all }),
    "passed",
  );
  assert.equal(
    submissionVerdict({ public: all, hidden: { passed: 3, total: 4 } }),
    "failed",
  );
  assert.equal(
    submissionVerdict({ public: { passed: 1, total: 2 }, hidden: all }),
    "failed",
  );
  // A hidden suite that ran nothing proves nothing.
  assert.equal(
    submissionVerdict({ public: all, hidden: { passed: 0, total: 0 } }),
    "failed",
  );
});
