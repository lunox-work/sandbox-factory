import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { repositoryToken } from "../src/credentials.js";
import { executeRun } from "../src/run.js";
import { workerLoop } from "../src/loop.js";
import { parseWorkerEnv } from "../src/env.js";
import { uploadArtifacts } from "../src/upload.js";
import { AnalysisError } from "../src/errors.js";
import { run, stores } from "./helpers.js";
import type { StoredArtifact } from "@sandbox-factory/db";
import type { ToolAdapter, ArtifactFile } from "../src/tools/adapter.js";
const source = { maxBytes: 5000, maxFiles: 5, token: async () => "token" };
const tool: ToolAdapter = {
  name: "graphify",
  version: "test",
  run: async (input) => {
    input.log("AST complete");
    const path = join(input.sourceDir, "graph.json");
    await writeFile(path, "{}");
    return [
      {
        path: "graph.json",
        absolutePath: path,
        kind: "graph_json",
        contentType: "application/json",
        meta: null,
      },
    ];
  },
};
const fetchSource = async (_run: typeof run, directory: string) => directory;
test("success uploads attempt-scoped artifacts, commits, and removes source", async () => {
  const state = stores();
  let directory = "";
  await executeRun(run, {
    ...state,
    tool,
    source,
    fetchSource: async (r, d) => {
      directory = d;
      return fetchSource(r, d);
    },
  });
  assert.deepEqual(state.calls, ["finish"]);
  assert.equal(state.bytes.size, 2);
  assert.ok(state.bytes.has("runs/arn_1/lease_1/graph.json"));
  await assert.rejects(stat(directory));
});
test("a starter run reads no source, and a run that needs source has to have it", async () => {
  const state = stores();
  let fetched = false;
  let seen: unknown = undefined;
  await executeRun(
    {
      ...run,
      tool: "sandbox_starter",
      snapshotId: null,
      repoId: null,
      commitSha: null,
      repoFullName: null,
      externalRepoId: null,
      installationId: null,
    },
    {
      ...state,
      tool: {
        ...tool,
        name: "sandbox_starter",
        run: async (input) => {
          seen = input.run;
          return tool.run(input);
        },
      },
      source,
      fetchSource: async (r, d) => {
        fetched = true;
        return fetchSource(r, d);
      },
    },
  );
  assert.equal(fetched, false);
  assert.equal(seen, null);
  assert.deepEqual(state.calls, ["finish"]);
  // A graph run whose snapshot is gone fails before any fetch.
  const missing = stores();
  await executeRun(
    { ...run, snapshotId: null },
    {
      ...missing,
      tool,
      source,
      fetchSource: async (r, d) => {
        fetched = true;
        return fetchSource(r, d);
      },
    },
  );
  assert.equal(fetched, false);
  assert.deepEqual(missing.calls, ["source_unavailable"]);
});
test("a run for another tool or version never executes", async () => {
  for (const claimed of [
    { ...run, tool: "slice" as const },
    { ...run, toolVersion: "other" },
  ]) {
    const state = stores();
    await executeRun(claimed, { ...state, tool, source, fetchSource });
    assert.deepEqual(state.calls, ["tool_failed"]);
  }
});
test("tools read earlier runs through owner-scoped inputs", async () => {
  const state = stores();
  const seen: string[] = [];
  state.runs.get = async (owner, id) => {
    seen.push(`run ${owner} ${id}`);
    return { ...run, id, status: "succeeded" };
  };
  await state.objects.put("runs/other/graph.json", Buffer.from("{}"));
  const reading: ToolAdapter = {
    ...tool,
    run: async (input) => {
      assert.equal((await input.inputs.getRun("arn_graph"))?.id, "arn_graph");
      assert.deepEqual(await input.inputs.listArtifacts("arn_graph"), []);
      // Object keys are global; one no owner-scoped listing returned is not read.
      assert.equal(
        await input.inputs.readArtifact("runs/other/graph.json"),
        undefined,
      );
      assert.deepEqual(input.run, {
        snapshotId: run.snapshotId,
        commitSha: run.commitSha,
      });
      return tool.run(input);
    },
  };
  await executeRun(run, { ...state, tool: reading, source, fetchSource });
  assert.deepEqual(seen, ["run org_1 arn_graph"]);
  assert.deepEqual(state.calls, ["finish"]);
  const listed: string[] = [];
  await executeRun(run, {
    ...state,
    tool: {
      ...tool,
      run: async (input) => {
        await input.inputs.listArtifacts("arn_graph");
        assert.equal(
          Buffer.from(
            (await input.inputs.readArtifact("runs/other/graph.json")) ?? [],
          ).toString(),
          "{}",
        );
        return tool.run(input);
      },
    },
    artifacts: {
      list: async (owner, id) => {
        listed.push(`${owner} ${id}`);
        return [
          { objectKey: "runs/other/graph.json" },
        ] as unknown as StoredArtifact[];
      },
    },
    source,
    fetchSource,
  });
  assert.deepEqual(listed, ["org_1 arn_graph"]);
});

