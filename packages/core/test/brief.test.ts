import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRIEF_MAX_CHARS,
  briefCharsEach,
  cutBrief,
  DOCUMENT_SET_SCHEMA_VERSION,
  renderBrief,
  REPOSITORY_DOCUMENTS_MAX,
  repositoryDocuments,
  treeFacts,
  type AbstractionIndex,
  type DataModel,
  type DocumentSet,
  WORKSPACE_BRIEF_MAX_CHARS,
} from "../src/index.js";

const facts = treeFacts(
  [
    "README.md",
    "package.json",
    "package-lock.json",
    "src/api/routes.ts",
    "src/api/routes.test.ts",
    "src/db/schema.ts",
    "src/db/migrations/0001_init.sql",
    "src/web/App.tsx",
  ].map((path) => ({ path, size: 100 })),
);

const abstractions = {
  schemaVersion: 1,
  toolVersion: "abstractions@3",
  extractors: { typescript: "ts", syntactic: null },
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_g",
  graphSha256: "b".repeat(64),
  modules: [
    {
      path: "src/db/schema.ts",
      language: "typescript",
      coverage: "typed",
      importers: 4,
      exports: [
        {
          id: "s:users",
          name: "users",
          kind: "const",
          signature: null,
          line: 1,
          references: [],
        },
      ],
    },
    {
      path: "src/api/routes.ts",
      language: "typescript",
      coverage: "typed",
      importers: 0,
      exports: [],
    },
  ],
  externals: [],
  omissions: [],
} as unknown as AbstractionIndex;

const dataModel = {
  schemaVersion: 1,
  toolVersion: "data_model@1",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_g",
  graphSha256: "b".repeat(64),
  sources: [
    {
      kind: "drizzle",
      storage: "postgresql",
      files: ["src/db/schema.ts"],
      evidence: [],
      entities: 1,
      shadowed: 0,
    },
  ],
  entities: [
    {
      name: "users",
      table: "users",
      kind: "table",
      source: "drizzle",
      file: "src/db/schema.ts",
      line: 1,
      fields: [{ name: "id" }, { name: "email" }],
      primaryKey: ["id"],
      uniques: [],
    },
  ],
  enums: [],
  relations: [],
  accessors: [
    { module: "src/api/routes.ts", entities: ["users"], importers: 0 },
  ],
  omissions: [],
} as unknown as DataModel;

const documents: DocumentSet = {
  schemaVersion: DOCUMENT_SET_SCHEMA_VERSION,
  toolVersion: "documents@1",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  documents: [
    {
      path: "README.md",
      bytes: 80,
      text: "[![badge](x)](y)\n\n# Shop\n\nSells things.\n\n\n\nTo customers.",
      truncated: false,
    },
    {
      path: "docs/architecture.md",
      bytes: 10,
      text: "Layers.",
      truncated: false,
    },
  ],
  omitted: 0,
};

test("a brief says, in order, the shape, layout, tests, surfaces, data and documents", () => {
  const brief = renderBrief({
    facts,
    stack: ["Node.js", "React"],
    abstractions,
    dataModel,
    documents,
  });
  const order = [
    "8 files, 1 test file.",
    "Stack: Node.js, React.",
    "Layout, largest modules first:",
    "Tests, by module:",
    "Most imported modules, with what they export:",
    "- src/db/schema.ts, 4 importers: users (const)",
    "Data model: 1 entity in postgresql, 0 relations.",
    "- users: id, email",
    "Modules that read or write them:",
    "README, opening:",
    "Documents: docs/architecture.md.",
  ].map((line) => brief.indexOf(line));
  assert.ok(
    order.every(
      (at, index) => at >= 0 && (index === 0 || at > (order[index - 1] ?? -1)),
    ),
    brief,
  );
  // A module nothing imports says nothing of the code's shape.
  assert.ok(!brief.includes("src/api/routes.ts, 0 importers"));
  // The README's badges and blank runs are dropped.
  assert.ok(brief.includes("# Shop\n\nSells things.\n\nTo customers."));
  assert.ok(!brief.includes("badge"));
});

