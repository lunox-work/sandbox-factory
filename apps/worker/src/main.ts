import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAnalysisRunStore,
  createArtifactStore,
  createBountyProposalStore,
  createBountySpecStore,
  createConnection,
  createModelUsageStore,
  createObjectStore,
  createSandboxStore,
  createSubmissionStore,
  RUN_ENDED_CHANNEL,
  RUN_QUEUED_CHANNEL,
  workerApplicationName,
} from "@sandbox-factory/db";
import type { ClaimedAnalysisRun } from "@sandbox-factory/db";
import { SHARED_CLAIM } from "sandbox-factory";
import { InstallationTokens } from "@sandbox-factory/github";
import { repositoryToken } from "./credentials.js";
import { parseWorkerEnv } from "./env.js";
import { IDLE_POLL_MS, wakeableWait, workerLoop } from "./loop.js";
import { executeRun } from "./run.js";
import { createSourceCache } from "./source-cache.js";
import { createAnthropicModel } from "./agent/anthropic.js";
import type { AgentSettings } from "./agent/loop.js";
import { meteredAgent } from "./agent/metered.js";
import { createE2BProvider, e2bClient } from "./evaluation/e2b.js";
import { createLocalProcessProvider } from "./evaluation/local-process.js";
import { EVALUATION_JOBS_MAX, limitJobs } from "./evaluation/limit.js";
import { jobIsolation, probeIsolation } from "./evaluation/isolation.js";
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
import { npmPackageTypes } from "carveout/extract";
import { createStarterAdapter } from "./tools/starter.js";
import { createSubmissionGradeAdapter } from "./tools/submission-grade.js";
import { createSandboxImportAdapter } from "./tools/sandbox-import.js";

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
const submissions = createSubmissionStore(connection.db);
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
// Every turn a run's agents take is written to the token ledger against
// the run's workspace and the run: what the monthly quota counts.
const modelUsage = createModelUsageStore(connection.db);
const agentFor = (run: ClaimedAnalysisRun): AgentSettings =>
  meteredAgent(agent, run, modelUsage, (code, error) =>
    console.error(code, run.id, error instanceof Error ? error.message : ""),
  );
// `e2b` runs each job in a fresh E2B sandbox, the hosted provider.
// `local-process` is the development provider: a fresh directory and
// scrubbed processes, not an isolation boundary, so only a worker that opts
// in runs builds with it, and never one with NODE_ENV=production.
// Two jobs at once at most: the agent slots can hold three builds, each
// with a baseline to run.
// The caches below live under the worker user's own home, which no other
// user can create first, at one name, so a restart on the same disk finds
// them again rather than leaving them behind.
// Only the worker's user reads them: a mode set on creation alone would
// leave a directory an earlier run made open.
const caches = join(homedir(), ".cache", "sandbox-factory");
await mkdir(caches, { recursive: true, mode: 0o700 });
await chmod(caches, 0o700);
// A root worker runs each job as a uid of its own, with an npm cache
// outside its home, which those uids cannot traverse: one uid per job the
// limiter lets run, from the one count, so a job never finds them all held.
const jobSlots = EVALUATION_JOBS_MAX;
const isolation =
  env.EVALUATION_PROVIDER === "local-process"
    ? jobIsolation({
        uid: process.getuid?.(),
        base: env.EVALUATION_JOB_UID,
        slots: jobSlots,
        cacheRoot: join(tmpdir(), "sandbox-factory-jobs"),
      })
    : null;
// A root worker that cannot switch to its job uids is misconfigured: it
// stops here rather than fail every build, or run them as root.
if (isolation !== null) await probeIsolation(isolation);
const evaluation =
  env.EVALUATION_PROVIDER === "local-process"
    ? limitJobs(
        createLocalProcessProvider({
          npmCache: join(caches, "npm"),
          lockfiles: join(caches, "lockfiles"),
          isolation,
          warn: (line) => console.warn(line),
        }),
        jobSlots,
      )
    : env.EVALUATION_PROVIDER === "e2b" && env.E2B_API_KEY !== undefined
      ? limitJobs(
          createE2BProvider({
            client: e2bClient(env.E2B_API_KEY),
            ...(env.E2B_TEMPLATE === undefined
              ? {}
              : { template: env.E2B_TEMPLATE }),
            budgetMs: env.E2B_JOB_TIMEOUT_SECONDS * 1000,
          }),
          jobSlots,
        )
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
// first, for as long as the disk keeps it.
const sourceCache = await createSourceCache({
  root: join(caches, "sources"),
});
// The published types of the public packages slices read, by package set.
const packageTypes = npmPackageTypes({ root: join(caches, "package-types") });
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
      // carveout analyses every new slice (`slice/carveout-analysis.ts`); a
      // slice run already made keeps what it was made with (its manifest's
      // `walkEngine` and `toolVersion`).
      return createSliceAdapter({ packageTypes });
    case "sandbox_build":
      return createSandboxBuildAdapter({
        agent: agentFor(run),
        provider: evaluation,
      });
    case "scope":
      return createScopeAdapter(agentFor(run), { packageTypes });
    case "fixtures":
      return createFixturesAdapter(agentFor(run));
    case "sandbox_starter":
      return createStarterAdapter({
        agent: agentFor(run),
        provider: evaluation,
      });
    case "submission_grade":
      return createSubmissionGradeAdapter({ provider: evaluation });
    case "sandbox_import":
      return createSandboxImportAdapter({ provider: evaluation });
  }
}
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
        submissions,
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
