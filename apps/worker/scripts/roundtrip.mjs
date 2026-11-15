/**
 * The round trip a bounty takes, on the worker alone: no database, model or
 * GitHub; npm installs from the public registry, as the build's baseline
 * does. Run by `npm run worker:roundtrip` (host) and by the worker image
 * smoke in CI (`npm run worker:smoke`).
 *
 * 1. Slice `fixtures/roundtrip` (a repository whose code names its
 *    workspace, `Orvanta`) and build a version with a fixed name table and
 *    scripted hidden tests, on the local-process provider.
 * 2. Act as the contributor: unpack the public `project/` alone and run
 *    `npm ci`, `npm run build`, `npm test` and `npm run dev` with no platform
 *    variable. No hidden test and no workspace name may be in it. Its
 *    guide (`TASK.md` with the renamed spec, `AGENTS.md`, `.vscode/`) is in
 *    place, and a stack from the build's output maps to the `.ts`.
 * 3. Grade submissions through the real `submission_grade` adapter: a
 *    correct one passes, a partial one is overfit and told the failing
 *    scenario's key, and cheats (a weakened public test, an edited
 *    `package.json`, code that tells a test run from a real one, code that
 *    names `tests/private`) are refused before anything runs; code that
 *    walks the tree for the hidden tests finds none on disk and is overfit.
 *    A pass is built and tested again in the repository's names before
 *    its merge patch is kept (the reversed check): the solution's holds.
 *    One that adds a file naming the flat charge by its public name, which
 *    the charge's rename (scoped to the fee module) does not carry back,
 *    still passes, but is marked `carryBack: "failed"` with no merge patch;
 *    the carry it would have opened breaks the repository's own test.
 * 4. Write the passing submission's `private/merge-patch.json` onto a copy
 *    of the repository at the version's commit and run the repository's
 *    own test there: it fails before the patch and passes after, and the
 *    patched file is in the repository's names, not the pseudonyms.
 *
 * Graphify is not needed: the slice reads the graph run only for its
 * provenance, so a two-file graph stands in; the worker smoke runs the
 * real one.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  decisionsText,
  resolveScope,
  specDecisions,
  transformConfigOf,
} from "sandbox-factory";
import {
  createLocalProcessProvider,
  runProcess,
} from "../dist/evaluation/local-process.js";
import { createSandboxBuildAdapter } from "../dist/tools/sandbox-build.js";
import { createSliceAdapter } from "../dist/tools/slice.js";
import {
  MERGE_PATCH_PATH,
  SUBMISSION_RESULT_PATH,
  carriedBack,
  createSubmissionGradeAdapter,
  versionFilesOf,
} from "../dist/tools/submission-grade.js";

const fixture = fileURLToPath(
  new URL("../fixtures/roundtrip/", import.meta.url),
);
const directory = await mkdtemp(join(tmpdir(), "worker-roundtrip-"));
const COMMIT = "b".repeat(40);
const SNAPSHOT = "rsn_roundtrip";
const STAMP = "2026-11-15T00:00:00.000Z";
const signal = new AbortController().signal;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const say = (line) => console.log(`roundtrip: ${line}`);
/** Every spelling of the workspace's name that must not reach a contributor. */
const VOCABULARY = /orvanta/i;
/** The public names the table gives, which must not reach the repository. */
const PSEUDONYMS = /northwind|entryFee|LedgerEntry|ledgerBalance|flatCharge/;

/** A finished run's files as stored artifacts, read back by object key. */
async function served(runId, files) {
  const objects = new Map();
  const artifacts = [];
  for (const [index, file] of files.entries()) {
    const bytes = await readFile(file.absolutePath);
    const objectKey = `runs/${runId}/lease/${file.path}`;
    objects.set(objectKey, bytes);
    artifacts.push({
      id: `art_${runId}_${index}`,
      runId,
      kind: file.kind,
      path: file.path,
      objectKey,
      contentType: file.contentType,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      meta: file.meta ?? null,
      createdAt: STAMP,
    });
  }
  return { artifacts, read: async (key) => objects.get(key) };
}

const run = (id, tool, params) => ({
  id,
  snapshotId: SNAPSHOT,
  repoId: "ghr_roundtrip",
  tool,
  toolVersion: "roundtrip",
  params,
  status: "succeeded",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  startedAt: STAMP,
  finishedAt: STAMP,
  deadlineAt: STAMP,
  createdAt: STAMP,
});