test("a committed run hands its files to the tool; a failing hook does not undo the success", async () => {
  const recorded: string[] = [];
  const sandboxes = {
    getVersion: async (owner: string, id: string) => {
      recorded.push(`get ${owner} ${id}`);
      return null;
    },
    recordBuildOutput: async (
      owner: string,
      versionId: string,
      runId: string,
      output: { harnessSha256: string },
    ) => {
      recorded.push(
        `record ${owner} ${versionId} ${runId} ${output.harnessSha256}`,
      );
      return true;
    },
    recordStarterOutput: async (
      owner: string,
      versionId: string,
      runId: string,
      output: { starterSha256: string },
    ) => {
      recorded.push(
        `starter ${owner} ${versionId} ${runId} ${output.starterSha256}`,
      );
      return true;
    },
  };
  const hooked = (fail: boolean): ToolAdapter => ({
    ...tool,
    run: async (input) => {
      assert.equal(await input.inputs.getVersion("sbv_1"), null);
      return tool.run(input);
    },
    committed: async ({ runId, files, inputs }) => {
      recorded.push(`committed ${runId} ${files.map((f) => f.path).join()}`);
      await inputs.recordBuildOutput("sbv_1", runId, {
        harnessSha256: "h",
        toolchainDigest: "d",
      });
      await inputs.recordStarterOutput("sbv_1", runId, {
        starterSha256: "s",
        aliasRules: [],
        acceptanceTests: [],
        scope: {
          editablePaths: [],
          generatedPaths: [],
          permittedOperations: ["edit"],
          dependencies: [],
          blockers: [],
        },
        transformConfigSha256: "t",
        build: null,
      });
      if (fail) throw new Error("database went away");
    },
  });
  const state = stores();
  await executeRun(run, {
    ...state,
    sandboxes,
    tool: hooked(false),
    source,
    fetchSource,
  });
  assert.deepEqual(recorded, [
    "get org_1 sbv_1",
    "committed arn_1 graph.json",
    "record org_1 sbv_1 arn_1 h",
    "starter org_1 sbv_1 arn_1 s",
  ]);
  const failing = stores();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    await executeRun(run, {
      ...failing,
      sandboxes,
      tool: hooked(true),
      source,
      fetchSource,
    });
  } finally {
    console.error = original;
  }
  assert.deepEqual(failing.calls, ["finish"]);
  assert.equal(errors.length, 1);
  assert.ok(failing.bytes.has("runs/arn_1/lease_1/graph.json"));
  // A lost commit never reaches the hook.
  const lost = stores();
  lost.runs.finish = async () => false;
  recorded.length = 0;
  await executeRun(run, {
    ...lost,
    sandboxes,
    tool: hooked(false),
    source,
    fetchSource,
  });
  assert.deepEqual(recorded, ["get org_1 sbv_1"]);
  // Without a sandbox store the inputs answer nothing rather than throw.
  await executeRun(run, {
    ...stores(),
    tool: {
      ...tool,
      run: async (input) => {
        assert.equal(await input.inputs.getVersion("sbv_1"), null);
        assert.equal(
          await input.inputs.recordBuildOutput("sbv_1", "arn_1", {
            harnessSha256: "h",
            toolchainDigest: "d",
          }),
          false,
        );
        assert.equal(
          await input.inputs.recordStarterOutput("sbv_1", "arn_1", {
            starterSha256: "s",
            aliasRules: [],
            acceptanceTests: [],
            scope: {
              editablePaths: [],
              generatedPaths: [],
              permittedOperations: ["edit"],
              dependencies: [],
              blockers: [],
            },
            transformConfigSha256: "t",
            build: null,
          }),
          false,
        );
        return tool.run(input);
      },
    },
    source,
    fetchSource,
  });
});
test("known losing attempts clean artifacts and logs", async () => {
  const state = stores();
  state.runs.finish = async () => false;
  await executeRun(run, { ...state, tool, source, fetchSource });
  assert.equal(state.bytes.size, 0);
});
test("failed sources, tool errors and upload errors are classified without sensitive details", async () => {
  for (const stage of ["source", "tool", "upload"] as const) {
    const state = stores();
    const failing = async () => {
      throw new Error("sensitive source path");
    };
    if (stage === "upload")
      state.objects.put = async () => {
        throw new Error("S3 down");
      };
    await executeRun(run, {
      ...state,
      source,
      fetchSource: stage === "source" ? failing : fetchSource,
      tool: stage === "tool" ? { ...tool, run: failing } : tool,
    });
    assert.deepEqual(state.calls, [
      stage === "source"
        ? "source_unavailable"
        : stage === "tool"
          ? "tool_failed"
          : "upload_failed",
    ]);
    for (const bytes of state.bytes.values())
      assert.doesNotMatch(Buffer.from(bytes).toString(), /sensitive/);
  }
});
test("shutdown releases the lease; deadline and lost heartbeat stop a running parser", async () => {
  for (const mode of [
    "shutdown",
    "deadline",
    "lost",
    "heartbeat_error",
  ] as const) {
    const state = stores();
    const abort = new AbortController();
    if (mode === "shutdown") abort.abort();
    if (mode === "lost") state.runs.heartbeat = async () => false;
    if (mode === "heartbeat_error")
      state.runs.heartbeat = async () => {
        throw new Error("offline");
      };
    const waiting: ToolAdapter = {
      ...tool,
      run: async ({ signal }) => {
        await delay(1000, undefined, { signal });
        return [];
      },
    };
    await executeRun(
      {
        ...run,
        deadlineAt:
          mode === "deadline"
            ? new Date(Date.now() - 1).toISOString()
            : run.deadlineAt,
      },
      {
        ...state,
        tool: waiting,
        source,
        fetchSource,
        shutdown: abort.signal,
        heartbeatMs: 5,
      },
    );
    assert.deepEqual(state.calls, [
      mode === "shutdown"
        ? "release"
        : mode === "deadline"
          ? "tool_timeout"
          : "worker_lost",
    ]);
  }
});
test("ambiguous commit preserves winning bytes and never overwrites its success log", async () => {
  for (const unknown of [false, true]) {
    const state = stores();
    state.runs.finish = async () => {
      throw new Error("connection lost after commit");
    };
    state.runs.get = async () => {
      if (unknown) throw new Error("DB offline");
      return { ...run, status: "succeeded" };
    };
    await executeRun(run, { ...state, tool, source, fetchSource });
    assert.equal(state.bytes.size, 2);
    assert.equal(state.calls.length, 0);
    assert.doesNotMatch(
      Buffer.from(state.bytes.get("logs/arn_1/lease_1.log")!).toString(),
      /stopped/,
    );
  }
});
test("rejected ambiguous commits fail and remove uploaded artifacts", async () => {
  const state = stores();
  state.runs.finish = async () => {
    throw new Error("commit failed");
  };
  await executeRun(run, { ...state, tool, source, fetchSource });
  assert.deepEqual(state.calls, ["tool_failed"]);
  assert.equal(state.bytes.size, 1);
});
test("stream uploads compute hashes and stop invalid paths or cancelled work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-upload-"));
  const path = join(directory, "file");
  await writeFile(path, "hello");
  const file: ArtifactFile = {
    path: "wiki/page.md",
    absolutePath: path,
    kind: "wiki_page",
    contentType: "text/plain",
    meta: null,
  };
  const state = stores();
  let streamed = "";
  state.objects.putStream = async (_key, body, size) => {
    assert.equal(size, 5);
    for await (const chunk of body) streamed += String(chunk);
  };
  try {
    const result = await uploadArtifacts(
      state.objects,
      "run",
      "lease",
      [file],
      new AbortController().signal,
      [],
    );
    assert.equal(streamed, "hello");
    assert.equal(
      result[0]?.sha256,
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    for (const invalid of ["/secret", "../secret", "wiki//secret"])
      await assert.rejects(
        uploadArtifacts(
          state.objects,
          "r",
          "l",
          [{ ...file, path: invalid }],
          new AbortController().signal,
          [],
        ),
        AnalysisError,
      );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      uploadArtifacts(state.objects, "r", "l", [file], abort.signal, []),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("uploads keep the measured file when its path is replaced mid-upload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-replace-"));
  const path = join(directory, "file");
  await writeFile(path, "hello");
  const file: ArtifactFile = {
    path: "graph.json",
    absolutePath: path,
    kind: "graph_json",
    contentType: "application/json",
    meta: null,
  };
  try {
    const streamedState = stores();
    let streamed = "";
    streamedState.objects.putStream = async (_key, body, size) => {
      // Synchronous, so the swap lands before any lazily opened stream opens.
      writeFileSync(`${path}.next`, "replaced and longer");
      renameSync(`${path}.next`, path);
      assert.equal(size, 5);
      for await (const chunk of body) streamed += String(chunk);
    };
    const [streamedArtifact] = await uploadArtifacts(
      streamedState.objects,
      "run",
      "lease",
      [file],
      new AbortController().signal,
      [],
    );
    assert.equal(streamed, "hello");
    assert.equal(streamedArtifact?.sizeBytes, 5);

    // Without streaming, the body is read through the same handle, and an
    // empty file uploads as zero bytes.
    await writeFile(path, "");
    const bufferedState = stores();
    const [empty] = await uploadArtifacts(
      bufferedState.objects,
      "run",
      "lease",
      [file],
      new AbortController().signal,
      [],
    );
    assert.equal(
      bufferedState.bytes.get("runs/run/lease/graph.json")?.byteLength,
      0,
    );
    assert.equal(
      empty?.sha256,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("once drains the queue, poll waits, and stop prevents further claims", async () => {
  let claims = 0,
    executions = 0;
  const abort = new AbortController();
  await workerLoop({
    runs: { claimNext: async () => (++claims === 1 ? run : null) },
    mode: "once",
    signal: abort.signal,
    execute: async () => {
      executions++;
    },
  });
  assert.equal(claims, 2);
  assert.equal(executions, 1);
  await workerLoop({
    runs: { claimNext: async () => null },
    mode: "poll",
    signal: abort.signal,
    execute: async () => {},
    wait: async () => {
      abort.abort();
      throw new Error("stopped");
    },
  });
  await assert.rejects(
    workerLoop({
      runs: { claimNext: async () => null },
      mode: "poll",
      signal: new AbortController().signal,
      execute: async () => {},
      wait: async () => {
        throw new Error("offline");
      },
    }),
    /offline/,
  );
});
test("worker validates credentials, modes, and bounded limits", () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const env = {
    DATABASE_URL: "postgres://local",
    S3_BUCKET: "private",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  assert.equal(parseWorkerEnv(env).WORKER_MODE, "once");
  assert.equal(
    parseWorkerEnv({
      ...env,
      WORKER_MODE: "poll",
      MAX_FILES: "5",
      S3_ENDPOINT: "",
    }).MAX_FILES,
    5,
  );
  assert.throws(() => parseWorkerEnv({ ...env, S3_ACCESS_KEY_ID: "lone" }));
  assert.throws(() => parseWorkerEnv({ ...env, MAX_FILES: "0" }));
  assert.throws(() => parseWorkerEnv({ ...env, WORKER_MODE: "forever" }));
  // Builds run in-process only on a worker that opts in.
  assert.equal(parseWorkerEnv(env).EVALUATION_PROVIDER, "none");
  assert.equal(
    parseWorkerEnv({ ...env, EVALUATION_PROVIDER: "local-process" })
      .EVALUATION_PROVIDER,
    "local-process",
  );
  assert.equal(
    parseWorkerEnv({ ...env, EVALUATION_PROVIDER: "" }).EVALUATION_PROVIDER,
    "none",
  );
  assert.throws(() => parseWorkerEnv({ ...env, EVALUATION_PROVIDER: "e2b" }));
  // Context builders: the optional DeepWiki-Open service.
  const builders = parseWorkerEnv({
    ...env,
    DEEPWIKI_OPEN_URL: "",
    DEEPWIKI_OPEN_AUTH_CODE: "REPLACE_ME",
    DEEPWIKI_OPEN_PROVIDER: "",
    DEEPWIKI_OPEN_MODEL: "",
  });
  assert.equal(builders.DEEPWIKI_OPEN_URL, undefined);
  assert.equal(builders.DEEPWIKI_OPEN_AUTH_CODE, undefined);
  assert.equal(builders.DEEPWIKI_OPEN_PROVIDER, undefined);
  assert.equal(builders.DEEPWIKI_OPEN_MODEL, undefined);
  const configured = parseWorkerEnv({
    ...env,
    DEEPWIKI_OPEN_URL: "http://deepwiki:8001",
    DEEPWIKI_OPEN_AUTH_CODE: "code",
    DEEPWIKI_OPEN_PROVIDER: "openai",
    DEEPWIKI_OPEN_MODEL: "gpt-4o",
  });
  assert.equal(configured.DEEPWIKI_OPEN_URL, "http://deepwiki:8001");
  assert.equal(configured.DEEPWIKI_OPEN_AUTH_CODE, "code");
  assert.equal(configured.DEEPWIKI_OPEN_PROVIDER, "openai");
  assert.equal(configured.DEEPWIKI_OPEN_MODEL, "gpt-4o");
  assert.throws(() =>
    parseWorkerEnv({ ...env, DEEPWIKI_OPEN_URL: "not a url" }),
  );
});

test("source tokens use repository-scoped read permissions", async () => {
  const tokens = {
    provider: (installation: string, scope: unknown) => {
      assert.equal(installation, "9");
      assert.deepEqual(scope, {
        repositoryIds: [1],
        permissions: { contents: "read", metadata: "read" },
      });
      return async () => "read-token";
    },
  };
  assert.equal(await repositoryToken(tokens, run)(), "read-token");
  for (const externalRepoId of ["0", "bad", "9007199254740992"])
    await assert.rejects(
      repositoryToken(tokens, { ...run, externalRepoId })(),
      AnalysisError,
    );
});

test("an uncertain finish never keeps an older attempt beside a winning successor", async () => {
  const state = stores();
  state.runs.finish = async () => {
    throw new Error("lost lease during commit");
  };
  state.runs.get = async () => ({ ...run, status: "succeeded" });
  state.runs.logKey = async () => "logs/arn_1/next-lease.log";
  await executeRun(run, { ...state, tool, source, fetchSource });
  assert.equal(state.bytes.has("runs/arn_1/lease_1/graph.json"), false);
});
