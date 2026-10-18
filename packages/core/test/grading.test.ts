import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GRADING_COMMANDS,
  baselineVerdict,
  confinedCodeProblems,
  fixtureProblems,
  gradingTree,
  privateTestArgv,
  scenarioProblems,
  taskCodeProblems,
} from "../src/index.js";
import type { BoundaryModule, GeneratedFile, PathClass } from "../src/index.js";

test("fixture code that keeps the rules is accepted", () => {
  for (const text of [
    "() => 1",
    "async (id) => ({ id, name: 'Ada', joined: new Date('2024-01-02') })",
    "(rows) => rows[0]",
    '(item) => item["id"] ?? item?.[1]',
    "(xs) => xs.filter((x) => /^a\\//.test(x)).length / 2",
    "() => `total: ${[1, 2].map((n) => n * 2).join(', ')}`",
    "(id) => { switch (id) { case 1: return { id }; default: return null; } }",
    "() => ({ ...{ a: 1 }, b: [1, [2, 3]], 'c-d': 0x1f, e: 1.5e3, f: 10n })",
    "function find(id) { const [a, b] = [id, 2]; return a + b; }",
    "(x) => x.of / 2",
    // After `=>` a `/` opens a regular expression, quote and all.
    "(x) => /'/.test(x) + 'process'",
    "(s) => 'process' + \"constructor\" + `globalThis`",
    "// a comment naming process\n() => 1",
    "() => { /* setTimeout */ return 1; }",
    // A quoted key that names nothing forbidden, and quoted values.
    "(o) => { const { 'id': i } = o; return { 'c-d': i }; }",
    "(id) => { switch (id) { case 'random': return 1; default: return 0; } }",
    "(x) => (x ? 'process' : 'constructor')",
    // `!` as negation before a regular expression, and as an assertion.
    "(s) => { return !/a/.test(s); }",
    "(x) => x!.size / 2",
  ])
    assert.deepEqual(confinedCodeProblems(text), [], text);
});

test("fixture code that reaches outside its function is refused, however it is spelled", () => {
  const refused: readonly [string, RegExp][] = [
    ["() => process.env.SECRET", /`process` is not allowed/],
    ["() => globalThis.fetch('https://x')", /`globalThis`/],
    ["() => require('fs')", /`require`/],
    ["() => import('node:fs')", /`import`/],
    ["() => import.meta.url", /`import`/],
    ["() => setTimeout(() => 1, 10)", /`setTimeout`/],
    ["() => queueMicrotask(() => 1)", /`queueMicrotask`/],
    ["() => Math.random()", /`random`/],
    ["() => crypto.randomUUID()", /`crypto`/],
    ["() => Buffer.from('x')", /`Buffer`/],
    ["() => eval('1')", /`eval`/],
    ["() => new Function('return 1')()", /`Function`/],
    ["() => (() => 1).constructor('return process')()", /`constructor`/],
    ["(x) => x.__proto__", /`__proto__`/],
    ["() => Reflect.get(Math, 'x')", /`Reflect`/],
    [
      "() => Object.getOwnPropertyDescriptor(Math, 'x')",
      /`getOwnPropertyDescriptor`/,
    ],
    // The clock, read or aliased.
    ["() => Date.now()", /`Date` is allowed only/],
    ["() => new Date()", /`Date` is allowed only/],
    ["() => { const D = Date; return new D(); }", /`Date` is allowed only/],
    ["() => new Date(...[])", /`Date` is allowed only/],
    ["() => new Intl.DateTimeFormat().format()", /`Intl`/],
    ["() => Temporal.Now.instant()", /`Temporal`/],
    // A name built at run time instead of written.
    ["() => Math['ran' + 'dom']()", /computed member/],
    ["(k) => Math[k]", /computed member/],
    ["() => (() => 1)[`constructor`]", /computed member/],
    ["() => ({})['constructor']", /computed member/],
    ["() => ({})['\\x63onstructor']", /computed member/],
    ["(o) => o?.[k]", /computed member/],
    ["(o) => { const { ['con' + 'structor']: F } = o; return F; }", /computed/],
    ["() => ({ ['a' + 'b']: 1 })", /computed/],
    ["(o) => o[`id`]", /computed member/],
    // A quoted key reads or defines what it names.
    [
      '() => { const { "constructor": F } = () => 0; return F("return 1")(); }',
      /quoted key/,
    ],
    ['() => { const { "random": r } = Math; return r(); }', /quoted key/],
    [
      '() => { const { "\\x63onstructor": F } = () => 0; return F; }',
      /quoted key/,
    ],
    ["() => ({ '__proto__': null })", /quoted key/],
    ["() => ({ get 'constructor'() { return 1; } })", /quoted key/],
    // Spelled so a substring match would miss it.
    ["() => \\u0070rocess.exit()", /could not be read/],
    ["() => 1..constructor", /`constructor`/],
    ["() => 1.constructor", /could not be read/],
    ["() => `${process.pid}`", /`process`/],
    ["() => { with (Math) return 1; }", /`with`/],
    // A `/` that could hide code in a literal either way.
    ["() => { if (x) {} /'/; process; '/' }", /could not be read/],
    ["(x) => x.of /process/ 1", /`process`/],
    // TypeScript's non-null assertion, after which `/` divides.
    [
      "(x) => { const n = x! / 2; console.log(process.env); const q = n / 1; }",
      /could not be read/,
    ],
    [
      "(x) => { const n = x!! / 2; process; const q = n / 1; }",
      /could not be read/,
    ],
    [
      "(a) => { const n = a[0]! / 2; process; const q = n / 1; }",
      /could not be read/,
    ],
    ["() => 'unterminated", /could not be read/],
    ["() => `${1", /could not be read/],
    ["() => /* open", /could not be read/],
  ];
  for (const [text, reason] of refused) {
    const problems = confinedCodeProblems(text);
    assert.ok(
      problems.some((problem) => reason.test(problem)),
      `${text}: ${problems.join(" | ")}`,
    );
  }
});

