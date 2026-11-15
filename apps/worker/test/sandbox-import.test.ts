/**
 * An uploaded hand-off folder, end to end on this machine: a real
 * carveout cut of a fixture repository (`carveout/api`, public and in
 * pseudonyms, as `handoff --platform` uploads it), imported by the
 * `sandbox_import` adapter, its baseline run for real (TypeScript builds
 * it, the folder's own runner runs its public tests, node:test runs the
 * acceptance test), and two submissions graded through the folder's
 * layout. The provider is a local stand-in: the install links the
 * worker's TypeScript instead of reaching a registry, and seals and runs
 * hidden tests as both providers do (`hidden-runner.ts`): each in a fresh
 * copy of the sealed tree, read from memory by the platform's runner.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { cut } from "carveout/api";
import type {
  EvaluationCommand,
  EvaluationProvider,
  GradingLayout,
  SandboxBuildManifest,
  SubmissionResult,
} from "sandbox-factory";
import type {
  ArtifactFile,
  ToolInputs,
  ToolRunInput,
} from "../src/tools/adapter.js";
import { hiddenRunFiles } from "../src/evaluation/hidden-runner.js";
import {
  classOf,
  createSandboxImportAdapter,
  parseUpload,
} from "../src/tools/sandbox-import.js";
import {
  SUBMISSION_RESULT_PATH,
  createSubmissionGradeAdapter,
  versionFilesOf,
} from "../src/tools/submission-grade.js";
import { PLATFORM_LAYOUT } from "sandbox-factory";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const typescript = dirname(
  createRequire(import.meta.url).resolve("typescript-compiler/package.json"),
);

let scratch = "";
let folder = "";
const ACCEPT = "src/price.accept.test.ts";
const ACCEPT_TEXT =
  'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { discounted } from "./price.js";\n\ntest("a tenth off", () => assert.equal(discounted(100), 90));\n';

/** Every file of a folder but its installed packages, by path. */
function filesOf(root: string, dir = ""): { path: string; text: string }[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory())
        return entry.name === "node_modules" ? [] : filesOf(root, path);
      return [{ path, text: readFileSync(join(root, path), "utf8") }];
    },
  );
}

/** A provider that really runs the folder's commands, without a registry. */
function localProvider() {
  const ran: { argv: readonly string[]; hidden: boolean }[] = [];
  const provider: EvaluationProvider = {
    name: "local-test",
    async create({ label }) {
      const root = mkdtempSync(join(scratch, "job-"));
      const work = join(root, "work");
      const pristine = join(root, "pristine");
      mkdirSync(work);
      let withheld: Map<string, string> | null = null;
      return {
        id: `job_${label}`,
        environment: {
          provider: "local-test",
          environmentId: "node",
          templateDigest: null,
        },
        async stage(files) {
          for (const file of files) {
            mkdirSync(dirname(join(work, file.path)), { recursive: true });
            writeFileSync(join(work, file.path), file.text);
          }
        },
        async seal(paths) {
          withheld = new Map();
          for (const path of paths)
            if (existsSync(join(work, path))) {
              withheld.set(path, readFileSync(join(work, path), "utf8"));
              rmSync(join(work, path));
            }
          cpSync(work, pristine, { recursive: true, verbatimSymlinks: true });
        },
        async exec(command: EvaluationCommand) {
          ran.push({
            argv: command.argv,
            hidden: command.hidden !== undefined,
          });
          let cwd = work;
          let argv = command.argv;
          if (command.hidden !== undefined) {
            assert.ok(withheld !== null, "a hidden run follows the seal");
            cwd = join(root, "fresh");
            rmSync(cwd, { recursive: true, force: true });
            cpSync(pristine, cwd, { recursive: true, verbatimSymlinks: true });
            const run = hiddenRunFiles(
              command.hidden,
              command.argv,
              withheld.get(command.hidden.entry) ?? null,
            );
            for (const file of run.files) {
              mkdirSync(dirname(join(cwd, file.path)), { recursive: true });
              writeFileSync(join(cwd, file.path), file.text);
            }
            argv = run.argv;
          }
          if (command.argv[0] === "npm") {
            mkdirSync(join(work, "node_modules", ".bin"), { recursive: true });
            symlinkSync(typescript, join(work, "node_modules", "typescript"));
            symlinkSync(
              join(typescript, "bin", "tsc"),
              join(work, "node_modules", ".bin", "tsc"),
            );
            return {
              exitCode: 0,
              timedOut: false,
              outputTruncated: false,
              stdout: "",
              stderr: "",
              durationMs: 1,
            };
          }
          const [bin, ...args] = argv;
          const result = spawnSync(
            bin === "node" ? process.execPath : (bin ?? "false"),
            args,
            {
              cwd,
              encoding: "utf8",
              timeout: 120_000,
              env: { PATH: process.env["PATH"] ?? "", HOME: root },
            },
          );
          return {
            exitCode: result.status,
            timedOut: result.error !== undefined,
            outputTruncated: false,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            durationMs: 1,
          };
        },
        async read() {
          return null;
        },
        async destroy() {
          rmSync(root, { recursive: true, force: true });
        },
      };
    },
  };
  return { provider, ran };
}

