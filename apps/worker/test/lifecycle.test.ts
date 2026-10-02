import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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