test("a brief is the same for the same inputs, and says less with less", () => {
  const input = { facts, stack: [], abstractions, dataModel, documents };
  assert.equal(renderBrief(input), renderBrief(input));
  const bare = renderBrief({
    facts,
    stack: [],
    abstractions: null,
    dataModel: null,
    documents: null,
  });
  assert.ok(bare.startsWith("8 files, 1 test file."));
  assert.ok(!bare.includes("Data model"));
  assert.ok(!bare.includes("Stack:"));
});

test("a brief is capped, and cut at a line with a mark", () => {
  const many = treeFacts(
    Array.from({ length: 400 }, (_, index) => ({
      path: `packages/p${index}/src/${"x".repeat(60)}${index}.ts`,
      size: 10,
    })),
  );
  const brief = renderBrief({
    facts: many,
    stack: [],
    abstractions: null,
    dataModel: null,
    documents: null,
  });
  assert.ok(brief.length <= BRIEF_MAX_CHARS);
  const cut = cutBrief(brief, 200);
  assert.ok(cut.length <= 200);
  assert.ok(cut.endsWith("(cut for length)"));
  assert.ok(brief.startsWith(cut.slice(0, cut.lastIndexOf("\n"))));
  assert.equal(cutBrief("short", 200), "short");
});

test("a workspace's briefs share one cap, with a floor", () => {
  assert.equal(briefCharsEach(1), BRIEF_MAX_CHARS);
  assert.equal(briefCharsEach(0), BRIEF_MAX_CHARS);
  assert.equal(briefCharsEach(6), 4_000);
  assert.equal(briefCharsEach(100), 1_500);
});

test("up to three repositories each keep a whole brief; past that they share the workspace's", () => {
  assert.equal(briefCharsEach(1), 8_000);
  assert.equal(briefCharsEach(3), 8_000);
  for (const repositories of [4, 16]) {
    const each = briefCharsEach(repositories);
    assert.ok(each < BRIEF_MAX_CHARS, String(repositories));
    const total = each * repositories;
    assert.ok(total <= WORKSPACE_BRIEF_MAX_CHARS, String(repositories));
    // Within a character a repository of the workspace's cap.
    assert.ok(WORKSPACE_BRIEF_MAX_CHARS - total < repositories);
  }
  assert.equal(briefCharsEach(4), 6_000);
  assert.equal(briefCharsEach(16), 1_500);
});

test("a brief cut again keeps within the cap and says it was cut once", () => {
  const text = Array.from(
    { length: 400 },
    (_, index) => `line ${index} ${"y".repeat(index % 40)}`,
  ).join("\n");
  for (const max of [2_000, 500, 80]) {
    const once = cutBrief(text, max);
    assert.ok(once.length <= max, String(max));
    for (const again of [max, Math.floor(max / 2)]) {
      const twice = cutBrief(once, again);
      assert.ok(twice.length <= again, `${max} then ${again}`);
      assert.equal(twice.match(/\(cut for length\)/g)?.length, 1);
      assert.ok(twice.endsWith("(cut for length)"));
    }
  }
});

test("a repository's documents are every one a sync could read, in its order", () => {
  const found = repositoryDocuments(
    [
      "docs/guide.md",
      "CHANGELOG.md",
      "README.md",
      "node_modules/x/README.md",
      "src/README.md",
      "CONTRIBUTING.md",
    ].map((path) => ({ path, size: 10 })),
  );
  assert.deepEqual(found.paths, [
    "README.md",
    "CONTRIBUTING.md",
    "docs/guide.md",
    "src/README.md",
  ]);
  assert.equal(found.omitted, 0);
  const lots = repositoryDocuments(
    Array.from({ length: REPOSITORY_DOCUMENTS_MAX + 5 }, (_, index) => ({
      path: `notes/n${index}.md`,
      size: 10,
    })),
  );
  assert.equal(lots.paths.length, REPOSITORY_DOCUMENTS_MAX);
  assert.equal(lots.omitted, 5);
});
