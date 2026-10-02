import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubAnalysisClient } from "../src/index.js";
const stamp = "2026-10-01T00:00:00.000Z";
const run = {
  id: "arn_1",
  snapshotId: "rsn_1",
  repoId: "ghr_1",
  tool: "graphify",
  toolVersion: "test",
  params: { deadlineMinutes: 30 },
  status: "queued",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  startedAt: null,
  finishedAt: null,
  deadlineAt: null,
  createdAt: stamp,
};
const snapshot = {
  id: "rsn_1",
  repoId: "ghr_1",
  commitSha: "a".repeat(40),
  ref: "refs/heads/main",
  treeSha: "b".repeat(40),
  treeTruncated: false,
  fileCount: 1,
  totalBytes: 1,
  languages: {},
  createdAt: stamp,
};
test("typed analysis client parses every response and encodes scoped identifiers", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const facts = {
    version: 1,
    fileCount: 1,
    totalBytes: 1,
    truncated: false,
    testFiles: 0,
    modules: [],
    extensions: {},
    lockfiles: [],
    migrationDirectories: [],
    infraDirectories: [],
  };
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    let body: unknown = { run };
    if (url.endsWith("/snapshots")) body = { snapshots: [snapshot] };
    else if (url.includes("/snapshots/"))
      body = { snapshot: { ...snapshot, repoFullName: "acme/widgets", facts } };
    else if (url.endsWith("/artifacts")) body = { artifacts: [] };
    else if (url.endsWith("/url"))
      body = { url: "https://objects.test/signed" };
    else if (url.endsWith("/runs") && init?.method !== "POST")
      body = { runs: [run] };
    return new Response(JSON.stringify(body));
  }) as typeof globalThis.fetch;
  const client = new GithubAnalysisClient({ baseUrl: "", fetch });
  assert.equal((await client.snapshots("org/a", "repo/b"))[0]?.id, "rsn_1");
  assert.match(calls[0]!.url, /org%2Fa.*repo%2Fb/);
  assert.equal(
    (await client.snapshot("org/a", "rsn_1")).repoFullName,
    "acme/widgets",
  );
  assert.equal((await client.runs("org/a", "repo/b"))[0]?.id, "arn_1");
  assert.equal((await client.run("org/a", "arn_1")).id, "arn_1");
  assert.equal(
    (await client.enqueue("org/a", "repo/b", { tool: "graphify" })).id,
    "arn_1",
  );
  assert.equal(calls.at(-1)?.init?.method, "POST");
  assert.deepEqual(await client.artifacts("org/a", "arn_1"), []);
  assert.equal(
    await client.artifactUrl("org/a", "art_1"),
    "https://objects.test/signed",
  );
  assert.equal(
    await client.logUrl("org/a", "arn_1"),
    "https://objects.test/signed",
  );
});
