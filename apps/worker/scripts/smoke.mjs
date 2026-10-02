import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGraphifyAdapter } from "../dist/tools/graphify.js";
import { executeRun } from "../dist/run.js";
import { fetchSource } from "../dist/fetch-source.js";
import { command } from "../dist/command.js";
const directory = await mkdtemp(join(tmpdir(), "worker-smoke-"));
const fixture = fileURLToPath(
  new URL("../fixtures/repository/", import.meta.url),
);
const python = process.env.SMOKE_PYTHON || "python3";
try {
  const graphs = [];
  const adapter = createGraphifyAdapter({ python });
  for (const name of ["checkout-a", "checkout-b"]) {
    const source = join(directory, name);
    await cp(fixture, source, { recursive: true });
    const files = await adapter.run({
      sourceDir: source,
      outDir: join(directory, `${name}-out`),
      params: { deadlineMinutes: 30 },
      signal: new AbortController().signal,
      log: () => {},
    });
    assert.ok(files.some((f) => f.path === "wiki/index.md"));
    const bytes = await readFile(
      join(directory, `${name}-out/graph.json`),
      "utf8",
    );
    graphs.push(bytes);
    const graph = JSON.parse(bytes);
    assert.equal(graph.directed, true);
    assert.equal(graph.multigraph, true);
    assert.ok(
      graph.nodes.some(
        (n) =>
          n.id.startsWith("symbol:packages/a/index.ts:") &&
          n.label.includes("shared"),
      ),
    );
    assert.ok(
      graph.nodes.some(
        (n) =>
          n.id.startsWith("symbol:packages/b/index.ts:") &&
          n.label.includes("shared"),
      ),
    );
    for (const specifier of ["./util.js", "./folder", "@/util"])
      assert.ok(
        graph.links.some((e) => e.specifier === specifier && e.resolved),
      );
    assert.ok(
      graph.unresolvedDependencies.some(
        (d) => d.specifier === "missing-package",
      ),
    );
    assert.ok(graph.unresolvedDependencies.some((d) => d.reason === "dynamic"));
    assert.ok(!graph.nodes.some((n) => n.source_file.includes("ignored.ts")));
    assert.doesNotMatch(bytes, /checkout-a|checkout-b/);
  }
  assert.equal(
    graphs[0],
    graphs[1],
    "canonical facts must be independent of checkout paths",
  );
  // Exercise the real archive -> Graphify -> streaming upload -> finish lifecycle.
  const archive = join(directory, "fixture.tar.gz");
  await command(
    python,
    [
      "-c",
      "import tarfile,sys; t=tarfile.open(sys.argv[1], 'w:gz'); t.add(sys.argv[2], arcname='checkout-a'); t.close()",
      archive,
      join(directory, "checkout-a"),
    ],
    { signal: new AbortController().signal },
  );
  const archiveBytes = await readFile(archive);
  let fetches = 0;
  const fetch = async (_url, init) => {
    fetches++;
    if (fetches === 1) {
      assert.ok(init.headers.Authorization);
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://codeload.github.com/acme/fixture/tar.gz/sha",
        },
      });
    }
    assert.equal(init.headers, undefined);
    return new Response(archiveBytes);
  };
  const bytes = new Map();
  let finished = false;
  let failure = "";
  const runs = {
    heartbeat: async () => true,
    finish: async (_owner, _id, _token, artifacts) => {
      assert.ok(artifacts.length >= 5);
      assert.ok(artifacts.every((a) => bytes.has(a.objectKey)));
      finished = true;
      return true;
    },
    fail: async (_owner, _id, _token, code) => {
      failure = code;
      return true;
    },
    release: async () => false,
  };
  const objects = {
    put: async (k, b) => bytes.set(k, b),
    putStream: async (k, stream) => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      bytes.set(k, Buffer.concat(chunks));
    },
    remove: async (k) => bytes.delete(k),
  };
  const stamp = new Date().toISOString();
  await executeRun(
    {
      id: "arn_fixture",
      organizationId: "org_fixture",
      leaseToken: "lease_fixture",
      snapshotId: "rsn_fixture",
      repoId: "ghr_fixture",
      tool: "graphify",
      toolVersion: adapter.version,
      params: { deadlineMinutes: 30 },
      status: "running",
      attempt: 0,
      maxAttempts: 2,
      errorCode: null,
      errorDetail: null,
      startedAt: stamp,
      finishedAt: null,
      createdAt: stamp,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      commitSha: "a".repeat(40),
      repoFullName: "acme/fixture",
      externalRepoId: "1",
      installationId: "1",
      sizeKb: null,
    },
    {
      runs,
      objects,
      tool: adapter,
      source: {
        token: async () => "fixture-token",
        maxBytes: 200_000,
        maxFiles: 100,
        fetch,
        python,
      },
      fetchSource,
    },
  );
  assert.equal(
    finished,
    true,
    `Smoke run failed: ${failure}; ${Buffer.from(bytes.get("logs/arn_fixture/lease_fixture.log") ?? []).toString()}`,
  );
  assert.equal(fetches, 2);
  await command(
    python,
    [
      "-m",
      "unittest",
      "discover",
      "-s",
      fileURLToPath(new URL("../python", import.meta.url)),
      "-p",
      "test_*.py",
    ],
    { signal: new AbortController().signal },
  );
  console.log(
    "Worker smoke passed: deterministic graph, import resolution, omissions, archive validation, and artifact lifecycle.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
