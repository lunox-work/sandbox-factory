/**
 * The worker fixture repository sliced once by the real slice adapter, and
 * served back as a succeeded slice run's artifacts, for the tools that
 * build on a slice.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredAnalysisRun, StoredArtifact } from "@sandbox-factory/db";
import type { BoundaryContract, SliceManifest } from "sandbox-factory";
import { createSliceAdapter } from "../src/tools/slice.js";

export const fixture = fileURLToPath(
  new URL("../../fixtures/slice/", import.meta.url),
);
export const stamp = "2026-10-02T00:00:00.000Z";
export const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const graphRun: StoredAnalysisRun = {
  id: "arn_graph",
  snapshotId: "rsn_1",
  repoId: "ghr_1",
  tool: "graphify",
  toolVersion: "test",
  params: { deadlineMinutes: 30 },
  status: "succeeded",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  startedAt: stamp,
  finishedAt: stamp,
  deadlineAt: stamp,
  createdAt: stamp,
};
export const sliceRun: StoredAnalysisRun = {
  ...graphRun,
  id: "arn_slice",
  tool: "slice",
  toolVersion: "slice@1",
  params: {
    deadlineMinutes: 30,
    graphRunId: graphRun.id,
    entryPoints: ["src/app.ts", "src/local.ts"],
    budget: { maxFiles: 2, maxDepth: 3 },
    includeInferred: false,
  },
};

/** The fixture graph the slice tests use, reduced to what the build needs. */
export function graph() {
  const files = [
    "src/app.ts",
    "src/local.ts",
    "lib/service.ts",
    "lib/types.ts",
    "lib/origin.ts",
    "lib/reexport.ts",
    "lib/star.ts",
    "lib/alias.ts",
    "lib/helpers.ts",
    "consumers/cli.ts",
  ];
  const nodes = files.map((file) => ({
    id: `file:${file}`,
    label: file,
    source_file: file,
    community: 0,
  }));
  nodes.push({
    id: "dependency:src/app.ts:pg",
    label: "pg",
    source_file: "src/app.ts",
    community: 0,
    dependencyStatus: "external",
  } as never);
  const edge = (
    from: string,
    to: string,
    specifier: string,
    resolved = true,
  ) => ({
    source: `file:${from}`,
    target: resolved ? `file:${to}` : to,
    relation: "imports",
    confidence: "EXTRACTED",
    specifier,
    resolved,
    source_location: "L1",
  });
  return {
    schemaVersion: 1,
    directed: true,
    multigraph: true,
    nodes,
    links: [
      edge("src/app.ts", "lib/service.ts", "../lib/service.js"),
      edge("src/app.ts", "lib/alias.ts", "@lib/alias"),
      edge("src/app.ts", "lib/reexport.ts", "../lib/reexport.js"),
      edge("src/app.ts", "lib/helpers.ts", "../lib/helpers.js"),
      edge("src/app.ts", "dependency:src/app.ts:pg", "pg", false),
      edge("src/local.ts", "src/app.ts", "./app.js"),
      edge("lib/service.ts", "lib/types.ts", "./types.js"),
      edge("lib/service.ts", "lib/origin.ts", "./origin.js"),
      edge("lib/reexport.ts", "lib/origin.ts", "./origin.js"),
      edge("lib/reexport.ts", "lib/star.ts", "./star.js"),
      edge("consumers/cli.ts", "src/app.ts", "../src/app.js"),
    ],
    communities: { "0": files.map((file) => `file:${file}`) },
  };
}

export interface SliceOutput {
  artifacts: StoredArtifact[];
  objects: Map<string, Buffer>;
  manifest: SliceManifest;
  contract: BoundaryContract;
}
let sliced: Promise<SliceOutput> | undefined;
/** Runs the real slice adapter once and serves its outputs as a slice run's artifacts. */
export function slice(): Promise<SliceOutput> {
  sliced ??= (async () => {
    const out = await mkdtemp(join(tmpdir(), "build-slice-"));
    const graphBytes = Buffer.from(JSON.stringify(graph()));
    const graphArtifacts: StoredArtifact[] = [
      {
        id: "art_graph",
        runId: graphRun.id,
        kind: "graph_json",
        path: "graph.json",
        objectKey: "runs/arn_graph/lease/graph.json",
        contentType: "application/json",
        sizeBytes: graphBytes.byteLength,
        sha256: sha(graphBytes),
        meta: null,
        createdAt: stamp,
      },
    ];
    const files = await createSliceAdapter().run({
      sourceDir: fixture,
      outDir: out,
      params: sliceRun.params,
      run: { snapshotId: "rsn_1", commitSha: "a".repeat(40) },
      inputs: {
        getRun: async (id) => (id === graphRun.id ? graphRun : null),
        listArtifacts: async (id) => (id === graphRun.id ? graphArtifacts : []),
        readArtifact: async (key) =>
          key === graphArtifacts[0]?.objectKey ? graphBytes : undefined,
        getVersion: async () => null,
        getTask: async () => null,
        recordBuildOutput: async () => false,
        recordStarterOutput: async () => false,
      },
      signal: new AbortController().signal,
      log: () => {},
    });
    const objects = new Map<string, Buffer>();
    const artifacts: StoredArtifact[] = [];
    for (const file of files) {
      const bytes = await readFile(file.absolutePath);
      const objectKey = `runs/arn_slice/lease/${file.path}`;
      objects.set(objectKey, bytes);
      artifacts.push({
        id: `art_${artifacts.length}`,
        runId: sliceRun.id,
        kind: file.kind,
        path: file.path,
        objectKey,
        contentType: file.contentType,
        sizeBytes: bytes.byteLength,
        sha256: sha(bytes),
        meta: file.meta,
        createdAt: stamp,
      });
    }
    const text = (path: string) =>
      objects.get(`runs/arn_slice/lease/${path}`)?.toString("utf8") ?? "";
    return {
      artifacts,
      objects,
      manifest: JSON.parse(text("slice-manifest.json")) as SliceManifest,
      contract: JSON.parse(text("boundary-contract.json")) as BoundaryContract,
    };
  })();
  return sliced;
}
