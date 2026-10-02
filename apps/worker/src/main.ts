import {
  createAnalysisRunStore,
  createConnection,
  createObjectStore,
} from "@sandbox-factory/db";
import { InstallationTokens } from "@sandbox-factory/github";
import { repositoryToken } from "./credentials.js";
import { parseWorkerEnv } from "./env.js";
import { workerLoop } from "./loop.js";
import { executeRun } from "./run.js";
import { createGraphifyAdapter } from "./tools/graphify.js";

const env = parseWorkerEnv();
const connection = createConnection({ url: env.DATABASE_URL, max: 3 });
const runs = createAnalysisRunStore(connection.db);
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
        objects,
        tool: createGraphifyAdapter(),
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
