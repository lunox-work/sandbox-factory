import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  folderPrefix,
  folderSubmission,
  isBuildOutput,
  isGuidePath,
  skippedName,
  withoutBuildOutput,
  withoutGuideFiles,
  type FolderFile,
} from "../src/index.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const VERSION: Record<string, string> = {
  "package.json": '{"name":"fees"}\n',
  "package-lock.json": "{}\n",
  "tsconfig.json": "{}\n",
  "sandbox-task.json": "{}\n",
  "README.md": "# Fees\n",
  "TASK.md": "# Task\n",
  ".vscode/settings.json": "{}\n",
  "src/fees.ts": "export const fee = () => 0;\n",
  "src/other.ts": "export const other = 1;\n",
  "src/vendor.d.ts": "export declare const v: number;\n",
  "src/vendor.js": "export const v = 1;\n",
  "tests/public/fees.test.ts": "test('fee');\n",
  "sandbox/run.ts": "run();\n",
};
const EDITABLE = ["src/fees.ts", "src/other.ts"];
const version = Object.entries(VERSION).map(([path, text]) => ({
  path,
  sha256: sha(text),
  text,
}));

/** The downloaded folder with `changes` applied (null deletes). */
function folder(changes: Record<string, string | null> = {}): FolderFile[] {
  const files = { ...VERSION, ...changes };
  return Object.entries(files)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([path, text]) => ({ path, sha256: sha(text), text }));
}

test("guide and editor files are the contributor's, unless editable", () => {
  for (const path of [
    "TASK.md",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    ".vscode/settings.json",
    ".idea/workspace.xml",
    // The VS Code extension's note of which contribution the folder is.
    ".lunox/contribution.json",
  ])
    assert.equal(isGuidePath(path), true, path);
  for (const path of ["src/README.md", "docs/TASK.md", "vscode/x", "src/a.ts"])
    assert.equal(isGuidePath(path), false, path);
  const { kept, ignored } = withoutGuideFiles(
    [
      { path: ".vscode/settings.json", text: "{}" },
      { path: "README.md", text: "mine" },
      { path: "src/fees.ts", text: "x" },
    ],
    ["src/fees.ts", "README.md"],
  );
  assert.deepEqual(
    kept.map((file) => file.path),
    ["README.md", "src/fees.ts"],
  );
  assert.deepEqual(ignored, [".vscode/settings.json"]);
});

test("installed packages, version control and OS files are skipped by name", () => {
  for (const name of [
    "sbx-v1/node_modules/typescript/lib/tsc.js",
    "node_modules/.bin/tsc",
    ".git/HEAD",
    "sbx-v1/.git/objects/ab",
    "__MACOSX/sbx-v1/._fees.ts",
    "sbx-v1/src/.DS_Store",
    "Thumbs.db",
    "src/._fees.ts",
  ])
    assert.equal(skippedName(name), true, name);
  for (const name of ["src/fees.ts", "sbx-v1/src/git.ts", "modules/x.ts"])
    assert.equal(skippedName(name), false, name);
});

test("one top folder is read as the project's root when that lands on its files", () => {
  const paths = new Set(Object.keys(VERSION));
  assert.equal(
    folderPrefix(
      ["sbx_1-v1/", "sbx_1-v1/src/fees.ts", "sbx_1-v1/package.json"],
      paths,
    ),
    "sbx_1-v1/",
  );
  assert.equal(folderPrefix(["src/fees.ts", "package.json"], paths), "");
  // Zipped from inside `src`'s parent with only `src` in it: the paths
  // already are the project's.
  assert.equal(folderPrefix(["src/fees.ts", "src/other.ts"], paths), "");
  assert.equal(folderPrefix([], paths), "");
});

test("the changed task file is taken; guide files, build output and unchanged files are not", () => {
  const solved = "export const fee = () => 25;\n";
  const result = folderSubmission({
    files: [
      ...folder({
        "src/fees.ts": solved,
        ".vscode/settings.json": '{"editor.tabSize":2}\n',
        "TASK.md": "# Task, with my notes\n",
      }),
      // What `npm run build` wrote beside each source.
      { path: "src/fees.js", sha256: sha("x"), text: "x" },
      { path: "src/fees.js.map", sha256: sha("m"), text: "m" },
      { path: "sandbox/run.js", sha256: sha("r"), text: "r" },
      { path: "tests/public/fees.test.js", sha256: sha("t"), text: "t" },
    ],
    version,
    editablePaths: EDITABLE,
  });
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.files, [{ path: "src/fees.ts", text: solved }]);
  assert.deepEqual(result.changed, [
    { path: "src/fees.ts", change: "changed" },
  ]);
  assert.deepEqual(result.ignored, [".vscode/settings.json", "TASK.md"]);
  assert.equal(result.buildOutput, 4);
  assert.deepEqual(result.missing, []);
  assert.equal(result.matched, Object.keys(VERSION).length);
});

test("a new TypeScript file beside the task is added, with its build output skipped", () => {
  const result = folderSubmission({
    files: [
      ...folder(),
      {
        path: "src/minimum.ts",
        sha256: sha("export const min = 25;\n"),
        text: "export const min = 25;\n",
      },
      { path: "src/minimum.js", sha256: sha("js"), text: "js" },
    ],
    version,
    editablePaths: EDITABLE,
  });
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.changed, [
    { path: "src/minimum.ts", change: "added" },
  ]);
  assert.equal(result.buildOutput, 1);
});

