import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAnalysisRunStore,
  createArtifactStore,
  createBountyProposalStore,
  createBountySpecStore,
  createConnection,
  createObjectStore,
  createSandboxStore,
  RUN_ENDED_CHANNEL,
  RUN_QUEUED_CHANNEL,
  workerApplicationName,
} from "@sandbox-factory/db";
import type { ClaimedAnalysisRun } from "@sandbox-factory/db";
import type { AnalysisTool } from "sandbox-factory";
import { InstallationTokens } from "@sandbox-factory/github";
import { repositoryToken } from "./credentials.js";
import { parseWorkerEnv } from "./env.js";
import { IDLE_POLL_MS, wakeableWait, workerLoop } from "./loop.js";
import { executeRun } from "./run.js";
import { createSourceCache } from "./source-cache.js";
import { createAnthropicModel } from "./agent/anthropic.js";
import type { AgentSettings } from "./agent/loop.js";
import { createLocalProcessProvider } from "./evaluation/local-process.js";
import { EVALUATION_JOBS_MAX, limitJobs } from "./evaluation/limit.js";
import { createTaskReader } from "./tasks.js";
import { createAbstractionsAdapter } from "./tools/abstractions.js";
import { createBriefAdapter } from "./tools/brief.js";
import type { ToolAdapter } from "./tools/adapter.js";
import { createDataModelAdapter } from "./tools/data-model.js";
import { createDocumentsAdapter } from "./tools/documents.js";
import { createFixturesAdapter } from "./tools/fixtures.js";
import { createGraphifyAdapter } from "./tools/graphify.js";
import { createSandboxBuildAdapter } from "./tools/sandbox-build.js";
import { createScopeAdapter } from "./tools/scope.js";
import { createSliceAdapter } from "./tools/slice.js";
import { createStarterAdapter } from "./tools/starter.js";

const env = parseWorkerEnv();
// Named, so the launcher sees this worker while it is idle and has no run
// to heartbeat, and tells it from the others it counts. Sized for every
// slot's run to heartbeat and write beside a claim and the listener.
const connection = createConnection({
  url: env.DATABASE_URL,
  max: 8,
  applicationName: workerApplicationName(randomUUID().slice(0, 8)),
});
const runs = createAnalysisRunStore(connection.db);
const artifacts = createArtifactStore(connection.db);
const sandboxes = createSandboxStore(connection.db);
const tasks = createTaskReader(
  createBountyProposalStore(connection.db),
  createBountySpecStore(connection.db),
);
// The model reads source only inside agent runs; without one they fail
// with `agent_unavailable` and every other tool works as before.
const agent: AgentSettings = {
  model:
    env.ANTHROPIC_API_KEY !== undefined && env.AGENT_MODEL !== undefined
      ? createAnthropicModel({
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.AGENT_MODEL,
        })
      : null,
  limits: { maxTurns: env.AGENT_MAX_TURNS, maxTokens: env.AGENT_TOKEN_BUDGET },
};
// Development provider: a fresh directory and scrubbed processes, not an
// isolation boundary, so only a worker that opts in runs builds with it. A
// hosted provider replaces it once qualified.
// Two jobs at once at most: the agent slots can hold three builds, each
// with a baseline to run.
const evaluation =
  env.EVALUATION_PROVIDER === "local-process"
    ? limitJobs(createLocalProcessProvider(), EVALUATION_JOBS_MAX)
    : null;
const objects = createObjectStore({
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});
// Every run of one commit reads the source this worker fetched for the
// first, for as long as the disk keeps it. Its root is this process's
// own, not a fixed name in the shared temp directory.
const sourceCache = await createSourceCache({
  root: await mkdtemp(join(tmpdir(), "sandbox-factory-sources-")),
});
const tokens = new InstallationTokens({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
});
/** The adapter for a claimed run's tool; every tool has exactly one. */
function adapterFor(run: ClaimedAnalysisRun): ToolAdapter {
  switch (run.tool) {
    case "graphify":
      return createGraphifyAdapter();
    case "abstractions":
      return createAbstractionsAdapter();
    case "data_model":
      return createDataModelAdapter();
    case "documents":
      return createDocumentsAdapter();
    case "brief":
      return createBriefAdapter();
    case "slice":
      return createSliceAdapter();
    case "sandbox_build":
      return createSandboxBuildAdapter({ agent, provider: evaluation });
    case "scope":
      return createScopeAdapter(agent);
    case "fixtures":
      return createFixturesAdapter(agent);
    case "sandbox_starter":
      return createStarterAdapter({ agent, provider: evaluation });
  }
}
/**
 * The builders a claimed run shares its claim with: those that read the
 * same checkout and wait on nothing it has not already waited on.
 * `documents` reads no graph, so it runs beside graphify's map too.
 */
const SHARED_CLAIM: Partial<Record<AnalysisTool, readonly AnalysisTool[]>> = {
  graphify: ["documents"],
  abstractions: ["data_model", "documents"],
  data_model: ["abstractions", "documents"],
  documents: ["abstractions", "data_model"],
};
const stopClaiming = new AbortController();
const stopCurrent = new AbortController();
let grace: ReturnType<typeof setTimeout> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopClaiming.abort();
    grace ??= setTimeout(() => stopCurrent.abort(), 60_000);
    grace.unref();
  });
// A polling worker claims the moment a run is queued, or a run another
// one waits on ends, rather than on its next poll.
const idle = wakeableWait(IDLE_POLL_MS, stopClaiming.signal);
if (env.WORKER_MODE === "poll")
  for (const channel of [RUN_QUEUED_CHANNEL, RUN_ENDED_CHANNEL])
    await connection
      .listen(channel, () => idle.wake())
      .catch(() => console.error("analysis_run_listen_failed"));
try {
  await workerLoop({
    runs,
    mode: env.WORKER_MODE,
    signal: stopClaiming.signal,
    wait: (cancel) => idle.wait(cancel),
    // A commit's lighter builders read the one checkout and wait on the
    // same graph, so they share a claim rather than queue behind each other.
    beside: (run) => {
      const tools = SHARED_CLAIM[run.tool];
      return run.snapshotId === null || tools === undefined
        ? null
        : { snapshotId: run.snapshotId, tools };
    },
    ...(env.WORKER_IDLE_EXIT_MINUTES === undefined
      ? {}
      : { idleExitMs: env.WORKER_IDLE_EXIT_MINUTES * 60_000 }),
    execute: async (run) => {
      await executeRun(run, {
        runs,
        artifacts,
        sandboxes,
        tasks,
        objects,
        tool: adapterFor(run),
        shutdown: stopCurrent.signal,
        sourceCache,
        source: {
          maxBytes: env.MAX_TARBALL_BYTES,
          maxFiles: env.MAX_FILES,
          token: repositoryToken(tokens, run),
        },
      });
    },
  });
} finally {
  clearTimeout(grace);
  await connection.close();
}
