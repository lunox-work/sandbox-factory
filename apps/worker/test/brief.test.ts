import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { StoredAnalysisRun, StoredArtifact } from "@sandbox-factory/db";
import {
  BRIEF_TOOL_VERSION,
  CONTEXT_DOCUMENT_CHARS,
  DOCUMENTS_TOOL_VERSION,
} from "sandbox-factory";
import type { DocumentSet } from "sandbox-factory";
import {
  briefSummarySchema,
  documentSetSchema,
  documentsSummarySchema,
} from "@sandbox-factory/shared";
import { AnalysisError } from "../src/errors.js";
import type { ToolInputs } from "../src/tools/adapter.js";
import { createBriefAdapter } from "../src/tools/brief.js";
import {
  createDocumentsAdapter,
  keptDocument,
} from "../src/tools/documents.js";
import { contextModel, contextRun } from "./context-fixtures.js";
import { toolContext } from "./helpers.js";

const stamp = "2026-10-16T00:00:00.000Z";

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "brief-source-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const source = {
  "README.md": "# Widgets\r\n\r\nMakes widgets.\n",
  "CONTRIBUTING.md": "Run the tests.",
  "docs/empty.md": "   \n",
  "docs/long.md": "x".repeat(CONTEXT_DOCUMENT_CHARS + 10),
  "CHANGELOG.md": "History.",
  "node_modules/dep/README.md": "Vendored.",
  "package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }),
  "src/index.ts": "export const one = 1;\n",
  "src/index.test.ts": "import './index';\n",
};

test("a document is kept as a sync keeps it, cut to its cap", () => {
  assert.equal(keptDocument("a.md", 3, " \n "), null);
  assert.deepEqual(keptDocument("a.md", 5, "a\r\nb\r"), {
    path: "a.md",
    bytes: 5,
    text: "a\nb",
    truncated: false,
  });
  const long = keptDocument("b.md", 1, "y".repeat(CONTEXT_DOCUMENT_CHARS + 1));
  assert.equal(long?.text.length, CONTEXT_DOCUMENT_CHARS);
  assert.equal(long?.truncated, true);
});