test("changed read-only files are refused by name, to be reverted, as grading would", () => {
  const result = folderSubmission({
    files: folder({
      "src/fees.ts": "export const fee = () => 25;\n",
      "package.json": '{"name":"fees","scripts":{"test":"true"}}\n',
      "tests/public/fees.test.ts": "test.skip('fee');\n",
      "tsconfig.json": '{"strict":false}\n',
    }),
    version,
    editablePaths: EDITABLE,
  });
  assert.deepEqual(result.files, []);
  assert.deepEqual(
    result.refused.map((refusal) => refusal.path),
    ["package.json", "tests/public/fees.test.ts", "tsconfig.json"],
  );
  for (const refusal of result.refused)
    assert.match(refusal.reason, /Revert it to the version's text\.$/);
  assert.match(
    result.refused[0]?.reason ?? "",
    /^package\.json is the version's; scripts/,
  );
  // The task file is still what it would submit, once they are reverted.
  assert.deepEqual(result.changed, [
    { path: "src/fees.ts", change: "changed" },
  ]);
});

test("new files grading would refuse, and task code it would refuse, are refused here", () => {
  const result = folderSubmission({
    files: [
      ...folder({
        "src/fees.ts":
          'import { recordedCalls } from "../sandbox/mock.js";\nexport const fee = () => 25;\n',
      }),
      { path: "notes.txt", sha256: sha("n"), text: "n" },
      { path: "tests/public/mine.test.ts", sha256: sha("t2"), text: "t2" },
    ],
    version,
    editablePaths: EDITABLE,
  });
  const paths = result.refused.map((refusal) => refusal.path);
  assert.ok(paths.includes("notes.txt"), JSON.stringify(result.refused));
  assert.ok(paths.includes("tests/public/mine.test.ts"));
  assert.ok(paths.includes("src/fees.ts"));
  assert.deepEqual(result.files, []);
});

test("a deleted task file is refused; a missing read-only file keeps the version's", () => {
  const result = folderSubmission({
    files: folder({
      "src/fees.ts": "export const fee = () => 25;\n",
      "src/other.ts": null,
      "package-lock.json": null,
      "README.md": null,
    }),
    version,
    editablePaths: EDITABLE,
  });
  assert.deepEqual(result.refused, [
    {
      path: "src/other.ts",
      reason:
        "Deleted. A submission cannot delete a file yet: restore it from the downloaded project.",
    },
  ]);
  assert.deepEqual(result.missing, ["package-lock.json"]);
  assert.deepEqual(result.files, []);
});

test("line endings alone are no change; binary and symlinked files are refused", () => {
  const crlf = VERSION["src/other.ts"]?.replace(/\n/g, "\r\n") ?? "";
  const result = folderSubmission({
    files: [
      ...folder({
        "src/other.ts": crlf,
        "package.json": '{"name":"fees"}\r\n',
      }),
      { path: "src/logo.ts", sha256: sha("bin"), text: null },
      { path: "src/link.ts", sha256: sha("l"), text: "../x", symlink: true },
    ],
    version,
    editablePaths: EDITABLE,
  });
  assert.deepEqual(
    result.refused.map((refusal) => [refusal.path, refusal.reason]),
    [
      ["src/link.ts", "Symbolic links are not taken."],
      [
        "src/logo.ts",
        "Only text files are submitted; this one is not UTF-8 text.",
      ],
    ],
  );
  assert.deepEqual(result.changed, []);
});

test("another folder matches none of the version's files", () => {
  const result = folderSubmission({
    files: [{ path: "index.ts", sha256: sha("x"), text: "x" }],
    version,
    editablePaths: EDITABLE,
  });
  assert.equal(result.matched, 0);
});

test("files[] drop exactly the build output a folder skips, and the version's own .js stays", () => {
  const versionPaths = Object.keys(VERSION);
  const sent = [
    { path: "src/fees.ts", text: "export const fee = () => 25;\n" },
    // Emitted beside a source sent or the version's: build output.
    { path: "src/fees.js", text: "x" },
    { path: "src/other.js", text: "o" },
    { path: "src/fees.js.map", text: "m" },
    { path: "src/new.mts", text: "export {};\n" },
    { path: "src/new.mjs", text: "n" },
    // The version's own `.js` (a stub runtime) and a `.js` with no source.
    { path: "src/vendor.js", text: "export const v = 2;\n" },
    { path: "src/plain.js", text: "p" },
  ];
  const { kept, dropped } = withoutBuildOutput(sent, versionPaths);
  assert.deepEqual(dropped, [
    "src/fees.js",
    "src/other.js",
    "src/fees.js.map",
    "src/new.mjs",
  ]);
  assert.deepEqual(
    kept.map((file) => file.path),
    ["src/fees.ts", "src/new.mts", "src/vendor.js", "src/plain.js"],
  );
  const version = new Set(versionPaths);
  const present = new Set(sent.map((file) => file.path));
  assert.equal(isBuildOutput("src/vendor.js", present, version), false);
  assert.equal(
    isBuildOutput("src/x.jsx", new Set(["src/x.tsx"]), version),
    true,
  );
  assert.equal(
    isBuildOutput("src/x.cjs", new Set(["src/x.cts"]), version),
    true,
  );
  assert.equal(isBuildOutput("src/x.ts", present, version), false);
  // What the folder rules skip is what the files[] rule drops: the same sets.
  const result = folderSubmission({
    files: [
      ...folder(),
      ...sent.map((file) => ({
        path: file.path,
        sha256: sha(file.text),
        text: file.text,
      })),
    ],
    version: Object.entries(VERSION).map(([path, text]) => ({
      path,
      sha256: sha(text),
      text,
    })),
    editablePaths: EDITABLE,
  });
  assert.equal(result.buildOutput, dropped.length);
});
