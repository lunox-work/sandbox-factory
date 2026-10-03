import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createGraphifyAdapter } from "../dist/tools/graphify.js";
import { createSliceAdapter } from "../dist/tools/slice.js";
import { createSandboxBuildAdapter } from "../dist/tools/sandbox-build.js";
import { createLocalProcessProvider } from "../dist/evaluation/local-process.js";
import { resolveScope } from "sandbox-factory";
import { executeRun } from "../dist/run.js";
import { fetchSource } from "../dist/fetch-source.js";
import { command } from "../dist/command.js";
const directory = await mkdtemp(join(tmpdir(), "worker-smoke-"));
const fixture = fileURLToPath(
  new URL("../fixtures/repository/", import.meta.url),
);
const python = process.env.SMOKE_PYTHON || "python3";
try {
  const graphs = [];
  let graphFiles = [];
  const adapter = createGraphifyAdapter({ python });
  for (const name of ["checkout-a", "checkout-b"]) {
    const source = join(directory, name);
    await cp(fixture, source, { recursive: true });
    const files = await adapter.run({
      sourceDir: source,
      outDir: join(directory, `${name}-out`),
      params: { deadlineMinutes: 30 },
      signal: new AbortController().signal,
      log: () => {},
    });
    assert.ok(files.some((f) => f.path === "wiki/index.md"));
    graphFiles = files;
    const bytes = await readFile(
      join(directory, `${name}-out/graph.json`),
      "utf8",
    );
    graphs.push(bytes);
    const graph = JSON.parse(bytes);
    assert.equal(graph.directed, true);
    assert.equal(graph.multigraph, true);
    assert.ok(
      graph.nodes.some(
        (n) =>
          n.id.startsWith("symbol:packages/a/index.ts:") &&
          n.label.includes("shared"),
      ),
    );
    assert.ok(
      graph.nodes.some(
        (n) =>
          n.id.startsWith("symbol:packages/b/index.ts:") &&
          n.label.includes("shared"),
      ),
    );
    for (const specifier of ["./util.js", "./folder", "@/util"])
      assert.ok(
        graph.links.some((e) => e.specifier === specifier && e.resolved),
      );
    assert.ok(
      graph.unresolvedDependencies.some(
        (d) => d.specifier === "missing-package",
      ),
    );
    assert.ok(graph.unresolvedDependencies.some((d) => d.reason === "dynamic"));
    assert.ok(!graph.nodes.some((n) => n.source_file.includes("ignored.ts")));
    assert.doesNotMatch(bytes, /checkout-a|checkout-b/);
  }
  assert.equal(
    graphs[0],
    graphs[1],
    "canonical facts must be independent of checkout paths",
  );
  // Slice the real graph: one file inside the budget, its imports stubbed,
  // the unresolved and dynamic imports visible as blockers.
  const graphRun = {
    id: "arn_graph",
    snapshotId: "rsn_fixture",
    repoId: "ghr_fixture",
    tool: "graphify",
    toolVersion: adapter.version,
    params: { deadlineMinutes: 30 },
    status: "succeeded",
    attempt: 0,
    maxAttempts: 2,
    errorCode: null,
    errorDetail: null,
    startedAt: null,
    finishedAt: null,
    deadlineAt: null,
    createdAt: new Date().toISOString(),
  };
  const graphArtifacts = await Promise.all(
    graphFiles
      .filter((f) => f.kind === "graph_json" || f.kind === "wiki_page")
      .map(async (f) => ({ file: f, bytes: await readFile(f.absolutePath) })),
  );
  const sliceInputs = {
    getRun: async (id) => (id === graphRun.id ? graphRun : null),
    listArtifacts: async () =>
      graphArtifacts.map(({ file, bytes }, index) => ({
        id: `art_${index}`,
        runId: graphRun.id,
        kind: file.kind,
        path: file.path,
        objectKey: `runs/${graphRun.id}/lease/${file.path}`,
        contentType: file.contentType,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        meta: null,
        createdAt: graphRun.createdAt,
      })),
    readArtifact: async (key) =>
      graphArtifacts.find(
        ({ file }) => `runs/${graphRun.id}/lease/${file.path}` === key,
      )?.bytes,
  };
  const sliceRuns = [];
  for (const name of ["slice-a", "slice-b"]) {
    const sliceFiles = await createSliceAdapter().run({
      sourceDir: join(directory, "checkout-a"),
      outDir: join(directory, `${name}-out`),
      params: {
        deadlineMinutes: 30,
        graphRunId: graphRun.id,
        entryPoints: ["src/main.ts"],
        budget: { maxFiles: 1, maxDepth: 3 },
        includeInferred: false,
      },
      run: { snapshotId: "rsn_fixture", commitSha: "a".repeat(40) },
      inputs: sliceInputs,
      signal: new AbortController().signal,
      log: () => {},
    });
    const texts = {};
    for (const f of sliceFiles)
      texts[f.path] = await readFile(f.absolutePath, "utf8");
    sliceRuns.push(texts);
  }
  assert.deepEqual(sliceRuns[0], sliceRuns[1], "a slice must be deterministic");
  const sliceOut = sliceRuns[0];
  const manifest = JSON.parse(sliceOut["slice-manifest.json"]);
  const contract = JSON.parse(sliceOut["boundary-contract.json"]);
  assert.deepEqual(
    manifest.included.map((f) => f.path),
    ["src/main.ts"],
  );
  assert.deepEqual(
    contract.outbound.map((m) => m.module),
    ["src/folder/index.ts", "src/util.ts"],
  );
  assert.match(
    sliceOut["stubs/src/util.d.ts"],
    /declare function helper\(\): number;/,
  );
  assert.match(
    sliceOut["stubs/src/folder/index.d.ts"],
    /declare const value = 1;/,
  );
  // `missing-package` is a bare specifier nothing pins; the fixture compiles
  // with it shimmed, and the missing pin is what blocks the slice.
  assert.deepEqual(contract.blockers.map((b) => b.code).sort(), [
    "dynamic_dependency",
    "missing_build_input",
  ]);
  assert.equal(contract.compilation.ok, true);
  assert.equal(manifest.meta.ready, false);
  assert.equal(
    manifest.boundaryContractSha256,
    createHash("sha256")
      .update(sliceOut["boundary-contract.json"])
      .digest("hex"),
  );
  assert.match(sliceOut["abstract.md"], /Community 0/);
  // The same slice on a file with no imports closes cleanly.
  const clean = await createSliceAdapter().run({
    sourceDir: join(directory, "checkout-a"),
    outDir: join(directory, "slice-clean-out"),
    params: {
      deadlineMinutes: 30,
      graphRunId: graphRun.id,
      entryPoints: ["src/util.ts"],
      budget: { maxFiles: 40, maxDepth: 3 },
      includeInferred: false,
    },
    run: { snapshotId: "rsn_fixture", commitSha: "a".repeat(40) },
    inputs: sliceInputs,
    signal: new AbortController().signal,
    log: () => {},
  });
  const cleanContract = JSON.parse(
    await readFile(
      clean.find((f) => f.path === "boundary-contract.json").absolutePath,
      "utf8",
    ),
  );
  assert.equal(cleanContract.stubCoverage, "full");
  assert.deepEqual(cleanContract.blockers, []);
  assert.deepEqual(
    cleanContract.inbound.map((m) => [m.module, m.importedBy]),
    [["src/util.ts", ["src/main.ts"]]],
  );
  // Build a sandbox from the clean slice and run its baseline for real:
  // trusted lock, `npm ci`, build and public tests as local processes.
  const sliceRun = {
    ...graphRun,
    id: "arn_slice_clean",
    tool: "slice",
    toolVersion: createSliceAdapter().version,
  };
  const sliceArtifacts = await Promise.all(
    clean.map(async (file, index) => {
      const bytes = await readFile(file.absolutePath);
      return {
        artifact: {
          id: `art_slice_${index}`,
          runId: sliceRun.id,
          kind: file.kind,
          path: file.path,
          objectKey: `runs/${sliceRun.id}/lease/${file.path}`,
          contentType: file.contentType,
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          meta: file.meta,
          createdAt: sliceRun.createdAt,
        },
        bytes,
      };
    }),
  );
  const artifactOf = (kind) =>
    sliceArtifacts.find(({ artifact }) => artifact.kind === kind);
  const sliceManifest = artifactOf("slice_manifest");
  const sliceContract = artifactOf("boundary_contract");
  const hashes = {
    manifestSha256: sliceManifest.artifact.sha256,
    contractSha256: sliceContract.artifact.sha256,
    transformConfigSha256: "1".repeat(64),
    approvedTaskSha256: "2".repeat(64),
  };
  const sandboxVersion = {
    version: {
      id: "sbv_fixture",
      sandboxId: "sbx_fixture",
      version: 1,
      title: "Keep the helper",
      specSummary: "helper returns one.",
      complexity: "S",
      tags: ["typescript"],
      testSummary: [],
      publicBaseCommitSha: null,
      readme: null,
      languages: null,
      frozenAt: null,
      createdAt: sliceRun.createdAt,
    },
    source: {
      sandboxVersionId: "sbv_fixture",
      sourceSnapshotId: "rsn_fixture",
      sourceCommitSha: "a".repeat(40),
      sliceRunId: sliceRun.id,
      ...hashes,
      approvedTask: {
        schemaVersion: 1,
        title: "Keep the helper",
        summary: "helper returns one.",
        spec: {
          proposalId: "bpr_fixture",
          specRevision: 1,
          specHash: "s".repeat(64),
          draft: {
            feature: "Helper",
            background: [],
            scenarios: [
              {
                id: "s1",
                kind: "happy",
                title: "helper returns one",
                steps: [{ keyword: "When", text: "helper runs" }],
                origin: "draft",
              },
            ],
            openQuestions: [],
            assumptions: [],
          },
        },
        pricing: null,
        selectedBy: "user_fixture",
        selectedAt: sliceRun.createdAt,
        jiraIssueIds: [],
      },
      aliasRules: [],
      dependencyChoices: {},
      acceptanceTests: [
        {
          path: "tests/private/helper.test.ts",
          text: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { helper } from "../../src/util.js";\ntest("helper", () => assert.equal(helper(), 1));\n',
          expectedBaseline: "pass",
        },
      ],
      scope: resolveScope({
        manifest: JSON.parse(sliceManifest.bytes.toString("utf8")),
        contract: JSON.parse(sliceContract.bytes.toString("utf8")),
      }),
      harnessSha256: null,
      toolchainDigest: null,
      buildRunId: null,
      roundTripRunId: null,
      disclosureRunId: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: sliceRun.createdAt,
      updatedAt: sliceRun.createdAt,
    },
  };
  const buildLog = [];
  const builder = createSandboxBuildAdapter({
    provider: createLocalProcessProvider(),
  });
  const built = await builder.run({
    sourceDir: join(directory, "checkout-a"),
    outDir: join(directory, "build-out"),
    params: {
      deadlineMinutes: 30,
      sliceRunId: sliceRun.id,
      sandboxVersionId: "sbv_fixture",
      ...hashes,
    },
    run: { snapshotId: "rsn_fixture", commitSha: "a".repeat(40) },
    inputs: {
      getRun: async (id) => (id === sliceRun.id ? sliceRun : null),
      listArtifacts: async (id) =>
        id === sliceRun.id
          ? sliceArtifacts.map(({ artifact }) => artifact)
          : [],
      readArtifact: async (key) =>
        sliceArtifacts.find(({ artifact }) => artifact.objectKey === key)
          ?.bytes,
      getVersion: async (id) => (id === "sbv_fixture" ? sandboxVersion : null),
      recordBuildOutput: async () => false,
    },
    signal: new AbortController().signal,
    log: (line) => buildLog.push(line),
  });
  const buildManifest = JSON.parse(
    await readFile(
      built.find((f) => f.path === "build-manifest.json").absolutePath,
      "utf8",
    ),
  );
  assert.deepEqual(buildManifest.blockers, [], buildLog.join("\n"));
  assert.deepEqual(
    buildManifest.baseline.steps.map((step) => [step.name, step.ok]),
    [
      ["prepare", true],
      ["install", true],
      ["build", true],
      ["public-tests", true],
      ["private-test", true],
    ],
    JSON.stringify(buildManifest.baseline, null, 2),
  );
  assert.equal(buildManifest.ready, true);
  assert.ok(built.some((f) => f.path === "project/src/util.ts"));
  assert.ok(built.some((f) => f.path === "private/helper.test.ts"));
  // Exercise the real archive -> Graphify -> streaming upload -> finish lifecycle.
  const archive = join(directory, "fixture.tar.gz");
  await command(
    python,
    [
      "-c",
      "import tarfile,sys; t=tarfile.open(sys.argv[1], 'w:gz'); t.add(sys.argv[2], arcname='checkout-a'); t.close()",
      archive,
      join(directory, "checkout-a"),
    ],
    { signal: new AbortController().signal },
  );
  const archiveBytes = await readFile(archive);
  let fetches = 0;
  const fetch = async (_url, init) => {
    fetches++;
    if (fetches === 1) {
      assert.ok(init.headers.Authorization);
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://codeload.github.com/acme/fixture/tar.gz/sha",
        },
      });
    }
    assert.equal(init.headers, undefined);
    return new Response(archiveBytes);
  };
  const bytes = new Map();
  let finished = false;
  let failure = "";
  const runs = {
    heartbeat: async () => true,
    finish: async (_owner, _id, _token, artifacts) => {
      assert.ok(artifacts.length >= 5);
      assert.ok(artifacts.every((a) => bytes.has(a.objectKey)));
      finished = true;
      return true;
    },
    fail: async (_owner, _id, _token, code) => {
      failure = code;
      return true;
    },
    release: async () => false,
  };
  const objects = {
    put: async (k, b) => bytes.set(k, b),
    putStream: async (k, stream) => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      bytes.set(k, Buffer.concat(chunks));
    },
    remove: async (k) => bytes.delete(k),
  };
  const stamp = new Date().toISOString();
  await executeRun(
    {
      id: "arn_fixture",
      organizationId: "org_fixture",
      leaseToken: "lease_fixture",
      snapshotId: "rsn_fixture",
      repoId: "ghr_fixture",
      tool: "graphify",
      toolVersion: adapter.version,
      params: { deadlineMinutes: 30 },
      status: "running",
      attempt: 0,
      maxAttempts: 2,
      errorCode: null,
      errorDetail: null,
      startedAt: stamp,
      finishedAt: null,
      createdAt: stamp,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      commitSha: "a".repeat(40),
      repoFullName: "acme/fixture",
      externalRepoId: "1",
      installationId: "1",
      sizeKb: null,
    },
    {
      runs,
      objects,
      tool: adapter,
      source: {
        token: async () => "fixture-token",
        maxBytes: 200_000,
        maxFiles: 100,
        fetch,
        python,
      },
      fetchSource,
    },
  );
  assert.equal(
    finished,
    true,
    `Smoke run failed: ${failure}; ${Buffer.from(bytes.get("logs/arn_fixture/lease_fixture.log") ?? []).toString()}`,
  );
  assert.equal(fetches, 2);
  await command(
    python,
    [
      "-m",
      "unittest",
      "discover",
      "-s",
      fileURLToPath(new URL("../python", import.meta.url)),
      "-p",
      "test_*.py",
    ],
    { signal: new AbortController().signal },
  );
  console.log(
    "Worker smoke passed: deterministic graph, import resolution, omissions, slice stubs and blockers, a sandbox build with a local baseline, archive validation, and artifact lifecycle.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