test("the documents builder keeps every document a sync could read", async () => {
  const root = await repository(source);
  const out = await mkdtemp(join(tmpdir(), "documents-out-"));
  try {
    const adapter = createDocumentsAdapter();
    assert.equal(adapter.version, DOCUMENTS_TOOL_VERSION);
    const [file, ...rest] = await adapter.run({
      ...toolContext(),
      sourceDir: root,
      outDir: out,
      params: { deadlineMinutes: 30, builder: "documents" },
      signal: new AbortController().signal,
      log: () => {},
    });
    assert.equal(rest.length, 0);
    assert.equal(file?.kind, "documents");
    const set = documentSetSchema.parse(
      JSON.parse(await readFile(file?.absolutePath ?? "", "utf8")),
    );
    assert.deepEqual(
      set.documents.map(({ path, truncated }) => [path, truncated]),
      [
        ["README.md", false],
        ["CONTRIBUTING.md", false],
        ["docs/long.md", true],
      ],
    );
    assert.equal(set.documents[0]?.text, "# Widgets\n\nMakes widgets.");
    assert.equal(set.sourceSnapshotId, "rsn_1");
    assert.deepEqual(documentsSummarySchema.parse(file?.meta), {
      documents: 3,
      omitted: 0,
      chars: set.documents.reduce((sum, { text }) => sum + text.length, 0),
    });
    await assert.rejects(
      adapter.run({
        ...toolContext(),
        sourceDir: root,
        outDir: out,
        params: { deadlineMinutes: 30 },
        signal: new AbortController().signal,
        log: () => {},
      }),
      (error) => error instanceof AnalysisError && error.code === "tool_failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

/** A succeeded documents run on the snapshot, served back. */
function documentsRun(set: DocumentSet) {
  const bytes = Buffer.from(JSON.stringify(set));
  const run: StoredAnalysisRun = {
    id: "arn_docs",
    snapshotId: "rsn_1",
    repoId: "ghr_1",
    tool: "documents",
    toolVersion: DOCUMENTS_TOOL_VERSION,
    params: { deadlineMinutes: 30, builder: "documents" },
    status: "succeeded",
    attempt: 0,
    maxAttempts: 2,
    errorCode: null,
    errorDetail: null,
    progress: null,
    startedAt: stamp,
    finishedAt: stamp,
    deadlineAt: stamp,
    createdAt: stamp,
  };
  const artifact: StoredArtifact = {
    id: "art_docs",
    runId: run.id,
    kind: "documents",
    path: "documents.json",
    objectKey: "runs/arn_docs/documents.json",
    contentType: "application/json",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    meta: null,
    createdAt: stamp,
  };
  return { run, artifact, bytes };
}

test("the brief reads what the builders on its snapshot wrote, and goes without the rest", async () => {
  const root = await repository(source);
  const out = await mkdtemp(join(tmpdir(), "brief-out-"));
  const documents = documentsRun({
    schemaVersion: 1,
    toolVersion: DOCUMENTS_TOOL_VERSION,
    sourceSnapshotId: "rsn_1",
    sourceCommitSha: "a".repeat(40),
    documents: [
      {
        path: "README.md",
        bytes: 10,
        text: "# Widgets\n\nMakes widgets.",
        truncated: false,
      },
    ],
    omitted: 0,
  });
  const model = contextRun("arn_model", "data_model", contextModel);
  // The data model is listed but its bytes are not served, as if altered.
  const served = new Map([[documents.artifact.objectKey, documents.bytes]]);
  const runs = new Map<string, StoredAnalysisRun>([
    ["documents", documents.run],
    ["data_model", model.run],
  ]);
  const inputs: ToolInputs = {
    ...toolContext().inputs,
    getRun: async (id) =>
      [...runs.values()].find((run) => run.id === id) ?? null,
    latestSucceeded: async (_snapshot, tool) => runs.get(tool) ?? null,
    listArtifacts: async (id) =>
      id === documents.run.id
        ? [documents.artifact]
        : id === model.run.id
          ? [model.artifact]
          : [],
    readArtifact: async (key) => served.get(key),
  };
  const lines: string[] = [];
  try {
    const adapter = createBriefAdapter();
    assert.equal(adapter.version, BRIEF_TOOL_VERSION);
    const [file] = await adapter.run({
      ...toolContext(),
      inputs,
      sourceDir: root,
      outDir: out,
      params: { deadlineMinutes: 30, builder: "brief" },
      signal: new AbortController().signal,
      log: (line) => lines.push(line),
    });
    assert.equal(file?.kind, "brief_md");
    const brief = await readFile(file?.absolutePath ?? "", "utf8");
    assert.ok(brief.startsWith("8 files, 1 test file."), brief);
    assert.ok(brief.includes("Stack: "), brief);
    assert.ok(brief.includes("README, opening:\n# Widgets"), brief);
    assert.ok(!brief.includes("Data model"), brief);
    assert.deepEqual(briefSummarySchema.parse(file?.meta).read, {
      abstractions: false,
      dataModel: false,
      documents: true,
    });
    assert.ok(lines.some((line) => line.includes("data_model run")));
    // Outside the queue there is nothing to read, and the brief is the
    // file list's alone.
    const [bare] = await adapter.run({
      ...toolContext(),
      sourceDir: root,
      outDir: out,
      params: { deadlineMinutes: 30, builder: "brief" },
      signal: new AbortController().signal,
      log: () => {},
    });
    assert.ok(
      !(await readFile(bare?.absolutePath ?? "", "utf8")).includes("README"),
    );
    await assert.rejects(
      adapter.run({
        ...toolContext(),
        sourceDir: root,
        outDir: out,
        params: { deadlineMinutes: 30, builder: "documents" },
        signal: new AbortController().signal,
        log: () => {},
      }),
      (error) => error instanceof AnalysisError && error.code === "tool_failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});