test("fixtures and walkthroughs are refused on the same rules", () => {
  const [problem] = fixtureProblems(
    [
      {
        module: "lib/clock.ts",
        symbol: "now",
        member: null,
        call: "call",
        implementation: "() => Date.now()",
        reason: "",
      },
    ],
    [
      {
        module: "lib/clock.ts",
        symbols: [
          {
            name: "now",
            kind: "function",
            declaration: "export declare function now(): number;",
          },
        ],
        importedBy: ["src/app.ts"],
        stubPath: "lib/clock.d.ts",
      },
    ] satisfies BoundaryModule[],
  );
  assert.deepEqual(problem, {
    fixture: 0,
    detail:
      "`Date` is allowed only as `new Date(value)`, never the current time.",
  });
  assert.deepEqual(
    scenarioProblems(
      'import { run } from "../src/app.js";\nimport type { T } from "./types.js";\nexport {};\nconsole.log(run());\n',
    ),
    [],
  );
  assert.deepEqual(
    scenarioProblems(
      'import fs from "node:fs";\nexport * from "../x.js";\nconst m = await import("../src/app.js");\nconsole.log(process.argv);\n',
    ).map((item) => item.detail),
    [
      "node:fs is not a relative import; the walkthrough imports only the project's own files.",
      "`import` is not allowed.",
      "`process` is not allowed.",
    ],
  );
});

const file = (
  path: string,
  text: string,
  cls: PathClass = "source",
  isPublic = true,
): GeneratedFile => ({ path, text, class: cls, public: isPublic });

/** A version's files, as a build writes them. */
const VERSION: readonly GeneratedFile[] = [
  file("src/cart/total.ts", "export const total = 0;\n"),
  file("src/cart/tax.ts", "export const tax = 0;\n"),
  file("src/db/client.d.ts", "export declare const db: any;\n", "stub"),
  file("src/db/client.js", "export const db = mock;\n", "mock"),
  file("src/cart/rates.d.ts", "export declare const rate: 1;\n", "stub"),
  file("src/cart/rates.js", "export const rate = mock;\n", "mock"),
  file("sandbox/mock.js", "// runtime\n", "harness"),
  file("sandbox/run.ts", "// walkthrough\n", "harness"),
  file("mocks/pg/index.js", "// pg\n", "mock"),
  file("tests/public/spec.test.ts", "// public\n", "test-public"),
  file("tests/private/fix.test.ts", "// hidden\n", "test-private", false),
  file("package.json", '{"scripts":{"test":"node --test"}}\n', "config"),
  file("package-lock.json", "{}\n", "config"),
  file("tsconfig.json", "{}\n", "config"),
  file(".npmrc", "ignore-scripts=true\n", "config"),
  file(".gitignore", "node_modules/\n", "config"),
  file("sandbox.env", "A=1\n", "config"),
  file("sandbox-task.json", "{}\n", "descriptor"),
];
const EDITABLE = ["src/cart/tax.ts", "src/cart/total.ts"];

