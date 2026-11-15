import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StoredVersionWithSource } from "@sandbox-factory/db";
import { canonicalJson, transformConfigOf } from "sandbox-factory";
import type {
  EvaluationCommand,
  EvaluationExecResult,
  EvaluationProvider,
  SandboxBuildManifest,
  StarterSubmission,
} from "sandbox-factory";
import type { AgentModel, AgentTurn } from "../src/agent/loop.js";
import { AnalysisError } from "../src/errors.js";
import { meteredAgent } from "../src/agent/metered.js";
import { CALIBRATION_ENGINE } from "../src/tools/calibration.js";
import type { HiddenTestsCalibration } from "../src/tools/calibration.js";
import type { ToolInputs } from "../src/tools/adapter.js";
import { checkStarter } from "../src/tools/starter-check.js";
import {
  STARTER_CHECKS_MAX,
  STARTER_RUNS_MAX,
  STEP_OUTPUT_CHARS,
  createStarterAdapter,
  refusedCheckLog,
  starterDisclosureGate,
} from "../src/tools/starter.js";

const stamp = "2026-10-05T00:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const limits = { maxTurns: 20, maxTokens: 1_000_000 };

const starter: Omit<StarterSubmission, "summary"> = {
  files: [
    {
      path: "src/cart.ts",
      text: [
        "export interface AcmeLine { readonly price: number; readonly quantity: number }",
        "/** What the cart comes to. TODO: the bounty: sum each line's price times quantity. */",
        "export function acmeTotal(lines: readonly AcmeLine[]): number {",
        "  return lines.length === 0 ? 0 : Number.NaN;",
        "}",
        "",
      ].join("\n"),
    },
  ],
  publicTests: [
    {
      path: "tests/public/cart.test.ts",
      text: [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { acmeTotal } from "../../src/cart.js";',
        'test("an empty cart is free", () => assert.equal(acmeTotal([]), 0));',
        "",
      ].join("\n"),
    },
  ],
  hiddenTests: [
    {
      path: "tests/private/total.test.ts",
      text: [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { acmeTotal } from "../../src/cart.js";',
        'test("lines add up", () => assert.equal(acmeTotal([{ price: 2, quantity: 3 }]), 6));',
        "",
      ].join("\n"),
      expectedBaseline: "fail",
    },
  ],
  packages: [],
  scenario:
    'import { acmeTotal } from "../src/cart.js";\nconsole.log(acmeTotal([]));\n',
  aliases: [
    { before: "AcmeLine", after: "Line", kind: "identifier", paths: [] },
    { before: "acmeTotal", after: "total", kind: "identifier", paths: [] },
  ],
};
const submission: StarterSubmission = {
  ...starter,
  summary: "A cart whose total is left to write.",
};
/** What the starter tools take: everything but the pseudonyms, set apart. */
const { aliases: pseudonyms, ...candidate } = starter;
const { aliases: _pseudonyms, ...submitted } = submission;
const setPseudonyms = () =>
  turn([call("set_pseudonyms", { aliases: pseudonyms })]);
/** The hidden tests as the version keeps them: in public names. */
const renamedHiddenTests = submission.hiddenTests.map((test) => ({
  ...test,
  text: test.text.replaceAll("acmeTotal", "total"),
}));
const projectVersion = {
  sandboxId: "sbx_1",
  versionId: "sbv_1",
  version: 1,
  title: "Sum a cart",
  specSummary: "The cart adds up its lines.",
  complexity: "S",
  tags: [],
};

