import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { StoredAnalysisRun, StoredArtifact } from "@sandbox-factory/db";

import { readBrief, readDocumentSet } from "../src/sizing/brief.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function source(
  files: Record<string, { kind: StoredArtifact["kind"]; text: string }>,
  options: { tamper?: boolean } = {},
) {
  const asked: string[] = [];
  const bytes = new Map(
    Object.entries(files).map(([tool, file]) => [
      `runs/${tool}`,
      Buffer.from(file.text),
    ]),
  );
  return {
    asked,
    source: {
      runs: {
        latestSucceeded: async (
          owner: string,
          snapshotId: string,
          tool: string,
        ) => {
          asked.push(`${owner}/${snapshotId}/${tool}`);
          return tool in files
            ? ({ id: `arn_${tool}` } as StoredAnalysisRun)
            : null;
        },
      },
      artifacts: {
        list: async (_owner: string, runId: string) =>
          Object.entries(files).flatMap(([tool, file]) =>
            runId === `arn_${tool}`
              ? [
                  {
                    kind: file.kind,
                    objectKey: `runs/${tool}`,
                    sha256: sha(Buffer.from(file.text)),
                  } as StoredArtifact,
                ]
              : [],
          ),
      },
      objects: {
        get: async (key: string) =>
          options.tamper === true ? Buffer.from("tampered") : bytes.get(key),
      },
    },
  };
}

test("a snapshot's brief is its newest brief run's document, checked against its hash", async () => {
  const found = source({ brief: { kind: "brief_md", text: "8 files." } });
  assert.equal(await readBrief(found.source, "org_1", "rsn_1"), "8 files.");
  assert.deepEqual(found.asked, ["org_1/rsn_1/brief"]);
  assert.equal(await readBrief(source({}).source, "org_1", "rsn_1"), null);
  assert.equal(
    await readBrief(
      source({ brief: { kind: "brief_md", text: "x" } }, { tamper: true })
        .source,
      "org_1",
      "rsn_1",
    ),
    null,
  );
  // A run with no brief among what it wrote has none.
  assert.equal(
    await readBrief(
      source({ brief: { kind: "other", text: "x" } }).source,
      "org_1",
      "rsn_1",
    ),
    null,
  );
});

test("a snapshot's documents are read back only when they read as a set", async () => {
  const set = {
    schemaVersion: 1,
    toolVersion: "documents@1",
    sourceSnapshotId: "rsn_1",
    sourceCommitSha: "a".repeat(40),
    documents: [{ path: "README.md", bytes: 3, text: "Hi", truncated: false }],
    omitted: 0,
  };
  assert.deepEqual(
    await readDocumentSet(
      source({ documents: { kind: "documents", text: JSON.stringify(set) } })
        .source,
      "org_1",
      "rsn_1",
    ),
    set,
  );
  for (const text of ["not json", JSON.stringify({ documents: "no" })])
    assert.equal(
      await readDocumentSet(
        source({ documents: { kind: "documents", text } }).source,
        "org_1",
        "rsn_1",
      ),
      null,
    );
  assert.equal(
    await readDocumentSet(source({}).source, "org_1", "rsn_1"),
    null,
  );
});
