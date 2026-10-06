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
    if (url.includes("/tree"))
      body = {
        entries: [
          {
            path: "src/main.ts",
            type: "blob",
            mode: "100644",
            sha: "c",
            size: 1,
          },
        ],
        nextCursor: url.includes("cursor=") ? null : "src/main.ts",
        truncated: false,
      };
    else if (url.endsWith("/snapshots") && init?.method === "POST")
      body = { commitSha: "a".repeat(40), snapshot: null };
    else if (url.endsWith("/snapshots")) body = { snapshots: [snapshot] };
    else if (url.endsWith("/branches"))
      body = {
        branches: [{ name: "main", headSha: "a".repeat(40), isDefault: true }],
        truncated: false,
      };
    else if (url.includes("/snapshots/"))
      body = { snapshot: { ...snapshot, repoFullName: "acme/widgets", facts } };
    else if (url.endsWith("/artifacts")) body = { artifacts: [] };
    else if (url.endsWith("/url"))
      body = { url: "https://objects.test/signed" };
    else if (url.endsWith("/log/content"))
      body = { sizeBytes: 4, text: "done", omitted: null };
    else if (url.endsWith("/content"))
      body = { path: "a.md", sizeBytes: 2, text: "# A", omitted: null };
    else if (url.endsWith("/runs") && init?.method !== "POST")
      body = { runs: [run] };
    else if (url.endsWith("/slices"))
      body = {
        run: {
          ...run,
          id: "arn_slice",
          tool: "slice",
          params: {
            deadlineMinutes: 30,
            graphRunId: "arn_1",
            entryPoints: ["src/main.ts"],
            budget: { maxFiles: 40, maxDepth: 3 },
            includeInferred: false,
          },
        },
        graphRun: run,
      };
    return new Response(JSON.stringify(body));
  }) as typeof globalThis.fetch;
  const client = new GithubAnalysisClient({ baseUrl: "", fetch });
  assert.equal((await client.snapshots("org/a", "repo/b"))[0]?.id, "rsn_1");
  assert.match(calls[0]!.url, /org%2Fa.*repo%2Fb/);
  assert.equal(
    (await client.branches("org/a", "repo/b")).branches[0]?.name,
    "main",
  );
  assert.match(calls.at(-1)!.url, /repo%2Fb\/branches$/);
  assert.deepEqual(await client.pullSnapshot("org/a", "repo/b", "feature/x"), {
    commitSha: "a".repeat(40),
    snapshot: null,
  });
  assert.equal(calls.at(-1)?.init?.method, "POST");
  assert.equal(
    calls.at(-1)?.init?.body,
    JSON.stringify({ branch: "feature/x" }),
  );
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
  assert.equal((await client.artifactContent("org/a", "art/1")).text, "# A");
  assert.match(
    calls.at(-1)!.url,
    /org%2Fa\/github\/artifacts\/art%2F1\/content$/,
  );
  assert.equal((await client.logContent("org/a", "arn/1")).text, "done");
  assert.match(calls.at(-1)!.url, /\/runs\/arn%2F1\/log\/content$/);
  assert.equal(
    await client.logUrl("org/a", "arn_1"),
    "https://objects.test/signed",
  );
  const slice = await client.enqueueSlice("org/a", "repo/b", {
    entryPoints: ["src/main.ts"],
  });
  assert.equal(slice.run.tool, "slice");
  assert.equal(slice.graphRun.id, "arn_1");
  assert.match(calls.at(-1)!.url, /repo%2Fb\/slices$/);
  assert.equal(calls.at(-1)?.init?.method, "POST");
  const page = await client.tree("org/a", "rsn_1", {
    prefix: "src",
    limit: 10,
  });
  assert.equal(page.entries[0]?.path, "src/main.ts");
  assert.equal(page.nextCursor, "src/main.ts");
  assert.match(calls.at(-1)!.url, /\/tree\?prefix=src&limit=10$/);
  const next = await client.tree("org/a", "rsn_1", {
    cursor: page.nextCursor ?? undefined,
  });
  assert.equal(next.nextCursor, null);
  assert.match(calls.at(-1)!.url, /\/tree\?cursor=src%2Fmain.ts$/);
  await client.tree("org/a", "rsn_1");
  assert.match(calls.at(-1)!.url, /\/tree$/);
});

test("agent runs are queued and a repository's proposals listed, with scoped identifiers encoded", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const task = { proposalId: "bpr_1", specRevision: 2, specHash: "h" };
  const scope = {
    ...run,
    id: "arn_scope",
    tool: "scope",
    params: {
      deadlineMinutes: 30,
      agent: "scope",
      graphRunId: "arn_1",
      ...task,
    },
  };
  const fixtures = {
    ...run,
    id: "arn_fixtures",
    tool: "fixtures",
    params: {
      deadlineMinutes: 30,
      agent: "fixtures",
      sliceRunId: "arn_slice",
      ...task,
    },
  };
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = url.endsWith("/scope")
      ? { run: scope, graphRun: run }
      : url.endsWith("/fixtures")
        ? { run: fixtures }
        : {
            proposals: [
              {
                id: "bpr_1",
                issueKey: "SHOP-1",
                title: "Coupons",
                status: "approved",
                specRevision: 2,
                boardId: "jbd_1",
                boardName: "Shop",
                createdAt: stamp,
              },
            ],
          };
    return new Response(JSON.stringify(body), {
      status: url.endsWith("/proposals") ? 200 : 202,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const client = new GithubAnalysisClient({
    baseUrl: "https://api.test",
    fetch,
  });
  const queued = await client.enqueueScope("org/a", "repo/b", {
    proposalId: "bpr_1",
  });
  assert.equal(queued.run.tool, "scope");
  assert.equal(queued.graphRun.id, "arn_1");
  assert.match(
    calls.at(-1)!.url,
    /org%2Fa\/github\/repositories\/repo%2Fb\/scope$/,
  );
  assert.equal(calls.at(-1)?.init?.method, "POST");
  assert.equal(
    calls.at(-1)?.init?.body,
    JSON.stringify({ proposalId: "bpr_1" }),
  );
  const written = await client.enqueueFixtures("org/a", "arn/slice", {
    proposalId: "bpr_1",
    specRevision: 2,
  });
  assert.equal(written.tool, "fixtures");
  assert.match(calls.at(-1)!.url, /\/runs\/arn%2Fslice\/fixtures$/);
  const proposals = await client.repositoryProposals("org/a", "repo/b");
  assert.equal(proposals[0]?.issueKey, "SHOP-1");
  assert.match(calls.at(-1)!.url, /\/repositories\/repo%2Fb\/proposals$/);
});