test("a starter type-checks as its build would, and says where it does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "starter-check-"));
  try {
    const ok = checkStarter({
      root,
      version: projectVersion,
      vocabulary: ["acme"],
      starter: submission,
      spec: null,
    });
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.ok, true);
    // JSX compiles with the automatic runtime, and packages as `any`.
    const jsx = checkStarter({
      root,
      version: projectVersion,
      vocabulary: ["acme"],
      starter: {
        ...submission,
        files: [
          {
            path: "src/view.tsx",
            text: 'import { useState } from "react";\nexport function View(props: { readonly name: string }) {\n  const [n] = useState(0);\n  return <p className="x">{props.name} {n}</p>;\n}\n',
          },
          ...submission.files,
        ],
        packages: [{ name: "react", version: "19.1.0" }],
      },
      spec: null,
    });
    assert.deepEqual(jsx.problems, []);
    const broken = checkStarter({
      root,
      version: projectVersion,
      vocabulary: ["acme"],
      starter: {
        ...submission,
        files: [
          {
            path: "src/cart.ts",
            text: "export const acmeTotal: number = 'no';\n",
          },
        ],
        aliases: submission.aliases.slice(1),
      },
      spec: null,
    });
    assert.equal(broken.ok, false);
    assert.ok(
      broken.problems.some((problem) =>
        problem.startsWith("src/cart.ts:1 TS2322"),
      ),
      broken.problems.join("\n"),
    );
    // Rules and generation problems come first, without a compile.
    const misplaced = checkStarter({
      root,
      version: projectVersion,
      vocabulary: ["acme"],
      starter: {
        ...submission,
        files: [{ path: "lib/cart.ts", text: "" }],
        scenario: 'import "../src/missing.js";\n',
      },
      spec: null,
    });
    assert.deepEqual(misplaced.problems, [
      "lib/cart.ts: source files live under src/.",
    ]);
    const unresolved = checkStarter({
      root,
      version: projectVersion,
      vocabulary: ["acme"],
      starter: {
        ...submission,
        scenario: 'import "../src/missing.js";\n',
        aliases: submission.aliases.slice(0, 1),
      },
      spec: null,
    });
    assert.deepEqual(unresolved.problems, [
      "sandbox/run.ts: ../src/missing.js does not resolve to a file in the project.",
      // `acmeTotal` is left in its private name, which says whose it is.
      'src/cart.ts: "acme" names the workspace and appears 3 times in 2 public files: src/cart.ts, tests/public/cart.test.ts. Give it a pseudonym.',
    ]);
    // The name table: required, renaming something, and reversible.
    const nameless = checkStarter({
      root,
      version: projectVersion,
      vocabulary: ["acme"],
      starter: { ...submission, aliases: [] },
      spec: null,
    });
    assert.match(nameless.problems[0] ?? "", /needs a name table/);
    const idle = checkStarter({
      root,
      version: projectVersion,
      vocabulary: ["acme"],
      starter: {
        ...submission,
        aliases: [
          { before: "Globex", after: "Vendor", kind: "identifier", paths: [] },
        ],
      },
      spec: null,
    });
    assert.deepEqual(idle.problems, [
      "Name 1: Globex does not occur in the starter, so it renames nothing.",
    ]);
    const colliding = checkStarter({
      root,
      version: projectVersion,
      vocabulary: ["acme"],
      starter: {
        ...submission,
        aliases: [
          {
            before: "acmeTotal",
            after: "lines",
            kind: "identifier",
            paths: [],
          },
        ],
      },
      spec: null,
    });
    assert.equal(colliding.ok, false);
    assert.match(colliding.problems[0] ?? "", /lines already occurs/);
    const pathRule = checkStarter({
      root,
      version: projectVersion,
      vocabulary: ["acme"],
      starter: {
        ...submission,
        aliases: [
          {
            before: "src/cart.ts",
            after: "src/basket.ts",
            kind: "path",
            paths: [],
          },
        ],
      },
      spec: null,
    });
    assert.match(
      pathRule.problems[0] ?? "",
      /renames identifier and text names, not paths/,
    );
    // Each refusal says where it stopped: only a type error is "types".
    const stages = [broken, misplaced, unresolved, nameless, idle].map(
      (checked) => (checked.ok ? "ok" : checked.stage),
    );
    assert.deepEqual(stages, ["types", "rules", "project", "rules", "names"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a refused check is logged with its problems, a hidden test's only counted", () => {
  const long = `src/a.ts:1 TS2322 ${"x".repeat(400)}`;
  const log = refusedCheckLog("check_starter", "types", [
    long,
    ...Array.from(
      { length: 11 },
      (_, index) => `src/b.ts:${index} TS1005 ';' expected.`,
    ),
    "tests/private/total.test.ts:3 TS2339 Property 'secret' does not exist.",
  ]);
  const lines = log.split("\n");
  assert.equal(lines[0], "check_starter refused (types): 13 problems.");
  // Long problems are cut, and at most ten are shown.
  assert.equal(lines[1], `  ${long.slice(0, 300)}…`);
  assert.equal(lines.length, 1 + 10 + 2);
  assert.equal(lines[11], "  and 2 more");
  assert.equal(lines[12], "  and 1 in hidden tests, not shown");
  assert.doesNotMatch(log, /secret/);
  assert.equal(
    refusedCheckLog("run_starter", "names", ["Name 1: renames nothing."]),
    "run_starter refused (names): 1 problem.\n  Name 1: renames nothing.",
  );
});

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
let calls = 0;
const call = (name: string, input: unknown) => ({
  type: "tool_use",
  id: `${name}-${(calls += 1)}`,
  name,
  input,
});
const turn = (content: unknown[], stopReason = "tool_use"): AgentTurn => ({
  content: content as AgentTurn["content"],
  stopReason,
  usage,
});
function scripted(turns: AgentTurn[]): AgentModel & {
  results: { content: string; is_error?: boolean }[][];
  prompts: string[];
  systems: string[];
} {
  const results: { content: string; is_error?: boolean }[][] = [];
  const prompts: string[] = [];
  const systems: string[] = [];
  return {
    model: "test-model",
    results,
    prompts,
    systems,
    async turn(request) {
      if (request.messages.length === 1) systems.push(request.system);
      const last = request.messages.at(-1);
      if (request.messages.length === 1)
        prompts.push(JSON.stringify(last?.content ?? ""));
      else if (Array.isArray(last?.content))
        results.push(
          last.content as unknown as { content: string; is_error?: boolean }[],
        );
      return turns.shift() ?? turn([], "refusal");
    },
  };
}

/**
 * What the test runner reports for a hidden test that failed as one should:
 * a test that ran and failed, which is not a file that never ran.
 */
const TAP_FAILED = {
  exitCode: 1,
  stdout:
    "TAP version 13\nnot ok 1 - fails\n  failureType: 'testCodeFailure'\n1..1\n# tests 1\n# pass 0\n# fail 1\n",
};

/** A job whose hidden tests fail and everything else passes, unless told otherwise. */
function fakeProvider(
  script: (
    argv: readonly string[],
    /** Every file the job was staged with, by path. */
    staged: ReadonlyMap<string, string>,
  ) => Partial<EvaluationExecResult> = (argv) =>
    argv.some((arg) => arg.startsWith("tests/private/")) ? TAP_FAILED : {},
) {
  const commands: string[][] = [];
  /** Each job's staged files, in order. */
  const stagedJobs: Map<string, string>[] = [];
  let jobs = 0;
  const provider: EvaluationProvider = {
    name: "fake",
    async create() {
      jobs += 1;
      const staged = new Map<string, string>();
      stagedJobs.push(staged);
      return {
        id: `job_${jobs}`,
        environment: {
          provider: "fake",
          environmentId: null,
          templateDigest: null,
        },
        async stage(files) {
          for (const file of files) staged.set(file.path, file.text);
        },
        async exec(command: EvaluationCommand) {
          commands.push([...command.argv]);
          return {
            exitCode: 0,
            timedOut: false,
            outputTruncated: false,
            stdout: "",
            stderr: "",
            durationMs: 1,
            ...script(command.argv, staged),
          };
        },
        async read(path) {
          return path === "package-lock.json" ? '{"lockfileVersion":3}' : null;
        },
        async seal() {},
        async destroy() {},
      };
    },
  };
  return { provider, commands, stagedJobs, jobs: () => jobs };
}

const stored: StoredVersionWithSource = {
  version: {
    id: "sbv_1",
    sandboxId: "sbx_1",
    version: 1,
    title: "Sum a cart",
    specSummary: "The cart adds up its lines.",
    complexity: "S",
    tags: [],
    testSummary: [],
    publicBaseCommitSha: null,
    readme: null,
    languages: null,
    frozenAt: null,
    createdAt: stamp,
  },
  source: {
    sandboxVersionId: "sbv_1",
    origin: "starter",
    sourceSnapshotId: null,
    sourceCommitSha: null,
    sliceRunId: null,
    manifestSha256: null,
    contractSha256: null,
    starterRunId: "arn_starter",
    starterSha256: null,
    transformConfigSha256: "t".repeat(64),
    approvedTaskSha256: "a".repeat(64),
    proposalVersion: 1,
    contextVersions: { jira: null, github: null },
    approvedTask: {
      schemaVersion: 3,
      title: "Sum a cart",
      summary: "The cart adds up its lines: price times quantity.",
      spec: null,
      pricing: null,
      selectedBy: "user_1",
      selectedAt: stamp,
      bountyId: "bty_1",
    },
    aliasRules: [],
    dependencyChoices: {},
    acceptanceTests: [],
    fixtures: null,
    scope: {
      editablePaths: [],
      generatedPaths: [],
      permittedOperations: ["edit", "add"],
      dependencies: [],
      blockers: [],
    },
    harnessSha256: null,
    toolchainDigest: null,
    buildRunId: "arn_starter",
    roundTripRunId: null,
    disclosureRunId: null,
    approvedBy: null,
    approvedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  },
};
const params = {
  deadlineMinutes: 60,
  agent: "starter" as const,
  sandboxVersionId: "sbv_1",
  approvedTaskSha256: "a".repeat(64),
  stack: ["TypeScript"],
  vocabulary: ["acme"],
};
function inputs(
  version: StoredVersionWithSource | null = stored,
  recorded: unknown[] = [],
): ToolInputs {
  return {
    getRun: async () => null,
    listArtifacts: async () => [],
    readArtifact: async () => undefined,
    getVersion: async (id) => (id === "sbv_1" ? version : null),
    getTask: async () => null,
    recordBuildOutput: async () => false,
    recordStarterOutput: async (versionId, runId, output) => {
      recorded.push({ versionId, runId, output });
      return true;
    },
  };
}
async function runStarter(
  adapter: ReturnType<typeof createStarterAdapter>,
  toolInputs: ToolInputs = inputs(),
  runParams: unknown = params,
) {
  const out = await mkdtemp(join(tmpdir(), "starter-run-"));
  const lines: string[] = [];
  const steps: string[] = [];
  const files = await adapter.run({
    sourceDir: out,
    outDir: join(out, "out"),
    params: runParams as never,
    run: null,
    inputs: toolInputs,
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    step: (line) => steps.push(line),
  });
  const read = async (path: string) => {
    const file = files.find((item) => item.path === path);
    return file === undefined ? null : readFile(file.absolutePath, "utf8");
  };
  return { out, files, lines, steps, read };
}
const isCode = (code: string) => (error: unknown) =>
  error instanceof AnalysisError && error.code === code;

test("a starter naming the workspace anywhere a developer reads is refused until renamed", async () => {
  const root = await mkdtemp(join(tmpdir(), "starter-leak-"));
  try {
    const listed = {
      ...projectVersion,
      title: "Sum the Acme cart",
      tags: ["payflow"],
    };
    const check = (
      vocabulary: readonly string[],
      aliases = submission.aliases,
    ) =>
      checkStarter({
        root,
        version: listed,
        starter: { ...submission, aliases },
        spec: null,
        vocabulary,
      });
    // The title and tags reach the README, TASK.md and the descriptor as
    // written: the scan reads the contributor guide too.
    const leaked = check(["acme", "payflow"]);
    assert.equal(leaked.ok, false);
    assert.deepEqual(leaked.problems, [
      'README.md: "acme" names the workspace and appears 3 times in 3 public files: README.md, TASK.md, sandbox-task.json. Give it a pseudonym.',
      'sandbox-task.json: "payflow" names the workspace and appears 1 time in 1 public file: sandbox-task.json. Give it a pseudonym.',
    ]);
    // Renamed by the table, the listing is clean, and the project says so.
    const renamed = check(
      ["acme", "payflow"],
      [
        ...submission.aliases,
        { before: "Acme", after: "Shop", kind: "text", paths: [] },
        { before: "payflow", after: "payments", kind: "text", paths: [] },
      ],
    );
    assert.deepEqual(renamed.problems, []);
    assert.equal(renamed.ok, true);
    if (!renamed.ok) return;
    assert.equal(renamed.project.descriptor.title, "Sum the Shop cart");
    assert.deepEqual(renamed.project.descriptor.tags, ["payments"]);
    assert.match(
      renamed.project.files.find((file) => file.path === "README.md")?.text ??
        "",
      /^# Sum the Shop cart/,
    );
    // A name the table leaves in the source is refused the same way.
    const inSource = check(["acme"], submission.aliases.slice(1));
    assert.equal(inSource.ok, false);
    // A leak alone is the name table's to fix.
    assert.equal(leaked.ok ? "ok" : leaked.stage, "names");
    assert.match(
      inSource.problems.join("\n"),
      /"acme" names the workspace .*: README\.md, TASK\.md, sandbox-task\.json, src\/cart\.ts\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a starter whose public files say whose code it is is refused until renamed; the bounty's own words are redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "starter-disclosure-"));
  try {
    const withComment = (comment: string) => ({
      ...submission,
      files: submission.files.map((file) => ({
        ...file,
        text: `${comment}\n${file.text}`,
      })),
    });
    // An address the agent wrote: refused, naming where, at the names.
    const found = checkStarter({
      root,
      version: projectVersion,
      starter: withComment("// Owner: jo@acme.io, see PAY-12."),
      spec: null,
      vocabulary: [],
      ticketKeys: ["PAY"],
    });
    assert.equal(found.ok, false);
    assert.equal(found.ok ? "ok" : found.stage, "names");
    assert.deepEqual(found.problems, [
      "src/cart.ts:1: email jo@acme.io may say whose code this is. Rename it with a text pseudonym (a reserved example.com, .example or .test name), or leave it out.",
      "src/cart.ts:1: ticket PAY-12 may say whose code this is. Rename it with a text pseudonym (a reserved example.com, .example or .test name), or leave it out.",
    ]);
    // Renamed to a reserved name: it passes. No owner's acknowledgement is
    // read here, so the agent renames even one the draft holds.
    const renamed = checkStarter({
      root,
      version: projectVersion,
      starter: {
        ...withComment("// Owner: jo@acme.io."),
        aliases: [
          ...submission.aliases,
          {
            before: "jo@acme.io",
            after: "dev at example.com",
            kind: "text",
            paths: [],
          },
        ],
      },
      spec: null,
      vocabulary: [],
    });
    assert.deepEqual(renamed.problems, []);
    // A link in the bounty's own title is redacted where it is shown, so
    // it never refuses the starter.
    const linked = checkStarter({
      root,
      version: {
        ...projectVersion,
        title: "Sum a cart (https://wiki.acme.internal/CART)",
      },
      starter: submission,
      spec: null,
      vocabulary: [],
    });
    assert.equal(linked.ok, true, linked.problems.join("\n"));
    if (!linked.ok) return;
    assert.equal(
      linked.project.descriptor.title,
      "Sum a cart ([link removed])",
    );
    for (const file of linked.project.files.filter((each) => each.public))
      assert.doesNotMatch(file.text, /acme\.internal/, file.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a starter's TASK.md carries its confirmed decisions, renamed, unless they would name the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "starter-decided-"));
  try {
    const spec = {
      feature: "Cart",
      background: [],
      scenarios: [
        {
          id: "s1",
          kind: "happy" as const,
          title: "lines add up",
          steps: [{ keyword: "Then" as const, text: "the lines add up" }],
          origin: "draft" as const,
        },
      ],
      openQuestions: [],
      assumptions: ["An empty cart totals zero.", "Acme rounds to the cent."],
    };
    const task = (
      decisions: readonly string[],
      aliases = submission.aliases,
    ) => {
      const checked = checkStarter({
        root,
        version: projectVersion,
        starter: { ...submission, aliases },
        spec,
        decisions,
        vocabulary: ["acme"],
      });
      assert.equal(checked.ok, true, checked.problems.join("\n"));
      return checked.ok
        ? (checked.project.files.find((file) => file.path === "TASK.md")
            ?.text ?? "")
        : "";
    };
    // A decision still naming the workspace keeps the list out of TASK.md.
    assert.doesNotMatch(task(spec.assumptions), /## Decided|Acme/);
    // Renamed by the table, the list is shown.
    assert.match(
      task(spec.assumptions, [
        ...submission.aliases,
        { before: "Acme", after: "The shop", kind: "text", paths: [] },
      ]),
      /## Decided\n\n.*\n\n- An empty cart totals zero\.\n- The shop rounds to the cent\.\n/,
    );
    // Unconfirmed, none.
    assert.doesNotMatch(task([]), /## Decided/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the starter agent checks, runs and submits a starter that is built as the version", async () => {
  const fake = fakeProvider();
  const model = scripted([
    // Checked before any pseudonyms are set, a starter has none.
    turn([call("check_starter", candidate)]),
    turn([call("set_pseudonyms", { aliases: [] })]),
    setPseudonyms(),
    turn([call("check_starter", { ...candidate, files: [] })]),
    turn([call("check_starter", candidate)]),
    turn([call("run_starter", candidate)]),
    turn([call("submit_starter", submitted)]),
  ]);
  const adapter = createStarterAdapter({
    agent: { model, limits },
    provider: fake.provider,
    now: () => new Date(stamp),
    calibration: "off",
  });
  const recorded: unknown[] = [];
  const { out, files, lines, steps, read } = await runStarter(
    adapter,
    // The draft holds an acknowledgement, which the run never reads.
    inputs(
      {
        ...stored,
        source: {
          ...stored.source,
          disclosureAcknowledgements: [
            { kind: "host", value: "stripe.com", by: "user_1", at: stamp },
          ],
        },
      },
      recorded,
    ),
  );
  try {
    // The bounty's own text and stack are the prompt.
    assert.match(model.prompts[0] ?? "", /Sum a cart/);
    assert.match(model.prompts[0] ?? "", /price times quantity/);
    assert.match(model.prompts[0] ?? "", /The tech stack: TypeScript\./);
    assert.match(
      model.prompts[0] ?? "",
      /The workspace's own names, which no public file may carry.*: acme\./,
    );
    assert.match(model.results[0]?.[0]?.content ?? "", /needs a name table/);
    assert.equal(model.results[1]?.[0]?.is_error, true);
    assert.equal(
      model.results[2]?.[0]?.content,
      "2 pseudonyms set; the starter tools rename by them.",
    );
    assert.equal(model.results[3]?.[0]?.is_error, true);
    assert.equal(model.results[4]?.[0]?.content, "The starter compiles.");
    assert.match(
      model.results[5]?.[0]?.content ?? "",
      /^The baseline passes\./,
    );
    assert.match(
      model.results[5]?.[0]?.content ?? "",
      /tests\/private\/total\.test\.ts: expected to fail, failed/,
    );
    // The set keeps the starter as written; the project is renamed.
    assert.match((await read("starter-set.json")) ?? "", /acmeTotal/);
    const cart = (await read("project/src/cart.ts")) ?? "";
    assert.match(cart, /export function total\(lines: readonly Line\[\]\)/);
    assert.doesNotMatch(cart, /acme|Acme/);
    const hidden = (await read("private/total.test.ts")) ?? "";
    assert.match(hidden, /import \{ total \}/);
    // One job for the run, one for the submission.
    assert.equal(fake.jobs(), 2);
    const setText = (await read("starter-set.json")) ?? "";
    const set = JSON.parse(setText) as { summary: string; stack: string[] };
    assert.equal(set.summary, submission.summary);
    assert.deepEqual(set.stack, ["TypeScript"]);
    const manifest = JSON.parse(
      (await read("build-manifest.json")) ?? "",
    ) as SandboxBuildManifest;
    assert.equal(manifest.ready, true);
    assert.equal(manifest.sliceRunId, null);
    assert.equal(manifest.sourceSnapshotId, null);
    assert.equal(manifest.starterSha256, sha(setText));
    assert.equal(manifest.toolVersion, "sandbox_starter@6");
    // No repository to carry back to; the check scanned every public file.
    assert.deepEqual(manifest.gates, {
      roundTrip: { status: "not_applicable", files: 0, problems: [] },
      // The disclosure scan, recorded as a sliced build records it.
      disclosure: {
        status: "passed",
        scannedBy: "build",
        names: 1,
        blocking: 0,
        acknowledgedAt: "publish",
        findings: [],
        total: 0,
        acknowledged: 0,
      },
    });
    // The draft's acknowledgements are not in it: publication reads them.
    assert.equal(
      manifest.transformConfigSha256,
      sha(
        canonicalJson(
          transformConfigOf({
            aliasRules: submission.aliases,
            dependencyChoices: {},
            acceptanceTests: renamedHiddenTests,
            starterSha256: sha(setText),
          }),
        ),
      ),
    );
    const paths = files.map((file) => file.path);
    for (const path of [
      "starter-set.json",
      "build-manifest.json",
      "baseline.json",
      "project/src/cart.ts",
      "project/package-lock.json",
      "project/sandbox/run.ts",
      "private/total.test.ts",
      "private/pseudonym.lunox",
    ])
      assert.ok(paths.includes(path), path);
    // The table the public files were renamed by, kept with the private ones.
    assert.deepEqual(
      JSON.parse((await read("private/pseudonym.lunox")) ?? ""),
      {
        rules: submission.aliases,
        schemaVersion: 1,
      },
    );
    assert.equal(
      files.find((file) => file.path === "private/pseudonym.lunox")?.kind,
      "pseudonyms",
    );
    assert.equal(
      files.find((file) => file.path === "starter-set.json")?.kind,
      "starter_set",
    );
    assert.ok(lines.includes("Starter agent started."));
    // A refused check says where it stopped, not that it does not compile,
    // and the run log keeps its problems.
    assert.equal(
      steps[0],
      "Checked the starter: its files break the starter's rules",
    );
    assert.ok(
      steps.includes("Checked the starter: 3 files compile"),
      steps.join("\n"),
    );
    assert.ok(!steps.some((step) => step.includes("does not compile")));
    // A candidate that does not parse is refused before any check.
    assert.ok(
      steps.includes("Checked the starter: it was refused"),
      steps.join("\n"),
    );
    const refused = lines.filter((line) =>
      line.startsWith("check_starter refused"),
    );
    assert.equal(refused.length, 1, lines.join("\n"));
    assert.match(
      refused[0] ?? "",
      /^check_starter refused \(rules\): 1 problem\.\n {2}.*needs a name table/,
    );
    // Once committed, the starter settles on the version.
    await adapter.committed?.({
      runId: "arn_starter",
      files,
      inputs: inputs(stored, recorded),
    });
    assert.deepEqual(recorded, [
      {
        versionId: "sbv_1",
        runId: "arn_starter",
        output: {
          starterSha256: sha(setText),
          aliasRules: submission.aliases,
          acceptanceTests: renamedHiddenTests,
          scope: {
            editablePaths: ["src/cart.ts"],
            generatedPaths: [],
            permittedOperations: ["edit", "add"],
            dependencies: [],
            blockers: [],
          },
          transformConfigSha256: manifest.transformConfigSha256,
          build: {
            harnessSha256: manifest.harnessSha256,
            toolchainDigest: manifest.toolchainDigest,
          },
          // The descriptor's public counts, which the version shows.
          testSummary: [
            { label: "public", count: 1 },
            { label: "scenarios", count: 0 },
          ],
        },
      },
    ]);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("a failing baseline goes back to the agent, until the runs are spent and it is kept as diagnostic", async () => {
  // The hidden test passes on the starter, which it was said not to.
  const fake = fakeProvider((argv) =>
    argv.some((arg) => arg.startsWith("tests/private/"))
      ? { exitCode: 0, stdout: `ok ${"x".repeat(STEP_OUTPUT_CHARS + 10)}` }
      : argv.includes("sandbox/run.js")
        ? { exitCode: 1, stderr: "TypeError: boom" }
        : {},
  );
  const model = scripted([
    setPseudonyms(),
    ...Array.from({ length: STARTER_RUNS_MAX }, () =>
      turn([call("submit_starter", submitted)]),
    ),
  ]);
  const adapter = createStarterAdapter({
    agent: { model, limits },
    provider: fake.provider,
  });
  const recorded: unknown[] = [];
  const { out, files, read } = await runStarter(
    adapter,
    inputs(stored, recorded),
  );
  try {
    const first = model.results[1]?.[0];
    assert.equal(first?.is_error, true);
    assert.match(first?.content ?? "", /The baseline does not pass\./);
    assert.match(first?.content ?? "", /--- dev \(exit 1\)\nTypeError: boom/);
    // A hidden test that did the unexpected shows its output, cut short.
    assert.match(first?.content ?? "", /--- tests\/private\/total\.test\.ts/);
    assert.match(first?.content ?? "", /…x+$/);
    assert.equal(fake.jobs(), STARTER_RUNS_MAX);
    const manifest = JSON.parse(
      (await read("build-manifest.json")) ?? "",
    ) as SandboxBuildManifest;
    assert.equal(manifest.ready, false);
    assert.ok(
      manifest.blockers.some((blocker) => blocker.code === "baseline_failed"),
    );
    await adapter.committed?.({
      runId: "arn_starter",
      files,
      inputs: inputs(stored, recorded),
    });
    assert.equal(
      (recorded[0] as { output: { build: unknown } }).output.build,
      null,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("checks and runs are bounded, and a run keeps one for the submission", async () => {
  const fake = fakeProvider();
  const model = scripted([
    setPseudonyms(),
    ...Array.from({ length: STARTER_CHECKS_MAX + 1 }, () =>
      turn([call("check_starter", candidate)]),
    ),
    ...Array.from({ length: STARTER_RUNS_MAX }, () =>
      turn([call("run_starter", candidate)]),
    ),
    turn([call("run_starter", { ...candidate, packages: "none" })]),
    // A compile error costs no run, even once the runs are spent.
    turn([
      call("submit_starter", {
        ...submitted,
        files: [
          ...submission.files,
          { path: "src/a.ts", text: "export const a: number = 'x';" },
        ],
      }),
    ]),
    turn([call("submit_starter", { ...submitted, summary: "" })]),
    turn([call("submit_starter", submitted)]),
  ]);
  const adapter = createStarterAdapter({
    agent: { model, limits: { maxTurns: 60, maxTokens: 1_000_000 } },
    provider: fake.provider,
    calibration: "off",
  });
  const { out } = await runStarter(adapter);
  try {
    assert.match(
      model.results[STARTER_CHECKS_MAX + 1]?.[0]?.content ?? "",
      /No checks are left/,
    );
    const runs = model.results.slice(
      STARTER_CHECKS_MAX + 2,
      STARTER_CHECKS_MAX + 2 + STARTER_RUNS_MAX,
    );
    assert.equal(
      runs.filter((result) => /No runs are left/.test(result[0]?.content ?? ""))
        .length,
      1,
    );
    const after = model.results.slice(
      STARTER_CHECKS_MAX + 2 + STARTER_RUNS_MAX,
    );
    assert.equal(after[0]?.[0]?.is_error, true);
    assert.equal(after[1]?.[0]?.is_error, true);
    assert.match(after[1]?.[0]?.content ?? "", /TS2322/);
    assert.equal(after[2]?.[0]?.is_error, true);
    assert.equal(fake.jobs(), STARTER_RUNS_MAX);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("a starter run needs its params, a model, a provider and its own draft", async () => {
  const fake = fakeProvider();
  const agent = { model: scripted([]), limits };
  await assert.rejects(
    runStarter(
      createStarterAdapter({ agent, provider: fake.provider }),
      inputs(),
      {
        deadlineMinutes: 30,
      },
    ),
    isCode("tool_failed"),
  );
  await assert.rejects(
    runStarter(
      createStarterAdapter({
        agent: { model: null, limits },
        provider: fake.provider,
      }),
    ),
    isCode("agent_unavailable"),
  );
  await assert.rejects(
    runStarter(createStarterAdapter({ agent, provider: null })),
    isCode("evaluation_failed"),
  );
  for (const version of [
    null,
    { ...stored, source: { ...stored.source, origin: "slice" as const } },
    { ...stored, version: { ...stored.version, frozenAt: stamp } },
    {
      ...stored,
      source: { ...stored.source, approvedTaskSha256: "b".repeat(64) },
    },
  ])
    await assert.rejects(
      runStarter(
        createStarterAdapter({ agent, provider: fake.provider }),
        inputs(version),
      ),
      isCode("tool_failed"),
    );
  // An agent that never submits leaves nothing behind.
  await assert.rejects(
    runStarter(createStarterAdapter({ agent, provider: fake.provider })),
    isCode("agent_incomplete"),
  );
  // A committed hook with nothing to read records nothing.
  const recorded: unknown[] = [];
  await createStarterAdapter({ agent, provider: fake.provider }).committed?.({
    runId: "arn_starter",
    files: [],
    inputs: inputs(stored, recorded),
  });
  assert.deepEqual(recorded, []);
});

// Calibration: a reference agent with the hidden tests withheld.

const TAP_PASSED = {
  exitCode: 0,
  stdout:
    "TAP version 13\nok 1 - passes\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n",
};
const hiddenTest = (
  name: string,
  body: string,
  expectedBaseline: "pass" | "fail",
) => ({
  path: `tests/private/${name}.test.ts`,
  text: [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { acmeTotal } from "../../src/cart.js";',
    `test("HIDDEN ${name}", () => ${body});`,
    "",
  ].join("\n"),
  expectedBaseline,
});
/** Two tests a finished bounty passes, and a guard the starter already does. */
const calibratedSubmission = {
  ...submitted,
  hiddenTests: [
    hiddenTest(
      "one",
      "assert.equal(acmeTotal([{ price: 2, quantity: 3 }]), 6)",
      "fail",
    ),
    hiddenTest(
      "two",
      "assert.equal(acmeTotal([{ price: 2, quantity: 3 }, { price: 1, quantity: 1 }]), 7)",
      "fail",
    ),
    hiddenTest("zero", "assert.equal(acmeTotal([]), 0)", "pass"),
  ],
};
/** The reference, in the public names the project is written in. */
const referenceFiles = [
  {
    path: "src/cart.ts",
    text: [
      "export interface Line { readonly price: number; readonly quantity: number }",
      "export function total(lines: readonly Line[]): number {",
      "  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);",
      "}",
      "",
    ].join("\n"),
  },
];
/**
 * Jobs in which a hidden test passes when the project holds the reference
 * (and the guard always), except those named: the reference fails them.
 */
const calibrating = (referenceFails: readonly string[]) =>
  fakeProvider((argv, staged) => {
    const path = argv.find((arg) => arg.includes("tests/private/"));
    if (path === undefined) return {};
    const implemented = (staged.get("src/cart.ts") ?? "").includes(
      "lines.reduce(",
    );
    const passes =
      path.includes("zero.test") ||
      (implemented &&
        !referenceFails.some((name) => path.includes(`${name}.test`)));
    return passes ? TAP_PASSED : TAP_FAILED;
  });
const calibrationTurns = () => [
  setPseudonyms(),
  turn([call("submit_starter", calibratedSubmission)]),
  turn([call("run_reference", { files: referenceFiles })]),
  turn([call("submit_reference", { files: null, summary: "none" })]),
];
async function calibratedStarter(referenceFails: readonly string[]) {
  const fake = calibrating(referenceFails);
  const model = scripted(calibrationTurns());
  const ledger: unknown[] = [];
  const adapter = createStarterAdapter({
    agent: meteredAgent(
      { model, limits },
      { organizationId: "org_1", id: "arn_starter", tool: "sandbox_starter" },
      { record: async (_owner, entry) => void ledger.push(entry) },
      () => {},
    ),
    provider: fake.provider,
  });
  const recorded: unknown[] = [];
  const ran = await runStarter(adapter, inputs(stored, recorded));
  const json = async <T>(path: string) =>
    JSON.parse((await ran.read(path)) ?? "null") as T;
  const transform = await json<{
    acceptanceTests: { path: string }[];
    hiddenTests: { calibration: HiddenTestsCalibration };
  }>("build-transform.json");
  const manifest = await json<SandboxBuildManifest>("build-manifest.json");
  const set = await json<{ hiddenTests: { path: string }[] }>(
    "starter-set.json",
  );
  await adapter.committed?.({
    runId: "arn_starter",
    files: ran.files,
    inputs: inputs(stored, recorded),
  });
  return {
    ...ran,
    fake,
    model,
    ledger,
    recorded: recorded as {
      output: { acceptanceTests: { path: string }[]; build: unknown };
    }[],
    calibration: transform.hiddenTests.calibration,
    transform,
    manifest,
    set,
  };
}

test("a starter's hidden tests that a reference written without them passes are all kept", async () => {
  const built = await calibratedStarter([]);
  try {
    const { model, calibration, manifest, fake } = built;
    // The reference is told the duediligence brief and why the tests are
    // withheld; nothing it reads or is told holds a hidden test.
    const system = model.systems[1] ?? "";
    assert.match(system, /The interface is at `src\/cart\.ts`\./);
    assert.match(system, /the hidden tests are withheld/);
    assert.doesNotMatch(system, /\{\{/);
    const told = [model.prompts[1] ?? "", model.results[1]?.[0]?.content];
    for (const text of told) assert.doesNotMatch(text ?? "", /HIDDEN|private/);
    assert.match(
      model.results[1]?.[0]?.content ?? "",
      /^The project builds, and its walkthrough and public tests pass\./,
    );
    assert.ok(
      built.steps.includes("Ran a reference: its public tests pass"),
      built.steps.join("\n"),
    );
    // The submission's job, the reference's run without hidden tests, and
    // the one run of the hidden tests on the reference it submitted.
    assert.equal(fake.jobs(), 3);
    const [, referenceRun, hiddenRun] = fake.stagedJobs;
    assert.ok(
      ![...(referenceRun?.keys() ?? [])].some((path) =>
        path.includes("private"),
      ),
    );
    assert.match(hiddenRun?.get("src/cart.ts") ?? "", /lines\.reduce\(/);
    assert.equal(calibration.engine, CALIBRATION_ENGINE);
    assert.equal(calibration.status, "ok");
    assert.deepEqual(calibration.kept, [
      "tests/private/one.test.ts",
      "tests/private/two.test.ts",
      "tests/private/zero.test.ts",
    ]);
    assert.deepEqual(calibration.dropped, []);
    assert.deepEqual(calibration.reference, {
      files: ["src/cart.ts"],
      summary: "none",
    });
    // The reference's turns are its own usage, and on the ledger.
    assert.equal(calibration.usage.turns, 2);
    assert.equal(calibration.usage.inputTokens, 20);
    assert.equal(built.ledger.length, 4);
    assert.equal(manifest.ready, true);
    assert.equal(built.set.hiddenTests.length, 3);
    assert.equal(built.transform.acceptanceTests.length, 3);
    assert.deepEqual(
      built.files.find((file) => file.path === "starter-set.json")?.meta?.[
        "calibration"
      ],
      { status: "ok", kept: 3, dropped: 0, usage: calibration.usage },
    );
    assert.equal(built.recorded[0]?.output.acceptanceTests.length, 3);
  } finally {
    await rm(built.out, { recursive: true, force: true });
  }
});

test("a hidden test the reference fails is dropped and reported, and the starter is built again without it", async () => {
  const built = await calibratedStarter(["two"]);
  try {
    const { calibration, manifest, fake, set } = built;
    assert.equal(calibration.status, "ok");
    assert.deepEqual(calibration.kept, [
      "tests/private/one.test.ts",
      "tests/private/zero.test.ts",
    ]);
    assert.equal(calibration.dropped.length, 1);
    assert.equal(calibration.dropped[0]?.path, "tests/private/two.test.ts");
    assert.match(
      calibration.dropped[0]?.reason ?? "",
      /^The reference cannot satisfy it/,
    );
    assert.ok(
      built.lines.some((line) =>
        line.startsWith("Calibration dropped tests/private/two.test.ts:"),
      ),
      built.lines.join("\n"),
    );
    // The kept set's baseline is run again, and is the build's.
    assert.equal(fake.jobs(), 4);
    assert.equal(manifest.ready, true);
    assert.deepEqual(
      manifest.baseline?.privateTests.map((outcome) => outcome.path),
      ["tests/private/one.test.ts", "tests/private/zero.test.ts"],
    );
    assert.equal(manifest.hiddenCommitment?.hiddenTests, 2);
    assert.deepEqual(
      set.hiddenTests.map((test) => test.path),
      calibration.kept,
    );
    const paths = built.files.map((file) => file.path);
    assert.ok(paths.includes("private/one.test.ts"));
    assert.ok(!paths.includes("private/two.test.ts"));
    assert.deepEqual(
      built.recorded[0]?.output.acceptanceTests.map((test) => test.path),
      calibration.kept,
    );
  } finally {
    await rm(built.out, { recursive: true, force: true });
  }
});

test("a starter left with no hidden test that should fail is held, its set kept as diagnostic", async () => {
  const built = await calibratedStarter(["one", "two"]);
  try {
    const { calibration, manifest, fake, set } = built;
    assert.equal(calibration.status, "dropped");
    assert.deepEqual(calibration.kept, ["tests/private/zero.test.ts"]);
    assert.equal(fake.jobs(), 3);
    assert.equal(manifest.ready, false);
    assert.equal(manifest.baseline?.ok, false);
    assert.ok(
      manifest.baseline?.reasons.some((reason) =>
        /^Calibration \(duediligence@[^)]+\) kept no hidden test that should fail/.test(
          reason,
        ),
      ),
      JSON.stringify(manifest.baseline?.reasons),
    );
    assert.ok(
      manifest.blockers.some((blocker) => blocker.code === "baseline_failed"),
    );
    // Nothing settles as a build; the agent's set stays as written.
    assert.equal(set.hiddenTests.length, 3);
    assert.equal(built.recorded[0]?.output.build, null);
  } finally {
    await rm(built.out, { recursive: true, force: true });
  }
});

test("a finding in a starter's built files waits for an owner's acknowledgement at publication rather than holding the build", () => {
  const files = [
    {
      path: "src/cart.ts",
      text: "// Prices as https://docs.stripe.com/api/prices lists them.\nexport const total = 0;\n",
      class: "source" as const,
      public: true,
    },
    {
      path: "tests/private/total.test.ts",
      text: "// jo@acme.io\n",
      class: "test-private" as const,
      public: false,
    },
  ];
  const gate = starterDisclosureGate({
    files,
    blockers: [],
    names: 1,
    ticketKeys: [],
    aliases: [],
  });
  // A public file's alone, recorded for publication, blocking nothing.
  assert.equal(gate.status, "pending_acknowledgement");
  assert.equal(gate.acknowledgedAt, "publish");
  assert.equal(gate.blocking, 0);
  assert.deepEqual(
    gate.findings?.map(({ kind, file, line, value, acknowledged }) => [
      kind,
      `${file}:${line}`,
      value,
      acknowledged,
    ]),
    [["url", "src/cart.ts:1", "https://docs.stripe.com/api/prices", false]],
  );
  // A workspace name left behind still fails the gate outright.
  const leaked = starterDisclosureGate({
    files,
    blockers: [{ code: "vocabulary_leaked", file: "README.md", detail: "x" }],
    names: 1,
    ticketKeys: [],
    aliases: [],
  });
  assert.equal(leaked.status, "failed");
  assert.equal(leaked.blocking, 1);
});