let upload = { text: "", sha256: "", recordSha256: "" };
let written: ArtifactFile[] = [];
let importDir = "";
let importLog: string[] = [];
let ran: { argv: readonly string[]; hidden: boolean }[] = [];

const version = {
  version: {
    id: "sbv_up",
    sandboxId: "sbx_up",
    version: 1,
    title: "A tenth off",
    specSummary: "Prices take a tenth off.",
    complexity: "S",
    tags: [],
  },
  source: {
    starterRunId: "arn_import",
    buildRunId: "arn_import",
    transformConfigSha256: "1".repeat(64),
    approvedTaskSha256: "2".repeat(64),
  },
};

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "sandbox-import-"));
  const repo = join(scratch, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    '{ "name": "acme-shop", "private": true, "type": "module" }\n',
  );
  writeFileSync(
    join(repo, "tsconfig.json"),
    '{ "compilerOptions": { "strict": true, "module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022" } }\n',
  );
  writeFileSync(
    join(repo, "src/price.ts"),
    "export function discounted(cents: number): number {\n  return cents;\n}\n",
  );
  writeFileSync(
    join(repo, "src/price.test.ts"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { discounted } from "./price.js";\n\ntest("never more", () => assert.ok(discounted(100) <= 100));\n',
  );
  folder = join(scratch, "folder");
  const made = await cut({
    root: repo,
    entries: ["src/price.ts"],
    depth: 1,
    out: folder,
    offline: true,
    public: true,
    withTests: true,
  });
  assert.equal(made.ready, true, JSON.stringify(made.blockers));
  // An offline cut resolves no lockfile; the folder handed over has one.
  const record = JSON.parse(
    readFileSync(join(folder, "carveout.json"), "utf8"),
  ) as Record<string, unknown>;
  writeFileSync(
    join(folder, "carveout.json"),
    `${JSON.stringify({ ...record, lockfile: true }, null, 2)}\n`,
  );
  writeFileSync(
    join(folder, "package-lock.json"),
    `${JSON.stringify({ name: "folder", lockfileVersion: 3, requires: true, packages: { "": { name: "folder" } } }, null, 2)}\n`,
  );
  const files = filesOf(folder).sort((a, b) => (a.path < b.path ? -1 : 1));
  const text = JSON.stringify({
    files,
    acceptanceTests: [
      { path: ACCEPT, text: ACCEPT_TEXT, expectedBaseline: "fail" },
    ],
  });
  upload = {
    text,
    sha256: sha256(text),
    recordSha256: sha256(readFileSync(join(folder, "carveout.json"), "utf8")),
  };
  importDir = join(scratch, "import");
  mkdirSync(importDir);
  const local = localProvider();
  ran = local.ran;
  importLog = [];
  const recorded: unknown[] = [];
  const inputs = {
    getRun: async () => null,
    listArtifacts: async () => [],
    readArtifact: async () => undefined,
    getVersion: async (id: string) => (id === "sbv_up" ? version : null),
    getTask: async () => null,
    recordBuildOutput: async () => false,
    recordStarterOutput: async (...args: unknown[]) => {
      recorded.push(args);
      return true;
    },
    readUpload: async (id: string, hash: string) =>
      id === "sbv_up" && hash === upload.sha256 ? upload.text : null,
  } as unknown as ToolInputs;
  const adapter = createSandboxImportAdapter({ provider: local.provider });
  written = await adapter.run({
    runId: "arn_import",
    sourceDir: join(scratch, "empty"),
    outDir: importDir,
    params: {
      deadlineMinutes: 60,
      importer: "upload",
      sandboxVersionId: "sbv_up",
      uploadSha256: upload.sha256,
      recordSha256: upload.recordSha256,
      carveoutVersion: "0.4.0",
    },
    run: null,
    inputs,
    signal: new AbortController().signal,
    log: (line) => importLog.push(line),
  });
  await adapter.committed?.({ runId: "arn_import", files: written, inputs });
  assert.equal(recorded.length, 1);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

const manifestOf = () =>
  JSON.parse(
    readFileSync(join(importDir, "build-manifest.json"), "utf8"),
  ) as SandboxBuildManifest & { layout: GradingLayout };

test("the folder is the version's public project verbatim, its acceptance test the hidden one, in its own layout", () => {
  const manifest = manifestOf();
  assert.equal(
    manifest.ready,
    true,
    `${JSON.stringify(manifest.baseline?.reasons)}\n${importLog.join("\n")}`,
  );
  assert.equal(manifest.toolVersion, "sandbox_import@2");
  // The upload route scanned its names, this run the rest; there is
  // nothing here to carry back to.
  assert.deepEqual(manifest.gates, {
    roundTrip: { status: "not_applicable", files: 0, problems: [] },
    disclosure: {
      status: "passed",
      scannedBy: "upload",
      names: 0,
      blocking: 0,
      acknowledgedAt: "publish",
      findings: [],
      total: 0,
      acknowledged: 0,
    },
  });
  assert.deepEqual(manifest.upload, {
    recordSha256: upload.recordSha256,
    carveoutVersion: "0.4.0",
  });
  assert.equal(manifest.layout.harnessDir, "carveout");
  assert.equal(manifest.layout.tests.privateDir, null);
  assert.deepEqual(
    manifest.layout.commands.map((command) => command.argv.slice(0, 2)),
    [
      ["npm", "ci"],
      ["node", "node_modules/typescript/bin/tsc"],
      ["node", "carveout/test.js"],
    ],
  );
  assert.ok(manifest.engines?.carveout !== undefined);
  for (const file of filesOf(folder))
    assert.equal(
      readFileSync(join(importDir, "project", file.path), "utf8"),
      file.text,
      file.path,
    );
  assert.equal(
    readFileSync(join(importDir, "private", ACCEPT), "utf8"),
    ACCEPT_TEXT,
  );
  assert.ok(!existsSync(join(importDir, "project", ACCEPT)));
  const classes = Object.fromEntries(
    manifest.files.map((file) => [file.path, file.class]),
  );
  assert.equal(classes["src/price.ts"], "source");
  assert.equal(classes["src/price.test.ts"], "test-public");
  assert.equal(classes[ACCEPT], "test-private");
  assert.equal(classes["carveout.json"], "config");
  assert.equal(classes["sandbox-task.json"], "descriptor");
  assert.equal(classes["carveout/test.js"], "harness");
  const descriptor = JSON.parse(
    readFileSync(join(importDir, "project/sandbox-task.json"), "utf8"),
  ) as { editablePaths: string[] };
  assert.deepEqual(descriptor.editablePaths, ["src/price.ts"]);
  // The baseline: the public suite with no hidden test in its tree, then
  // the acceptance test twice, each in a fresh copy, failing as it must.
  const outcome = manifest.baseline?.privateTests ?? [];
  assert.deepEqual(
    outcome.map((item) => [item.path, item.observed, item.ok]),
    [[ACCEPT, "fail", true]],
  );
  const hidden = ran.filter(
    (step) => step.argv.at(-1) === "src/price.accept.test.js",
  );
  assert.equal(hidden.length, 2);
  assert.ok(hidden.every((step) => step.hidden));
  assert.ok(
    written.some(
      (file) =>
        file.path === `private/${ACCEPT}` && file.kind === "private_test",
    ),
  );
  // The handout's commitment, recorded: duediligence's manifest over the
  // acceptance test at its folder path, where the judge stages it, and not
  // over the name table written beside it under private/.
  assert.ok(written.some((file) => file.path === "private/pseudonym.lunox"));
  const line = `${sha256(ACCEPT_TEXT)}  ${ACCEPT}\n`;
  const kept = `${sha256(JSON.stringify([ACCEPT]))}  calibration.kept\n`;
  assert.deepEqual(manifest.hiddenCommitment, {
    version: 2,
    hiddenTests: 1,
    hiddenSha256: sha256(`${line}${kept}`),
  });
});

test("what the disclosure scan finds in an uploaded folder waits for an owner's acknowledgement at publication, never read by the build; the descriptor's listing is redacted", async () => {
  // The same folder with an address in a comment, and a bounty title that
  // links its tracker.
  const stored = JSON.parse(upload.text) as {
    files: { path: string; text: string }[];
    acceptanceTests: unknown[];
  };
  const files = stored.files.map((file) =>
    file.path === "src/price.ts"
      ? { ...file, text: `// Ask jo@acme-shop.io.\n${file.text}` }
      : file,
  );
  const text = JSON.stringify({ ...stored, files });
  const run = async (acknowledgements: unknown[]) => {
    const outDir = mkdtempSync(join(scratch, "import-found-"));
    const log: string[] = [];
    const inputs = {
      getVersion: async () => ({
        version: {
          ...version.version,
          title: "A tenth off (wiki.acme-shop.io/PRICE)",
        },
        source: {
          ...version.source,
          disclosureAcknowledgements: acknowledgements,
        },
      }),
      readUpload: async () => text,
      recordStarterOutput: async () => true,
    } as unknown as ToolInputs;
    await createSandboxImportAdapter({
      provider: localProvider().provider,
    }).run({
      runId: "arn_import",
      sourceDir: join(scratch, "empty"),
      outDir,
      params: {
        deadlineMinutes: 60,
        importer: "upload",
        sandboxVersionId: "sbv_up",
        uploadSha256: sha256(text),
        recordSha256: upload.recordSha256,
        carveoutVersion: "0.4.0",
      },
      run: null,
      inputs,
      signal: new AbortController().signal,
      log: (line) => log.push(line),
    });
    const manifest = JSON.parse(
      readFileSync(join(outDir, "build-manifest.json"), "utf8"),
    ) as SandboxBuildManifest;
    const descriptor = JSON.parse(
      readFileSync(join(outDir, "project/sandbox-task.json"), "utf8"),
    ) as { title: string };
    return { manifest, descriptor, log };
  };
  const found = await run([]);
  // Recorded as pending, not a blocker: the baseline's verdict stands.
  assert.equal(
    found.manifest.ready,
    true,
    JSON.stringify(found.manifest.baseline?.reasons),
  );
  assert.deepEqual(found.manifest.blockers, []);
  const gate = found.manifest.gates?.disclosure;
  assert.equal(gate?.status, "pending_acknowledgement");
  assert.equal(gate?.acknowledgedAt, "publish");
  assert.equal(gate?.blocking, 0);
  assert.equal(gate?.total, 1);
  assert.deepEqual(
    gate?.findings?.map(({ kind, file, line, value, acknowledged }) => [
      kind,
      `${file}:${line}`,
      value,
      acknowledged,
    ]),
    [["email", "src/price.ts:1", "jo@acme-shop.io", false]],
  );
  assert.ok(
    found.log.some((line) => /1 item\(s\).*acknowledges each/.test(line)),
    found.log.join("\n"),
  );
  // The bounty's words are redacted in the descriptor contributors read.
  assert.equal(found.descriptor.title, "A tenth off ([host removed]/PRICE)");
  // The build reads no acknowledgement: the draft's list changes nothing
  // it writes, so publication checks it and the upload is never rebuilt.
  const acknowledged = await run([
    { kind: "email", value: "jo@acme-shop.io" },
    { kind: "host", value: "wiki.acme-shop.io" },
  ]);
  for (const key of [
    "files",
    "gates",
    "transformConfigSha256",
    "publicProjectSha256",
    "blockers",
  ] as const)
    assert.deepEqual(acknowledged.manifest[key], found.manifest[key], key);
  assert.equal(acknowledged.descriptor.title, found.descriptor.title);
});

test("the judge stages every hidden test in the version's layout, never the name table", async () => {
  const artifacts = [
    "project/src/price.ts",
    "private/pseudonym.lunox",
    "private/src/price.spec.ts",
    "private/tests/private/held.test.ts",
    "private/notes.md",
  ];
  const inputs = {
    listArtifacts: async () =>
      artifacts.map((path) => ({ path, objectKey: path })),
    readArtifact: async (key: string) => Buffer.from(key),
  } as unknown as ToolInputs;
  const staged = async (layout: GradingLayout) =>
    (await versionFilesOf({ inputs }, "arn_build", layout)).map((file) => [
      file.path,
      file.class,
    ]);
  // An upload's layout: each at its own path, a `.spec.ts` too, and a
  // folder path that holds tests/private/ kept whole.
  assert.deepEqual(await staged(manifestOf().layout), [
    ["src/price.ts", "source"],
    ["src/price.spec.ts", "test-private"],
    ["tests/private/held.test.ts", "test-private"],
  ]);
  // The platform's: under tests/private/.
  assert.deepEqual(await staged(PLATFORM_LAYOUT), [
    ["src/price.ts", "source"],
    ["tests/private/src/price.spec.ts", "test-private"],
    ["tests/private/tests/private/held.test.ts", "test-private"],
  ]);
});

test("the stored upload reads back, and anything else does not", () => {
  assert.equal(parseUpload(upload.text)?.acceptanceTests.length, 1);
  assert.equal(parseUpload("not json"), null);
  assert.equal(
    parseUpload('{"files":[{"path":1}],"acceptanceTests":[]}'),
    null,
  );
  assert.equal(
    parseUpload(
      '{"files":[],"acceptanceTests":[{"path":"a","text":"b","expectedBaseline":"maybe"}]}',
    ),
    null,
  );
  const layout = manifestOf().layout;
  assert.equal(
    classOf("carveout/packages/x/index.js", layout, new Set()),
    "mock",
  );
  assert.equal(
    classOf("src/stub.d.ts", layout, new Set(["src/stub.d.ts"])),
    "stub",
  );
  assert.equal(classOf("src/other.spec.ts", layout, new Set()), "test-public");
});

async function grade(
  files: { path: string; text: string }[],
): Promise<SubmissionResult> {
  const outDir = mkdtempSync(join(scratch, "grade-"));
  const local = localProvider();
  const inputs = {
    getRun: async () => null,
    listArtifacts: async (runId: string) =>
      runId === "arn_import"
        ? written.map((file) => ({
            id: file.path,
            runId,
            path: file.path,
            objectKey: file.absolutePath,
            kind: file.kind,
          }))
        : [],
    readArtifact: async (key: string) =>
      existsSync(key) ? readFileSync(key) : undefined,
    getVersion: async () => version,
    getTask: async () => null,
    recordBuildOutput: async () => false,
    recordStarterOutput: async () => false,
    readSubmission: async () => ({
      submission: {
        id: "sbm_up",
        sandboxVersionId: "sbv_up",
        status: "queued",
      },
      files,
    }),
    settleSubmission: () => {},
  } as unknown as ToolInputs;
  const input: ToolRunInput = {
    runId: "arn_grade",
    sourceDir: join(outDir, "source"),
    outDir,
    params: {
      deadlineMinutes: 60,
      grader: "submission",
      submissionId: "sbm_up",
      sandboxVersionId: "sbv_up",
      patchSha256: "a".repeat(64),
    },
    run: null,
    inputs,
    signal: new AbortController().signal,
    log: () => {},
  };
  await createSubmissionGradeAdapter({ provider: local.provider }).run(input);
  return JSON.parse(
    readFileSync(join(outDir, SUBMISSION_RESULT_PATH), "utf8"),
  ) as SubmissionResult;
}

test("a submission that does the work passes through the layout; one that passes the public suite alone is overfit; one that edits the record is refused", async () => {
  const passed = await grade([
    {
      path: "src/price.ts",
      text: "export function discounted(cents: number): number {\n  return Math.round(cents * 0.9);\n}\n",
    },
  ]);
  assert.equal(passed.verdict, "passed", JSON.stringify(passed));
  assert.deepEqual(passed.hidden, { passed: 1, total: 1 });
  const failed = await grade([
    {
      path: "src/price.ts",
      text: "export function discounted(cents: number): number {\n  return cents - 1;\n}\n",
    },
  ]);
  assert.equal(failed.verdict, "overfit", JSON.stringify(failed));
  assert.deepEqual(failed.public, { passed: 1, total: 1 });
  assert.deepEqual(failed.hidden, { passed: 0, total: 1 });
  const refused = await grade([{ path: "carveout.json", text: "{}\n" }]);
  assert.equal(refused.verdict, "refused");
  assert.deepEqual(
    refused.refused?.map((item) => item.path),
    ["carveout.json"],
  );
});
