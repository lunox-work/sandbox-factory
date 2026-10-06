import {
  createAnalysisRunStore,
  createArtifactStore,
  createBountyProposalStore,
  createBountySpecStore,
  createConnection,
  createObjectStore,
  createSandboxStore,
} from "@sandbox-factory/db";
import type { ClaimedAnalysisRun } from "@sandbox-factory/db";
import { InstallationTokens } from "@sandbox-factory/github";
import { repositoryToken } from "./credentials.js";
import { parseWorkerEnv } from "./env.js";
import { workerLoop } from "./loop.js";
import { executeRun } from "./run.js";
import { createAnthropicModel } from "./agent/anthropic.js";
import type { AgentSettings } from "./agent/loop.js";
import { createLocalProcessProvider } from "./evaluation/local-process.js";
import { createTaskReader } from "./tasks.js";
import type { ToolAdapter } from "./tools/adapter.js";
import { createDeepwikiAdapter } from "./tools/deepwiki.js";
import { createDependencyCruiserAdapter } from "./tools/dependency-cruiser.js";
import { createFixturesAdapter } from "./tools/fixtures.js";
import { createGraphifyAdapter } from "./tools/graphify.js";
import { createSandboxBuildAdapter } from "./tools/sandbox-build.js";
import { createScopeAdapter } from "./tools/scope.js";
import { createSliceAdapter } from "./tools/slice.js";
import { createStarterAdapter } from "./tools/starter.js";

const env = parseWorkerEnv();
const connection = createConnection({ url: env.DATABASE_URL, max: 3 });
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
const evaluation =
  env.EVALUATION_PROVIDER === "local-process"
    ? createLocalProcessProvider()
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
const tokens = new InstallationTokens({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
});
/** The adapter for a claimed run's tool; every tool has exactly one. */
function adapterFor(run: ClaimedAnalysisRun): ToolAdapter {
  switch (run.tool) {
    case "graphify":
      return createGraphifyAdapter();
    case "dependency_cruiser":
      return createDependencyCruiserAdapter();
    case "deepwiki":
      return createDeepwikiAdapter({
        baseUrl: env.DEEPWIKI_OPEN_URL,
        authCode: env.DEEPWIKI_OPEN_AUTH_CODE,
        provider: env.DEEPWIKI_OPEN_PROVIDER,
        model: env.DEEPWIKI_OPEN_MODEL,
        repository:
          run.repoFullName === null
            ? null
            : {
                fullName: run.repoFullName,
                token: repositoryToken(tokens, run),
              },
      });
    case "slice":
      return createSliceAdapter();
    case "sandbox_build":
      return createSandboxBuildAdapter({ provider: evaluation });
    case "scope":
      return createScopeAdapter(agent);
    case "fixtures":
      return createFixturesAdapter(agent);
    case "sandbox_starter":
      return createStarterAdapter({ agent, provider: evaluation });
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
try {
  await workerLoop({
    runs,
    mode: env.WORKER_MODE,
    signal: stopClaiming.signal,
    execute: async (run) => {
      await executeRun(run, {
        runs,
        artifacts,
        sandboxes,
        tasks,
        objects,
        tool: adapterFor(run),
        shutdown: stopCurrent.signal,
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
