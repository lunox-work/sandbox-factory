import type {
  ClaimedAnalysisRun,
  AnalysisRunStore,
  ObjectStore,
} from "@sandbox-factory/db";
export const run: ClaimedAnalysisRun = {
  id: "arn_1",
  snapshotId: "rsn_1",
  repoId: "ghr_1",
  tool: "graphify",
  toolVersion: "test",
  params: { deadlineMinutes: 30 },
  status: "running",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  organizationId: "org_1",
  leaseToken: "lease_1",
  commitSha: "a".repeat(40),
  repoFullName: "acme/widgets",
  externalRepoId: "1",
  installationId: "9",
  sizeKb: 1,
};
export function stores() {
  const bytes = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const objects: ObjectStore = {
    put: async (key, body) => {
      bytes.set(key, body);
    },
    get: async (key) => bytes.get(key),
    exists: async (key) => bytes.has(key),
    remove: async (key) => {
      bytes.delete(key);
    },
    signedUrl: async (key) => `https://objects.test/${key}`,
  };
  const runs = {
    logKey: async () => "logs/arn_1/lease_1.log",
    heartbeat: async () => true,
    finish: async () => {
      calls.push("finish");
      return true;
    },
    fail: async (_o: string, _id: string, _token: string, code: string) => {
      calls.push(code);
      return true;
    },
    release: async () => {
      calls.push("release");
      return true;
    },
    get: async () => ({ ...run, status: "failed" }),
  } as unknown as AnalysisRunStore;
  return { bytes, calls, objects, runs };
}