/** A command with exactly the environment given; its output on failure. */
async function sh(argv, cwd, env, timeoutMs = 300_000) {
  const result = await runProcess(
    { argv, limits: { timeoutMs, maxOutputBytes: 4_000_000 } },
    { cwd, env, signal },
  );
  return {
    ...result,
    ok: result.exitCode === 0 && !result.timedOut,
    output: `$ ${argv.join(" ")} (exit ${result.exitCode})\n${result.stdout}\n${result.stderr}`,
  };
}

/** Every file under a folder, by relative path, skipping `node_modules`. */
async function walk(root, dir = root) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, path)));
    else out.push(relative(root, path).split("\\").join("/"));
  }
  return out.sort();
}

/** The build's provider, whose own npm cache goes on the way out. */
let provider;
try {
  // The repository at the commit the version is cut at.
  const source = join(directory, "source");
  await cp(fixture, source, { recursive: true });

  // 1a. Slice: the fee module; the ledger it reads only types from is cut
  // to a stub.
  const graphRun = run("arn_graph", "graphify", { deadlineMinutes: 30 });
  const file = (path) => ({
    id: `file:${path}`,
    label: path,
    source_file: path,
    community: 0,
  });
  const graphBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      directed: true,
      multigraph: true,
      nodes: [file("src/orvanta/fees.ts"), file("src/orvanta/ledger.ts")],
      links: [
        {
          source: "file:src/orvanta/fees.ts",
          target: "file:src/orvanta/ledger.ts",
          relation: "imports",
          confidence: "EXTRACTED",
          specifier: "./ledger.js",
          resolved: true,
          source_location: "L1",
        },
      ],
      communities: {
        0: ["file:src/orvanta/fees.ts", "file:src/orvanta/ledger.ts"],
      },
    }),
  );
  const graphArtifact = {
    id: "art_graph",
    runId: graphRun.id,
    kind: "graph_json",
    path: "graph.json",
    objectKey: "runs/arn_graph/lease/graph.json",
    contentType: "application/json",
    sizeBytes: graphBytes.byteLength,
    sha256: sha256(graphBytes),
    meta: null,
    createdAt: STAMP,
  };
  const sliceParams = {
    deadlineMinutes: 30,
    graphRunId: graphRun.id,
    entryPoints: ["src/orvanta/fees.ts"],
    budget: { maxFiles: 2, maxDepth: 3 },
    includeInferred: false,
  };
  const sliceFiles = await createSliceAdapter().run({
    sourceDir: source,
    outDir: join(directory, "slice-out"),
    params: sliceParams,
    run: { snapshotId: SNAPSHOT, commitSha: COMMIT },
    inputs: {
      getRun: async (id) => (id === graphRun.id ? graphRun : null),
      listArtifacts: async (id) => (id === graphRun.id ? [graphArtifact] : []),
      readArtifact: async (key) =>
        key === graphArtifact.objectKey ? graphBytes : undefined,
    },
    signal,
    log: () => {},
  });
  const sliceRun = run("arn_slice", "slice", sliceParams);
  const slice = await served(sliceRun.id, sliceFiles);
  const sliceText = async (path) =>
    (
      await slice.read(slice.artifacts.find((a) => a.path === path).objectKey)
    ).toString("utf8");
  const manifest = JSON.parse(await sliceText("slice-manifest.json"));
  const contract = JSON.parse(await sliceText("boundary-contract.json"));
  assert.deepEqual(
    manifest.included.map((f) => f.path),
    ["src/orvanta/fees.ts"],
  );
  assert.deepEqual(
    contract.outbound.map((m) => m.module),
    ["src/orvanta/ledger.ts"],
  );
  assert.deepEqual(contract.blockers, [], JSON.stringify(contract.blockers));
  say("sliced src/orvanta/fees.ts, its ledger stubbed, no blockers");

  // 1b. The version: a name table that renames the workspace out of paths,
  // identifiers and prose, and hidden tests written against those names
  // (as an owner or the hidden-tests agent writes them), one scenario each.
  // The flat charge's rename is scoped to the fee module, the one file
  // that names it, as an owner scopes a term to where it is.
  const aliasRules = [
    { before: "orvanta", after: "northwind", kind: "path", paths: [] },
    {
      before: "OrvantaEntry",
      after: "LedgerEntry",
      kind: "identifier",
      paths: [],
    },
    { before: "orvantaFee", after: "entryFee", kind: "identifier", paths: [] },
    {
      before: "orvantaCharge",
      after: "flatCharge",
      kind: "identifier",
      paths: ["src/orvanta/fees.ts"],
    },
    {
      before: "orvantaBalance",
      after: "ledgerBalance",
      kind: "identifier",
      paths: [],
    },
    { before: "Orvanta", after: "Northwind", kind: "text", paths: [] },
  ];
  const hidden = (name, body, expectedBaseline) => ({
    path: `tests/private/${name}.test.ts`,
    text: `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { entryFee } from "../../src/northwind/fees.js";\n${body}\n`,
    expectedBaseline,
  });
  const acceptanceTests = [
    hidden(
      "s1-credit-is-free",
      'test("a credit is free", () => assert.equal(entryFee({ amountCents: 10000, kind: "credit" }), 0));',
      "pass",
    ),
    hidden(
      "s2-debit-pays-one-percent",
      'test("a debit pays one percent, rounded", () => {\n  assert.equal(entryFee({ amountCents: 10000, kind: "debit" }), 100);\n  assert.equal(entryFee({ amountCents: 4250, kind: "debit" }), 43);\n});',
      "fail",
    ),
    hidden(
      "s3-debit-minimum",
      'test("a small debit pays the 25 cent minimum", () => assert.equal(entryFee({ amountCents: 100, kind: "debit" }), 25));',
      "pass",
    ),
  ];
  const scenario = (id, kind, title) => ({
    id,
    kind,
    title,
    steps: [{ keyword: "Then", text: title }],
    origin: "draft",
  });
  const approvedTask = {
    schemaVersion: 1,
    title: "Charge the Orvanta fee by amount",
    summary:
      "A debit pays one percent of its amount, at least 25 cents; a credit is free.",
    spec: {
      proposalId: "bpr_roundtrip",
      specRevision: 1,
      specHash: "s".repeat(64),
      draft: {
        feature: "Orvanta entry fee",
        background: [],
        scenarios: [
          scenario("s1", "happy", "a credit is free"),
          scenario("s2", "happy", "a debit pays one percent, rounded"),
          scenario("s3", "edge", "a small debit pays the 25 cent minimum"),
        ],
        openQuestions: [],
        // A confirmed decision, written in the workspace's names: TASK.md
        // carries it renamed, as the scenarios are.
        assumptions: ["The Orvanta fee is rounded half up to the cent."],
      },
    },
    pricing: null,
    selectedBy: "user_roundtrip",
    selectedAt: STAMP,
    jiraIssueIds: [],
  };
  const versionSource = {
    sandboxVersionId: "sbv_roundtrip",
    sourceSnapshotId: SNAPSHOT,
    sourceCommitSha: COMMIT,
    sliceRunId: sliceRun.id,
    manifestSha256: slice.artifacts.find((a) => a.kind === "slice_manifest")
      .sha256,
    contractSha256: slice.artifacts.find((a) => a.kind === "boundary_contract")
      .sha256,
    transformConfigSha256: "",
    approvedTaskSha256: sha256(canonicalJson(approvedTask)),
    approvedTask,
    aliasRules,
    dependencyChoices: {},
    acceptanceTests,
    fixtures: null,
    scope: resolveScope({ manifest, contract }),
    harnessSha256: null,
    toolchainDigest: null,
    buildRunId: null,
    roundTripRunId: null,
    disclosureRunId: null,
    approvedBy: null,
    approvedAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
  versionSource.transformConfigSha256 = sha256(
    canonicalJson(transformConfigOf(versionSource)),
  );
  const version = {
    id: "sbv_roundtrip",
    sandboxId: "sbx_roundtrip",
    version: 1,
    title: approvedTask.title,
    specSummary: approvedTask.summary,
    complexity: "S",
    tags: ["typescript"],
    testSummary: [],
    publicBaseCommitSha: null,
    readme: null,
    languages: null,
    frozenAt: null,
    createdAt: STAMP,
  };

  // 1c. Build, with its baseline run for real.
  provider = createLocalProcessProvider();
  const buildLog = [];
  const builtFiles = await createSandboxBuildAdapter({ provider }).run({
    sourceDir: source,
    outDir: join(directory, "build-out"),
    params: {
      deadlineMinutes: 30,
      sliceRunId: sliceRun.id,
      sandboxVersionId: version.id,
      manifestSha256: versionSource.manifestSha256,
      contractSha256: versionSource.contractSha256,
      transformConfigSha256: versionSource.transformConfigSha256,
      approvedTaskSha256: versionSource.approvedTaskSha256,
      vocabulary: ["Orvanta Payments"],
      // The API names the decisions a person confirmed by their hash.
      decisionsSha256: sha256(
        decisionsText(specDecisions(approvedTask.spec.draft)),
      ),
    },
    run: { snapshotId: SNAPSHOT, commitSha: COMMIT },
    inputs: {
      getRun: async (id) => (id === sliceRun.id ? sliceRun : null),
      listArtifacts: async (id) => (id === sliceRun.id ? slice.artifacts : []),
      readArtifact: slice.read,
      getVersion: async (id) =>
        id === version.id ? { version, source: versionSource } : null,
      recordBuildOutput: async () => false,
    },
    signal,
    log: (line) => buildLog.push(line),
  });
  const buildRunId = "arn_build";
  const build = await served(buildRunId, builtFiles);
  const builtText = async (path) => {
    const artifact = build.artifacts.find((a) => a.path === path);
    return artifact === undefined
      ? null
      : (await build.read(artifact.objectKey)).toString("utf8");
  };
  const buildManifest = JSON.parse(await builtText("build-manifest.json"));
  assert.deepEqual(buildManifest.blockers, [], buildLog.join("\n"));
  assert.equal(
    buildManifest.ready,
    true,
    JSON.stringify(buildManifest.baseline, null, 2),
  );
  // Both publication gates: the unchanged project carries back to the
  // fixture's own bytes, and no public file names the workspace.
  assert.equal(
    buildManifest.gates?.roundTrip.status,
    "passed",
    JSON.stringify(buildManifest.gates, null, 2),
  );
  assert.ok(buildManifest.gates.roundTrip.files > 0);
  assert.equal(buildManifest.gates.disclosure.status, "passed");
  assert.equal(buildManifest.gates.disclosure.blocking, 0);
  assert.ok(
    await builtText("project/src/northwind/fees.ts"),
    "the fee module is renamed",
  );
  assert.ok(
    await builtText("private/pseudonym.lunox"),
    "the name table is kept privately",
  );
  say(
    `built a ready version: ${build.artifacts.filter((a) => a.path.startsWith("project/")).length} public files, ${acceptanceTests.length} hidden tests, baseline as expected, round trip and disclosure gates passed`,
  );

  // 2. The contributor's machine: the public project alone.
  const contributor = join(directory, "contributor");
  for (const artifact of build.artifacts) {
    if (!artifact.path.startsWith("project/")) continue;
    const target = join(contributor, artifact.path.slice("project/".length));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await build.read(artifact.objectKey));
  }
  const handed = await walk(contributor);
  for (const path of [
    "README.md",
    ".gitignore",
    "sandbox-task.json",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "src/northwind/fees.ts",
    "TASK.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".vscode/settings.json",
    ".vscode/launch.json",
    ".vscode/tasks.json",
  ])
    assert.ok(handed.includes(path), `the project has ${path}`);
  // The editor's files parse; their tasks and launches agree.
  const vscode = {};
  for (const name of ["settings", "launch", "tasks"])
    vscode[name] = JSON.parse(
      await readFile(join(contributor, `.vscode/${name}.json`), "utf8"),
    );
  for (const launch of vscode.launch.configurations)
    assert.ok(
      vscode.tasks.tasks.some((task) => task.label === launch.preLaunchTask),
      `launch ${launch.name} builds first by a task that exists`,
    );
  const hiddenNames = acceptanceTests.map((t) =>
    t.path
      .split("/")
      .at(-1)
      .replace(/\.test\.ts$/, ""),
  );
  const assertClean = async (label) => {
    for (const path of await walk(contributor)) {
      assert.doesNotMatch(
        path,
        VOCABULARY,
        `${label}: ${path} names the workspace`,
      );
      assert.ok(
        !path.startsWith("tests/private"),
        `${label}: ${path} is a hidden test`,
      );
      for (const name of hiddenNames)
        assert.ok(!path.includes(name), `${label}: ${path} is a hidden test`);
      const text = await readFile(join(contributor, path), "utf8");
      assert.doesNotMatch(
        text,
        VOCABULARY,
        `${label}: ${path} names the workspace`,
      );
      for (const test of acceptanceTests) {
        const body = test.text.split("\n")[3];
        assert.ok(
          !text.includes(body),
          `${label}: ${path} holds a hidden test's body`,
        );
      }
    }
  };
  await assertClean("as handed out");
  // The guide: the spec in public names, and no hidden test's name in it.
  const taskGuide = await readFile(join(contributor, "TASK.md"), "utf8");
  const agentsGuide = await readFile(join(contributor, "AGENTS.md"), "utf8");
  assert.match(taskGuide, /Feature: Northwind entry fee/);
  assert.match(taskGuide, /# s2\n {2}Scenario: a debit pays one percent/);
  assert.match(
    taskGuide,
    /## Decided\n\n.*confirmed each.*\n\n- The Northwind fee is rounded half up to the cent\./,
  );
  assert.match(agentsGuide, /`TASK\.md`: read it first/);
  for (const text of [taskGuide, agentsGuide]) {
    assert.doesNotMatch(text, /tests\/private/);
    for (const name of hiddenNames)
      assert.ok(!text.includes(name), `the guide names hidden test ${name}`);
  }
  // What the README promises: the commands it lists exist, every editable
  // file it lists is in the project, and acceptance is by submitted files.
  const readme = await readFile(join(contributor, "README.md"), "utf8");
  const scripts = JSON.parse(
    await readFile(join(contributor, "package.json"), "utf8"),
  ).scripts;
  for (const name of ["dev", "build", "test"]) {
    assert.ok(scripts[name], `package.json has a ${name} script`);
    assert.ok(
      readme.includes(`npm run ${name}`) || readme.includes(`npm ${name}`),
      `README lists npm ${name}`,
    );
  }
  assert.ok(readme.includes("npm ci"), "README lists npm ci");
  const descriptor = JSON.parse(
    await readFile(join(contributor, "sandbox-task.json"), "utf8"),
  );
  assert.ok(
    descriptor.editablePaths.includes("src/northwind/fees.ts"),
    JSON.stringify(descriptor),
  );
  for (const path of descriptor.editablePaths) {
    assert.ok(handed.includes(path), `editable ${path} is in the project`);
    assert.ok(readme.includes(`\`${path}\``), `README lists editable ${path}`);
  }
  assert.doesNotMatch(
    readme,
    /pushed commit/,
    "README: there is no push; a submission is its files",
  );
  // No platform variable: PATH for node and npm, a home and npm cache of
  // the contributor's own.
  const home = join(directory, "home");
  await mkdir(home, { recursive: true });
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: home,
    npm_config_cache: join(home, ".npm"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  for (const argv of [
    ["npm", "ci"],
    ["npm", "run", "build"],
    ["npm", "test"],
    ["npm", "run", "dev"],
  ]) {
    const result = await sh(argv, contributor, env);
    assert.ok(result.ok, result.output);
  }
  await assertClean("after npm ci, build, test and dev");
  // Source maps beside the build's output, which bind a failure to the .ts.
  const map = JSON.parse(
    await readFile(join(contributor, "src/northwind/fees.js.map"), "utf8"),
  );
  assert.deepEqual(map.sources, ["fees.ts"]);
  const mapped = await sh(
    [
      "node",
      "--enable-source-maps",
      "--input-type=module",
      "-e",
      'import { entryFee } from "./src/northwind/fees.js"; entryFee(null);',
    ],
    contributor,
    env,
  );
  assert.equal(mapped.ok, false, mapped.output);
  assert.match(
    mapped.stderr,
    /src\/northwind\/fees\.ts:\d+:\d+/,
    "a stack maps to the .ts",
  );
  say(
    "contributor: npm ci, npm run build, npm test and npm run dev pass on project/ alone; no hidden test or workspace name in it; TASK.md (with the confirmed decision, renamed), AGENTS.md and .vscode/ in place, stacks map to .ts",
  );

  // 3. Grading, through the adapter a submission_grade run calls.
  const projectFee = await readFile(
    join(contributor, "src/northwind/fees.ts"),
    "utf8",
  );
  const BODY = '  return entry.kind === "debit" ? flatCharge : 0;\n';
  assert.ok(projectFee.includes(BODY), projectFee);
  const withBody = (text, body) => text.replace(BODY, body);
  const SOLUTION =
    '  if (entry.kind === "credit") return 0;\n  return Math.max(25, Math.round(entry.amountCents / 100));\n';
  const grade = async (label, files) => {
    const outDir = join(directory, `grade-${label}`);
    await mkdir(outDir, { recursive: true });
    const finished = [];
    const log = [];
    const written = await createSubmissionGradeAdapter({ provider }).run({
      runId: `arn_grade_${label}`,
      sourceDir: source,
      outDir,
      params: {
        deadlineMinutes: 60,
        grader: "submission",
        submissionId: `sbm_${label}`,
        sandboxVersionId: version.id,
        patchSha256: sha256(JSON.stringify(files)),
      },
      run: { snapshotId: SNAPSHOT, commitSha: COMMIT },
      inputs: {
        getRun: async () => null,
        listArtifacts: async (id) => (id === buildRunId ? build.artifacts : []),
        readArtifact: build.read,
        getVersion: async (id) =>
          id === version.id
            ? { version, source: { ...versionSource, buildRunId } }
            : null,
        recordBuildOutput: async () => false,
        readSubmission: async (id) =>
          id === `sbm_${label}`
            ? {
                submission: {
                  id,
                  sandboxVersionId: version.id,
                  status: "queued",
                },
                files,
              }
            : null,
        settleSubmission: (id, result) => {
          finished.push({ id, result });
        },
      },
      signal,
      log: (line) => log.push(line),
    });
    const result = JSON.parse(
      await readFile(join(outDir, SUBMISSION_RESULT_PATH), "utf8"),
    );
    assert.deepEqual(finished, [{ id: `sbm_${label}`, result }]);
    const patch = written.some((f) => f.path === MERGE_PATCH_PATH)
      ? JSON.parse(await readFile(join(outDir, MERGE_PATCH_PATH), "utf8"))
      : null;
    return { result, patch, log };
  };
  const fee = (body) => [
    { path: "src/northwind/fees.ts", text: withBody(projectFee, body) },
  ];

  const passing = await grade("solution", fee(SOLUTION));
  assert.deepEqual(
    passing.result,
    {
      public: { passed: 1, total: 1 },
      hidden: { passed: 3, total: 3 },
      verdict: "passed",
      failedScenarios: [],
    },
    passing.log.join("\n"),
  );
  assert.ok(passing.patch, "a pass on a sliced version is carried back");
  // The product's own reversed check ran and held before the patch was kept.
  assert.ok(
    passing.log.some((line) =>
      /^Reversed check in the repository's names: passed, public 1\/1, hidden 3\/3\.$/.test(
        line,
      ),
    ),
    passing.log.join("\n"),
  );
  say(
    "grade: the solution passed, 3/3 hidden, and passed again in the repository's names",
  );

  // The solution, with the flat charge exported and a helper beside the
  // fee module that reads it. The helper carries back line for line: the
  // charge's rename is scoped to the fee module, so in the new file
  // `flatCharge` maps back to itself, and only building it in the
  // repository's names shows the import names nothing there.
  const MINIMUM = [
    'import { flatCharge } from "./fees.js";',
    "",
    "/** Whether a debit of this amount pays only the flat charge. */",
    "export function paysFlatCharge(amountCents: number): boolean {",
    "  return Math.round(amountCents / 100) <= flatCharge;",
    "}",
    "",
  ].join("\n");
  const CHARGE = "const flatCharge = 25;\n";
  assert.ok(projectFee.includes(CHARGE), projectFee);
  const withQuote = [
    {
      path: "src/northwind/fees.ts",
      text: withBody(projectFee, SOLUTION).replace(CHARGE, `export ${CHARGE}`),
    },
    { path: "src/northwind/minimum.ts", text: MINIMUM },
  ];
  const uncarried = await grade("uncarried", withQuote);
  assert.deepEqual(
    uncarried.result,
    {
      public: { passed: 1, total: 1 },
      hidden: { passed: 3, total: 3 },
      verdict: "passed",
      failedScenarios: [],
      carryBack: "failed",
    },
    uncarried.log.join("\n"),
  );
  assert.equal(uncarried.patch, null, "no merge patch when the carry fails");
  assert.ok(
    uncarried.log.some((line) =>
      /^Reversed check in the repository's names: incomplete/.test(line),
    ),
    uncarried.log.join("\n"),
  );
  // It is the build in the repository's names that fails, on that import.
  assert.ok(
    uncarried.log.some((line) =>
      /^build failed:[\s\S]*has no exported member 'flatCharge'/.test(line),
    ),
    uncarried.log.join("\n"),
  );
  say(
    "grade: a pass whose carry names the flat charge by its public name keeps its verdict, is marked carryBack failed, and has no merge patch",
  );

  // One percent, but no minimum: s3 fails, and only its key is told.
  const partial = await grade(
    "partial",
    fee(
      '  if (entry.kind === "credit") return 0;\n  return Math.round(entry.amountCents / 100);\n',
    ),
  );
  assert.equal(partial.result.verdict, "overfit", partial.log.join("\n"));
  assert.deepEqual(partial.result.hidden, { passed: 2, total: 3 });
  assert.deepEqual(partial.result.failedScenarios, ["s3"]);
  assert.equal(partial.patch, null);
  assert.doesNotMatch(
    JSON.stringify(partial.result),
    /minimum|debit-minimum/,
    "no hidden test's name leaves the run",
  );
  say("grade: the partial one is overfit, told only scenario s3");

  const publicTests = handed.filter(
    (p) => p.startsWith("tests/public/") && p.endsWith(".test.ts"),
  );
  assert.ok(publicTests.length > 0, "the project has public tests");
  const cheats = [
    [
      "weakened-public-test",
      [
        ...fee(SOLUTION),
        {
          path: publicTests[0],
          text: 'import { test } from "node:test";\ntest("nothing", () => {});\n',
        },
      ],
      publicTests[0],
    ],
    [
      "edited-config",
      [
        ...fee(SOLUTION),
        {
          path: "package.json",
          text: JSON.stringify(
            {
              ...JSON.parse(
                await readFile(join(contributor, "package.json"), "utf8"),
              ),
              scripts: { ...scripts, test: "true" },
            },
            null,
            2,
          ),
        },
      ],
      "package.json",
    ],
    [
      "tells-test-from-real",
      fee(
        '  if (process.env.NODE_TEST_CONTEXT) return entry.kind === "credit" ? 0 : Math.max(25, Math.round(entry.amountCents / 100));\n  return 0;\n',
      ),
      "src/northwind/fees.ts",
    ],
  ];
  for (const [label, files, path] of cheats) {
    const cheat = await grade(label, files);
    assert.equal(
      cheat.result.verdict,
      "refused",
      `${label}: ${JSON.stringify(cheat.result)}`,
    );
    assert.ok(
      cheat.result.refused.some((r) => r.path === path),
      `${label}: ${JSON.stringify(cheat.result.refused)}`,
    );
    assert.equal(cheat.patch, null);
    say(`grade: ${label} refused (${path})`);
  }

  // Code that reads the hidden tests from disk to answer what they ask. The
  // plain spelling is refused before anything runs (`taskCodeProblems`).
  const answersFrom = (files) => [
    "  const answers = new Map<string, number>();",
    "  try {",
    `    for (const file of ${files})`,
    '      for (const m of readFileSync(file, "utf8").matchAll(/amountCents: (\\d+), kind: "(\\w+)" \\}\\), (\\d+)\\)/g))',
    "        answers.set(`${m[2]}:${m[1]}`, Number(m[3]));",
    "  } catch {}",
    '  return answers.get(`${entry.kind}:${entry.amountCents}`) ?? (entry.kind === "debit" ? 25 : 0);',
    "",
  ];
  const peeking = await grade("reads-hidden-tests", [
    {
      path: "src/northwind/fees.ts",
      text: withBody(
        `import { readdirSync, readFileSync } from "node:fs";\n${projectFee}`,
        answersFrom(
          'readdirSync("tests/private").filter((name) => name.endsWith(".js")).map((name) => `tests/private/${name}`)',
        ).join("\n"),
      ),
    },
  ]);
  assert.equal(
    peeking.result.verdict,
    "refused",
    JSON.stringify(peeking.result),
  );
  assert.ok(
    peeking.result.refused.some(
      (r) =>
        r.path === "src/northwind/fees.ts" && /tests\/private/.test(r.reason),
    ),
    JSON.stringify(peeking.result.refused),
  );
  assert.equal(peeking.patch, null);
  say("grade: reads-hidden-tests refused (it names tests/private)");

  // A spelling the check does not follow, walking the whole tree for test
  // files: it runs, and finds no hidden test on disk while one runs. Its
  // fallback answers only what the starter did, so s2 fails.
  const walking = await grade("walks-for-hidden-tests", [
    {
      path: "src/northwind/fees.ts",
      text: withBody(
        `import { readdirSync, readFileSync } from "node:fs";\nconst walk = (dir: string): string[] =>\n  readdirSync(dir, { withFileTypes: true }).flatMap((e: { name: string; isDirectory(): boolean }) =>\n    e.name === "node_modules" ? [] : e.isDirectory() ? walk(\`\${dir}/\${e.name}\`) : [\`\${dir}/\${e.name}\`],\n  );\n${projectFee}`,
        answersFrom(
          'walk(".").filter((file) => /\\.test\\.m?js$/.test(file))',
        ).join("\n"),
      ),
    },
  ]);
  assert.equal(walking.result.verdict, "overfit", walking.log.join("\n"));
  assert.deepEqual(walking.result.hidden, { passed: 2, total: 3 });
  assert.deepEqual(walking.result.failedScenarios, ["s2"]);
  assert.equal(walking.patch, null);
  say(
    "grade: walks-for-hidden-tests is overfit: no hidden test is on disk while task code runs",
  );

  // 4. Carry-back: the patch onto the repository at the version's commit.
  const repo = join(directory, "repository");
  await cp(fixture, repo, { recursive: true });
  const original = await readFile(join(fixture, "src/orvanta/fees.ts"), "utf8");
  const expected = original.replace(
    '  return entry.kind === "debit" ? orvantaCharge : 0;\n',
    SOLUTION,
  );
  assert.notEqual(expected, original);
  assert.equal(passing.patch.commitSha, COMMIT);
  assert.deepEqual(passing.patch.files, [
    { path: "src/orvanta/fees.ts", text: expected },
  ]);
  for (const { text } of passing.patch.files) {
    assert.match(text, /orvantaFee/);
    assert.match(text, /OrvantaEntry/);
    assert.doesNotMatch(text, PSEUDONYMS);
  }
  // The repository's own test, with its own command; its `tsc` is the
  // worker's pinned compiler.
  const bin = join(directory, "bin");
  await mkdir(bin, { recursive: true });
  const typescript = dirname(
    createRequire(import.meta.url).resolve("typescript-compiler/package.json"),
  );
  await symlink(join(typescript, "bin", "tsc"), join(bin, "tsc"));
  const repoEnv = { ...env, PATH: `${bin}:${env.PATH}` };
  const before = await sh(["npm", "test"], repo, repoEnv);
  assert.equal(
    before.ok,
    false,
    `the repository's test must fail before the patch:\n${before.output}`,
  );
  for (const { path, text } of passing.patch.files)
    await writeFile(join(repo, path), text);
  const after = await sh(["npm", "test"], repo, repoEnv);
  assert.ok(after.ok, after.output);
  assert.match(after.stdout, /# pass 3|ℹ pass 3/, after.output);
  say(
    "carry-back: merge-patch.json is in the repository's names; its own test fails before and passes after",
  );

  // The gate was right to withhold the other pass: what its carry would
  // have opened as a pull request breaks the repository's own test.
  const buildInput = {
    inputs: {
      listArtifacts: async (id) => (id === buildRunId ? build.artifacts : []),
      readArtifact: build.read,
    },
    sourceDir: source,
  };
  const wouldOpen = await carriedBack(
    buildInput,
    buildRunId,
    await versionFilesOf(buildInput, buildRunId),
    withQuote,
  );
  assert.deepEqual(wouldOpen.refused, []);
  assert.deepEqual(
    wouldOpen.files.map((f) => f.path),
    ["src/orvanta/fees.ts", "src/orvanta/minimum.ts"],
  );
  assert.match(wouldOpen.files[0].text, /export const orvantaCharge = 25;/);
  assert.match(
    wouldOpen.files[1].text,
    /import \{ flatCharge \}/,
    "the carry leaves the public name in the new file",
  );
  const broken = join(directory, "repository-uncarried");
  await cp(fixture, broken, { recursive: true });
  for (const { path, text } of wouldOpen.files) {
    await mkdir(dirname(join(broken, path)), { recursive: true });
    await writeFile(join(broken, path), text);
  }
  const brokenTest = await sh(["npm", "test"], broken, repoEnv);
  assert.equal(brokenTest.ok, false, brokenTest.output);
  assert.match(brokenTest.output, /flatCharge/, brokenTest.output);
  say(
    "carry-back: the withheld carry would have broken the repository's own build (flatCharge is not its name)",
  );

  console.log(
    "Worker round trip passed: slice with pseudonyms, build with scripted hidden tests, contributor commands on project/ alone, grading (passed, overfit, four refusals, hidden tests unreadable at run time), the reversed check in the repository's names (held, and withheld a carry that breaks the repository), carry-back onto the repository and its own test.",
  );
} finally {
  await provider?.dispose();
  await rm(directory, { recursive: true, force: true });
}
