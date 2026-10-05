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
import type { ToolInputs } from "../src/tools/adapter.js";
import { checkStarter } from "../src/tools/starter-check.js";
import {
  STARTER_CHECKS_MAX,
  STARTER_RUNS_MAX,
  STEP_OUTPUT_CHARS,
  createStarterAdapter,
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
      starter: submission,
      spec: null,
    });
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.ok, true);
    // JSX compiles with the automatic runtime, and packages as `any`.
    const jsx = checkStarter({
      root,
      version: projectVersion,
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
      starter: {
        ...submission,
        scenario: 'import "../src/missing.js";\n',
        aliases: submission.aliases.slice(0, 1),
      },
      spec: null,
    });
    assert.deepEqual(unresolved.problems, [
      "sandbox/run.ts: ../src/missing.js does not resolve to a file in the project.",
    ]);
    // The name table: required, renaming something, and reversible.
    const nameless = checkStarter({
      root,
      version: projectVersion,
      starter: { ...submission, aliases: [] },
      spec: null,
    });
    assert.match(nameless.problems[0] ?? "", /needs a name table/);
    const idle = checkStarter({
      root,
      version: projectVersion,
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
} {
  const results: { content: string; is_error?: boolean }[][] = [];
  const prompts: string[] = [];
  return {
    model: "test-model",
    results,
    prompts,
    async turn(request) {
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

/** A job whose hidden tests fail and everything else passes, unless told otherwise. */
function fakeProvider(
  script: (argv: readonly string[]) => Partial<EvaluationExecResult> = (
    argv,
  ) =>
    argv.some((arg) => arg.startsWith("tests/private/")) ? { exitCode: 1 } : {},
) {
  const commands: string[][] = [];
  let jobs = 0;
  const provider: EvaluationProvider = {
    name: "fake",
    async create() {
      jobs += 1;
      return {
        id: `job_${jobs}`,
        environment: {
          provider: "fake",
          environmentId: null,
          templateDigest: null,
        },
        async stage() {},
        async exec(command: EvaluationCommand) {
          commands.push([...command.argv]);
          return {
            exitCode: 0,
            timedOut: false,
            outputTruncated: false,
            stdout: "",
            stderr: "",
            durationMs: 1,
            ...script(command.argv),
          };
        },
        async read(path) {
          return path === "package-lock.json" ? '{"lockfileVersion":3}' : null;
        },
        async destroy() {},
      };
    },
  };
  return { provider, commands, jobs: () => jobs };
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
  const files = await adapter.run({
    sourceDir: out,
    outDir: join(out, "out"),
    params: runParams as never,
    run: null,
    inputs: toolInputs,
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
  });
  const read = async (path: string) => {
    const file = files.find((item) => item.path === path);
    return file === undefined ? null : readFile(file.absolutePath, "utf8");
  };
  return { out, files, lines, read };
}
const isCode = (code: string) => (error: unknown) =>
  error instanceof AnalysisError && error.code === code;

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
  });
  const recorded: unknown[] = [];
  const { out, files, lines, read } = await runStarter(
    adapter,
    inputs(stored, recorded),
  );
  try {
    // The bounty's own text and stack are the prompt.
    assert.match(model.prompts[0] ?? "", /Sum a cart/);
    assert.match(model.prompts[0] ?? "", /price times quantity/);
    assert.match(model.prompts[0] ?? "", /The tech stack: TypeScript\./);
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
    assert.equal(manifest.toolVersion, "sandbox_starter@2");
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
      : argv.includes("dev")
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
