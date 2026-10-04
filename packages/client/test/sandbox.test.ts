import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxClient } from "../src/index.js";
const stamp = "2026-10-02T00:00:00.000Z";
const sandbox = {
  id: "sbx_1",
  slug: "abc123def456",
  status: "draft",
  publicRepoId: null,
  currentVersionId: null,
  bountyId: "bty_1",
  sourceRepoId: "ghr_1",
  createdAt: stamp,
  updatedAt: stamp,
};
const version = {
  id: "sbv_1",
  sandboxId: "sbx_1",
  version: 1,
  title: "Fix it",
  specSummary: "Summary",
  complexity: "M",
  tags: [],
  testSummary: [],
  publicBaseCommitSha: null,
  readme: null,
  languages: null,
  frozenAt: null,
  createdAt: stamp,
};
const source = {
  sandboxVersionId: "sbv_1",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  sliceRunId: "arn_slice",
  manifestSha256: "1".repeat(64),
  contractSha256: "c".repeat(64),
  transformConfigSha256: "2".repeat(64),
  approvedTaskSha256: "a".repeat(64),
  aliasRules: [
    { before: "Acme", after: "Widget", kind: "identifier", paths: [] },
  ],
  dependencyChoices: {},
  acceptanceTests: [],
  fixtures: null,
  // A version frozen before bounties, read as it was written.
  approvedTask: {
    schemaVersion: 1,
    title: "Fix it",
    summary: "Summary",
    spec: null,
    pricing: null,
    selectedBy: "user_1",
    selectedAt: stamp,
    jiraIssueIds: [],
  },
  scope: {
    editablePaths: ["src/app.ts"],
    generatedPaths: [],
    permittedOperations: ["edit"],
    dependencies: [],
    blockers: [],
  },
  harnessSha256: null,
  toolchainDigest: null,
  buildRunId: null,
  roundTripRunId: null,
  disclosureRunId: null,
  approvedBy: null,
  approvedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
};
const run = {
  id: "arn_build",
  snapshotId: "rsn_1",
  repoId: "ghr_1",
  tool: "sandbox_build",
  toolVersion: "sandbox_build@1",
  params: {
    deadlineMinutes: 30,
    sliceRunId: "arn_slice",
    sandboxVersionId: "sbv_1",
    manifestSha256: "1".repeat(64),
    contractSha256: "c".repeat(64),
    transformConfigSha256: "2".repeat(64),
    approvedTaskSha256: "a".repeat(64),
  },
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
test("the sandbox client parses every response and scopes every path to the owner", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    let body: unknown;
    if (url.endsWith("/sandboxes") && init?.method !== "POST")
      body = { sandboxes: [sandbox] };
    // Made without a repository, which it links after.
    else if (url.endsWith("/sandboxes"))
      body = { sandbox: { ...sandbox, sourceRepoId: null } };
    else if (url.endsWith("/source")) body = { sandbox };
    else if (url.endsWith("/sandboxes/sbx%201")) body = { sandbox };
    else if (url.endsWith("/versions") && init?.method !== "POST")
      body = { versions: [version] };
    else if (url.endsWith("/versions")) body = { version, source };
    else if (url.endsWith("/build")) body = { run };
    else if (url.endsWith("/replay"))
      body = { ok: false, reason: "source_unavailable", detail: "gone" };
    else if (init?.method === "PATCH") body = { version };
    else body = { version, source };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const client = new SandboxClient({
    baseUrl: "https://api.test/",
    fetch,
    getToken: () => "token",
  });
  assert.deepEqual(await client.sandboxes("org 1"), [sandbox]);
  assert.equal((await client.sandbox("org 1", "sbx 1")).id, "sbx_1");
  const bare = await client.createSandbox("org 1", { bountyId: "bty_1" });
  assert.deepEqual([bare.id, bare.sourceRepoId], ["sbx_1", null]);
  assert.equal(
    (
      await client.linkSandboxSource("org 1", "sbx 1", {
        sourceRepoId: "ghr_1",
      })
    ).sourceRepoId,
    "ghr_1",
  );
  assert.deepEqual(await client.sandboxVersions("org 1", "sbx_1"), [version]);
  const created = await client.createSandboxVersion("org 1", "sbx_1", {
    sliceRunId: "arn_slice",
    title: "Fix it",
    specSummary: "Summary",
    complexity: "M",
  });
  assert.equal(created.source?.sourceCommitSha, "a".repeat(40));
  const read = await client.sandboxVersion("org 1", "sbv_1");
  assert.deepEqual(read.source?.aliasRules, source.aliasRules);
  const patched = await client.updateSandboxVersion("org 1", "sbv_1", {
    title: "Renamed",
  });
  assert.equal(patched.source, undefined);
  assert.equal(
    (await client.buildSandboxVersion("org 1", "sbv_1")).tool,
    "sandbox_build",
  );
  const replay = await client.sandboxReplay("org 1", "sbv_1");
  assert.equal(replay.ok, false);
  assert.deepEqual(
    calls.map((call) => [call.init?.method ?? "GET", call.url]),
    [
      ["GET", "https://api.test/api/v1/orgs/org%201/sandboxes"],
      ["GET", "https://api.test/api/v1/orgs/org%201/sandboxes/sbx%201"],
      ["POST", "https://api.test/api/v1/orgs/org%201/sandboxes"],
      ["PUT", "https://api.test/api/v1/orgs/org%201/sandboxes/sbx%201/source"],
      ["GET", "https://api.test/api/v1/orgs/org%201/sandboxes/sbx_1/versions"],
      ["POST", "https://api.test/api/v1/orgs/org%201/sandboxes/sbx_1/versions"],
      ["GET", "https://api.test/api/v1/orgs/org%201/sandboxes/versions/sbv_1"],
      [
        "PATCH",
        "https://api.test/api/v1/orgs/org%201/sandboxes/versions/sbv_1",
      ],
      [
        "POST",
        "https://api.test/api/v1/orgs/org%201/sandboxes/versions/sbv_1/build",
      ],
      [
        "GET",
        "https://api.test/api/v1/orgs/org%201/sandboxes/versions/sbv_1/replay",
      ],
    ],
  );
  assert.equal(
    new Headers(calls[2]?.init?.headers).get("Authorization"),
    "Bearer token",
  );
  assert.equal(calls[2]?.init?.body, JSON.stringify({ bountyId: "bty_1" }));
  assert.equal(calls[3]?.init?.body, JSON.stringify({ sourceRepoId: "ghr_1" }));
});
