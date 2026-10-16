import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ABSTRACTIONS_TOOL_VERSION,
  SEAMS_INDEX_SCHEMA_VERSION,
  SEAMS_LIMITS,
  buildSeamsIndex,
  detectExternals,
  fileSeams,
  lookupSeams,
  parseSliceGraph,
  seamsFiles,
} from "../src/index.js";

const sources: Record<string, string> = {
  "src/db.ts": `import pg from "pg";\nexport const url = process.env.DATABASE_URL;\nconst region = process.env["AWS_REGION"];`,
  "src/s3.ts": `import { S3Client } from "@aws-sdk/client-s3";\nconst r = process.env.AWS_REGION;`,
  "src/http.py": `import requests\nimport os\nkey = os.environ.get("API_KEY")`,
  "src/pure.ts": `export const add = (a: number, b: number) => a + b;`,
};
const meta = {
  snapshotId: "rsn_1",
  commitSha: "c".repeat(40),
  graphRunId: "arn_graph",
  graphSha256: "s",
};
const index = buildSeamsIndex({
  ...meta,
  files: [
    ...Object.entries(sources).map(([path, text]) => fileSeams(path, text)),
    fileSeams("src/gone.ts", null),
  ],
});

test("the seams index lists, per module, what the slice would list for it", () => {
  assert.equal(index.schemaVersion, SEAMS_INDEX_SCHEMA_VERSION);
  assert.equal(index.toolVersion, ABSTRACTIONS_TOOL_VERSION);
  assert.equal(index.files, 5);
  assert.deepEqual(index.modules, [
    {
      path: "src/db.ts",
      packages: [{ specifier: "pg", service: "postgres" }],
      environment: ["AWS_REGION", "DATABASE_URL"],
    },
    {
      path: "src/http.py",
      packages: [{ specifier: "requests", service: "http" }],
      environment: ["API_KEY"],
    },
    {
      path: "src/s3.ts",
      packages: [{ specifier: "@aws-sdk/client-s3", service: "aws" }],
      environment: ["AWS_REGION"],
    },
  ]);
  // A file that could not be read is not one the index can answer for.
  assert.deepEqual(index.partial, ["src/gone.ts"]);
  assert.equal(index.coveredThrough, null);
});

test("a lookup over any files is detectExternals over the same files", () => {
  const files = ["src/s3.ts", "src/db.ts", "src/pure.ts", "src/http.py"];
  for (let size = 1; size <= files.length; size += 1) {
    const subset = files.slice(0, size);
    const found = lookupSeams(index, subset);
    assert.deepEqual(found.unknown, []);
    assert.deepEqual(
      found.externals,
      detectExternals(
        subset.map((path) => ({ path, text: sources[path] ?? "" })),
      ),
    );
  }
  const missing = lookupSeams(index, ["src/gone.ts", "src/db.ts"]);
  assert.deepEqual(missing.unknown, ["src/gone.ts"]);
  assert.deepEqual(
    missing.externals.environment.map((entry) => entry.name),
    ["AWS_REGION", "DATABASE_URL"],
  );
});

test("a module with more names than it may list is partial, its first names kept", () => {
  const many = Array.from(
    { length: SEAMS_LIMITS.environmentPerModule + 1 },
    (_, n) => `process.env.V${String(n).padStart(3, "0")}`,
  ).join("\n");
  const entry = fileSeams("src/config.ts", many);
  assert.equal(entry.exact, false);
  assert.equal(
    entry.entry?.environment.length,
    SEAMS_LIMITS.environmentPerModule,
  );
  const built = buildSeamsIndex({ ...meta, files: [entry] });
  assert.deepEqual(built.partial, ["src/config.ts"]);
  assert.equal(built.modules.length, 1);
  assert.deepEqual(lookupSeams(built, ["src/config.ts"]).unknown, [
    "src/config.ts",
  ]);
  assert.deepEqual(fileSeams("src/pure.ts", sources["src/pure.ts"] ?? ""), {
    path: "src/pure.ts",
    entry: null,
    exact: true,
  });
});

test("past its entry bound the index says where it stopped, and later files are unknown", () => {
  const files = Array.from({ length: SEAMS_LIMITS.entries + 2 }, (_, n) =>
    fileSeams(`f/${String(n).padStart(6, "0")}.ts`, null),
  );
  const built = buildSeamsIndex({
    ...meta,
    files: [fileSeams("a/pure.ts", ""), ...files.reverse()],
  });
  assert.equal(built.partial.length, SEAMS_LIMITS.entries);
  const last = `f/${String(SEAMS_LIMITS.entries - 1).padStart(6, "0")}.ts`;
  assert.equal(built.coveredThrough, last);
  assert.deepEqual(lookupSeams(built, ["a/pure.ts", "z/after.ts"]).unknown, [
    "z/after.ts",
  ]);
});

test("the index covers every file the graph names", () => {
  const graph = parseSliceGraph({
    nodes: [
      { id: "file:b.ts", label: "b.ts", source_file: "b.ts" },
      { id: "symbol:b.ts:x", label: "x", source_file: "b.ts" },
      { id: "symbol:a.ts:y", label: "y()", source_file: "a.ts" },
      { id: "dependency:a.ts:pg", label: "pg", source_file: "a.ts" },
    ],
    links: [],
  });
  assert.deepEqual(seamsFiles(graph), ["a.ts", "b.ts"]);
});