test("a submission is graded on the version's files with only its task files taken", () => {
  const tree = gradingTree({
    versionFiles: VERSION,
    editablePaths: EDITABLE,
    submission: [
      file("src/cart/total.ts", "export const total = 42;\n"),
      // Unchanged files, harness among them, are not changes.
      file("src/cart/tax.ts", "export const tax = 0;\n"),
      file("package.json", '{"scripts":{"test":"node --test"}}\n'),
      // A new file beside the task's own.
      file("src/cart/discount.ts", "export const discount = 1;\n"),
    ],
  });
  assert.deepEqual(tree.refused, []);
  assert.deepEqual(tree.changed, ["src/cart/discount.ts", "src/cart/total.ts"]);
  const byPath = new Map(tree.files.map((item) => [item.path, item]));
  assert.equal(
    byPath.get("src/cart/total.ts")?.text,
    "export const total = 42;\n",
  );
  assert.equal(byPath.get("src/cart/discount.ts")?.class, "source");
  // The hidden tests and everything else stay the version's.
  assert.equal(byPath.get("tests/private/fix.test.ts")?.text, "// hidden\n");
  assert.equal(tree.files.length, VERSION.length + 1);
});

test("a submission that changes what grading runs is refused, with every reason", () => {
  const tree = gradingTree({
    versionFiles: VERSION,
    editablePaths: EDITABLE,
    submission: [
      file("src/cart/total.ts", "export const total = 42;\n"),
      file("package.json", '{"scripts":{"test":"exit 0"}}\n'),
      file("package-lock.json", "{ }\n"),
      file(".npmrc", "\n"),
      file("tsconfig.build.json", "{}\n"),
      file("tsconfig.json", '{"exclude":["tests"]}\n'),
      file("sandbox.env", "A=2\n"),
      file(".gitignore", "\n"),
      file("sandbox-task.json", "{}\n\n"),
      file("sandbox/mock.js", "// mine\n"),
      file("mocks/pg/index.js", "// mine\n"),
      file("tests/private/fix.test.ts", "// mine\n"),
      file("tests/public/extra.test.ts", "// mine\n"),
      file("src/db/client.js", "// mine\n"),
      file("src/db/client.ts", "// a directory the task has no file in\n"),
      file("src/cart/rates.ts", "// lands on the stub's runtime\n"),
      file("src/cart/Total.ts", "// a case-insensitive clash\n"),
      file("src/cart/total.tsx", "// compiles onto total.js\n"),
      file("src/cart/total.test.ts", "// a test\n"),
      file("src/cart/types.d.ts", "// a declaration\n"),
      file("src/cart/helper.js", "// JavaScript\n"),
      file("src/other/new.ts", "// a directory the task has no file in\n"),
      file("root.ts", "// the root\n"),
      file("../escape.ts", ""),
      file("/abs.ts", ""),
      file("C:/win.ts", ""),
      file("src\\cart\\x.ts", ""),
      file("src//cart/x.ts", ""),
      file("", ""),
      { path: "src/cart/link.ts", text: "../../package.json", symlink: true },
      file("src/cart/tax.ts", "export const tax = 1;\n"),
      file("src/cart/tax.ts", "export const tax = 2;\n"),
    ],
  });
  assert.deepEqual(tree.files, []);
  const reasons = new Map(tree.refused.map((item) => [item.path, item.reason]));
  for (const [path, reason] of [
    ["package.json", /scripts and dependencies/],
    ["package-lock.json", /lockfile/],
    [".npmrc", /\.npmrc/],
    ["tsconfig.build.json", /Compiler configuration/],
    ["tsconfig.json", /Compiler configuration/],
    ["sandbox.env", /fixture environment/],
    [".gitignore", /\.gitignore/],
    ["sandbox-task.json", /sandbox-task\.json/],
    ["sandbox/mock.js", /sandbox\/ is the version's harness/],
    ["mocks/pg/index.js", /mocks\//],
    ["tests/private/fix.test.ts", /tests\//],
    ["tests/public/extra.test.ts", /tests\//],
    ["src/db/client.js", /mock file of the version/],
    ["src/db/client.ts", /beside the task's editable files/],
    ["src/cart/rates.ts", /land on src\/cart\/rates\.js/],
    ["src/cart/Total.ts", /land on src\/cart\/total\.ts/],
    ["src/cart/total.tsx", /land on src\/cart\/total\.ts/],
    ["src/cart/total.test.ts", /Test files/],
    ["src/cart/types.d.ts", /Only TypeScript/],
    ["src/cart/helper.js", /Only TypeScript/],
    ["src/other/new.ts", /beside the task's editable files/],
    ["root.ts", /beside the task's editable files/],
    ["../escape.ts", /`\.\.` segment/],
    ["/abs.ts", /absolute/],
    ["C:/win.ts", /absolute/],
    ["src\\cart\\x.ts", /backslash/],
    ["src//cart/x.ts", /empty/],
    ["", /empty/],
    ["src/cart/link.ts", /Symbolic links/],
    ["src/cart/tax.ts", /twice/],
  ] as const)
    assert.match(reasons.get(path) ?? "", reason, path);
});

test("task code that reaches the mock runtime or the test run is refused", () => {
  const refusedFor = (text: string) =>
    gradingTree({
      versionFiles: VERSION,
      editablePaths: EDITABLE,
      submission: [file("src/cart/total.ts", text)],
    }).refused.map((item) => item.reason);
  assert.deepEqual(
    refusedFor(
      'import { recordedCalls } from "../../sandbox/mock.js";\nexport const total = recordedCalls().length;\n',
    ),
    [
      "Task code must not use recordedCalls, mockImplementation or resetMocks; they are for tests.",
      "../../sandbox/mock.js reaches the mock runtime; task code imports only task code, stubs and packages.",
    ],
  );
  for (const [text, reason] of [
    ['import "../../sandbox/run.js";', /reaches the harness/],
    ['export * from "../../mocks/pg/index.js";', /reaches the harness/],
    ['const m = await import("../../sandbox/mock.js");', /mock runtime/],
    ['const m = await import("../../sand" + "box/mock.js");', /one string/],
    ["const m = await import(`../../sandbox/mock.js`);", /one string/],
    ['const m = require("../../sandbox/mock.js");', /not require/],
    ['import { createRequire } from "node:module";', /not require/],
    ['const a = process.getBuiltinModule("node:assert");', /not require/],
    ['const fs = process.binding("fs");', /internal bindings/],
    ['import assert from "node:assert/strict";', /test run/],
    ['import { mock } from "node:test";', /test run/],
    ['import vm from "vm";', /test run/],
    ['import x from "/abs/sandbox/mock.js";', /absolute path or URL/],
    ['import x from "file:///sandbox/mock.js";', /absolute path or URL/],
    ['import x from "../../../outside.js";', /leaves the project/],
    ['import x from "pg/../../sandbox/mock.js";', /leaves the project/],
    ['export const f = eval("1");', /evaluate strings/],
    ['export const f = Function("return 1");', /evaluate strings/],
    [
      'const m = "resetMocks";',
      /recordedCalls, mockImplementation or resetMocks/,
    ],
  ] as const)
    assert.ok(
      refusedFor(text).some((item) => reason.test(item)),
      `${text}: ${refusedFor(text).join(" | ")}`,
    );
  // Task code may import task code, stubs, packages and Node's own modules.
  assert.deepEqual(
    taskCodeProblems(
      "src/cart/total.ts",
      'import { tax } from "./tax.js";\nimport { db } from "../db/client.js";\nimport pg from "pg";\nimport { readFile } from "node:fs/promises";\nconst lazy = () => import("./tax.js");\nexport const total = tax;\n',
    ),
    [],
  );
  // An unchanged file is the version's own and is not read again.
  const original = "const m = await import(name);\nexport const tax = 0;\n";
  assert.deepEqual(
    gradingTree({
      versionFiles: [
        ...VERSION.filter((f) => f.path !== "src/cart/tax.ts"),
        file("src/cart/tax.ts", original),
      ],
      editablePaths: EDITABLE,
      submission: [file("src/cart/tax.ts", original)],
    }).refused,
    [],
  );
});

test("grading runs the version's own commands, never a package script", () => {
  for (const command of GRADING_COMMANDS)
    assert.ok(
      !(command.argv[0] === "npm" && command.argv[1] === "run"),
      command.name,
    );
  assert.deepEqual(
    GRADING_COMMANDS.map((command) => command.name),
    ["install", "build", "public-tests"],
  );
  assert.deepEqual(GRADING_COMMANDS[0]?.argv.slice(0, 3), [
    "npm",
    "ci",
    "--ignore-scripts",
  ]);
  assert.deepEqual(privateTestArgv("tests/private/fix.test.ts"), [
    "node",
    "--env-file=sandbox.env",
    "--test",
    "--test-reporter=tap",
    "tests/private/fix.test.js",
  ]);
});

test("a hidden test that disagreed with itself fails the baseline", () => {
  const verdict = baselineVerdict({
    steps: [],
    privateTests: [
      {
        path: "tests/private/fix.test.ts",
        expected: "fail",
        observed: "flaky",
        ok: false,
      },
    ],
  });
  assert.deepEqual(verdict.reasons, [
    "tests/private/fix.test.ts gave different results on two runs.",
  ]);
});
