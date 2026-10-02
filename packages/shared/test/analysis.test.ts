import assert from "node:assert/strict";
import { test } from "node:test";
import { enqueueAnalysisSchema, artifactDtoSchema } from "../src/analysis.js";

test("analysis defaults are canonical and tool parameters are bounded", () => {
  assert.deepEqual(enqueueAnalysisSchema.parse({ tool: "graphify" }), {
    tool: "graphify",
    params: { deadlineMinutes: 30 },
  });
  for (const body of [
    { tool: "other" },
    { tool: "graphify", params: { deadlineMinutes: 121 } },
    { tool: "graphify", params: { includeInferred: true } },
    { tool: "graphify", organizationId: "foreign" },
  ])
    assert.equal(enqueueAnalysisSchema.safeParse(body).success, false);
});
test("artifact wire schema rejects private object keys", () => {
  const value = {
    id: "a",
    runId: "r",
    kind: "graph_json",
    path: "graph.json",
    contentType: "application/json",
    sizeBytes: 1,
    sha256: "a".repeat(64),
    meta: null,
    createdAt: "2026-10-02T00:00:00Z",
  };
  assert.equal(artifactDtoSchema.safeParse(value).success, true);
  assert.equal(
    artifactDtoSchema.safeParse({ ...value, objectKey: "private/key" }).success,
    false,
  );
});
