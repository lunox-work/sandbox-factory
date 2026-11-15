import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { privateTestArgv } from "sandbox-factory";
import {
  HIDDEN_RUN_DIR,
  hiddenRunFiles,
  hiddenRunnerPath,
  hiddenRunnerSource,
} from "../src/evaluation/hidden-runner.js";
import type { HiddenRunnerHooks } from "../src/evaluation/hidden-runner.js";
import { privateTestOutcome, tapPoints } from "../src/tools/sandbox-build.js";

const scratch = mkdtempSync(join(tmpdir(), "hidden-runner-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const ENTRY = "tests/private/s1-doubles.test.js";
const OTHER = "tests/private/s2-other.test.js";

/**
 * Task code that looks for the hidden tests every ordinary way: listing
 * their directory and the runner's, reading the test by its path, and
 * importing it, and says what it found on stderr.
 */
const TASK = `import { readdirSync, readFileSync } from "node:fs";
const tryIt = (f) => { try { return f(); } catch (error) { return "ERR " + error.code; } };
export function double(x) {
  const found = {
    dir: tryIt(() => readdirSync("tests/private")),
    runner: tryIt(() => readdirSync("${HIDDEN_RUN_DIR}")),
    file: tryIt(() => readFileSync("${ENTRY}", "utf8").length),
    other: tryIt(() => readFileSync("${OTHER}", "utf8").length),
  };
  console.error("FOUND " + JSON.stringify(found));
  return x * 2;
}
export async function importTest() {
  try {
    await import("../${ENTRY}");
    return "loaded";
  } catch (error) {
    return error.code;
  }
}
`;

const TESTS = {
  pass: `import { test } from "node:test";
import assert from "node:assert/strict";
import { double, importTest } from "../../src/double.js";
test("doubles", () => assert.equal(double(2), 4));
test("knows its own URL", () => assert.match(import.meta.url, /tests\\/private\\/s1-doubles\\.test\\.js$/));
test("task code cannot import it by path", async () => assert.equal(await importTest(), "ERR_MODULE_NOT_FOUND"));
`,
  fail: `import { test } from "node:test";
import assert from "node:assert/strict";
import { double } from "../../src/double.js";
test("doubles wrongly", () => assert.equal(double(2), 5));
`,
  broken: `import { test } from "node:test";
import { missing } from "../../src/double.js";
test("never runs", () => missing());
`,
};

/** A built tree after the seal, with one hidden run's files written in. */
function runIn(
  name: string,
  text: string | null,
  hooks: HiddenRunnerHooks,
): { stdout: string; exitCode: number | null; root: string } {
  const root = join(scratch, name);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests/private"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(root, "sandbox.env"), "MODE=test\n");
  writeFileSync(join(root, "src/double.js"), TASK);
  const run = hiddenRunFiles(
    { entry: ENTRY, load: "memory" },
    privateTestArgv("tests/private/s1-doubles.test.ts"),
    text,
    hooks,
  );
  for (const file of run.files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.text);
  }
  const [, ...args] = run.argv;
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env["PATH"] ?? "" },
  });
  return { stdout: result.stdout, exitCode: result.status, root };
}

const outcome = (run: { stdout: string; exitCode: number | null }) =>
  privateTestOutcome({ exitCode: run.exitCode, timedOut: false }, run.stdout);

const modes: HiddenRunnerHooks[] = [
  "async",
  ...(typeof (
    createRequire(import.meta.url)("node:module") as {
      registerHooks?: unknown;
    }
  ).registerHooks === "function"
    ? (["sync"] as const)
    : []),
];

for (const hooks of modes)
  test(`the runner loads the hidden test from memory, gone from disk before task code runs (${hooks} hooks)`, () => {
    const run = runIn(`pass-${hooks}`, TESTS.pass, hooks);
    assert.equal(outcome(run), "pass", run.stdout);
    assert.deepEqual(tapPoints(run.stdout), [
      "ok 1 - doubles",
      "ok 2 - knows its own URL",
      "ok 3 - task code cannot import it by path",
    ]);
    // Task code found the directory empty, the runner alone beside it, and
    // neither this test nor another by path.
    const found = JSON.parse(
      /FOUND (\{.*\})/.exec(run.stdout)?.[1] ?? "null",
    ) as Record<string, unknown>;
    assert.deepEqual(found, {
      dir: [],
      runner: ["s1-doubles.test.mjs"],
      file: "ERR ENOENT",
      other: "ERR ENOENT",
    });
    assert.equal(
      existsSync(join(run.root, HIDDEN_RUN_DIR, "s1-doubles.payload")),
      false,
    );
  });

test("a failing test fails and a test that never ran its tests is an error, as before", () => {
  assert.equal(outcome(runIn("fail", TESTS.fail, "auto")), "fail");
  const broken = runIn("broken", TESTS.broken, "auto");
  assert.equal(outcome(broken), "error");
  // The runner, named after the test, is the point reported for the file.
  assert.match(broken.stdout, /^not ok 1 - .*s1-doubles\.test\.mjs$/m);
  // The build left no emitted test: an error, never a pass.
  assert.equal(outcome(runIn("unbuilt", null, "auto")), "error");
});

test("a hidden run names the runner in the entry's place; one read from disk goes back at its path", () => {
  assert.equal(
    hiddenRunnerPath("tests/private/s3-x.test.js"),
    `${HIDDEN_RUN_DIR}/s3-x.test.mjs`,
  );
  assert.equal(
    hiddenRunnerPath("src/cart.accept.mjs"),
    `${HIDDEN_RUN_DIR}/cart.accept.test.mjs`,
  );
  const memory = hiddenRunFiles(
    { entry: ENTRY, load: "memory" },
    ["node", "--test", ENTRY],
    "/* test */",
  );
  assert.deepEqual(memory.argv, [
    "node",
    "--test",
    `${HIDDEN_RUN_DIR}/s1-doubles.test.mjs`,
  ]);
  assert.deepEqual(
    memory.files.map((file) => file.path),
    [
      `${HIDDEN_RUN_DIR}/s1-doubles.test.mjs`,
      `${HIDDEN_RUN_DIR}/s1-doubles.payload`,
    ],
  );
  // The runner carries paths, never the test.
  assert.doesNotMatch(memory.files[0]?.text ?? "", /\/\* test \*\//);
  assert.equal(memory.files[0]?.text, hiddenRunnerSource(ENTRY));
  const disk = hiddenRunFiles(
    { entry: "src/cart.test.ts", load: "disk" },
    ["vitest", "run", "src/cart.test.ts"],
    "/* vitest */",
  );
  assert.deepEqual(disk, {
    files: [{ path: "src/cart.test.ts", text: "/* vitest */" }],
    argv: ["vitest", "run", "src/cart.test.ts"],
  });
  assert.deepEqual(
    hiddenRunFiles({ entry: "src/a.test.ts", load: "disk" }, ["x"], null).files,
    [],
  );
  assert.throws(
    () =>
      hiddenRunFiles({ entry: ENTRY, load: "memory" }, ["node", "x.js"], ""),
    /exactly once/,
  );
  assert.throws(
    () => hiddenRunFiles({ entry: ENTRY, load: "memory" }, [ENTRY, ENTRY], ""),
    /exactly once/,
  );
});
