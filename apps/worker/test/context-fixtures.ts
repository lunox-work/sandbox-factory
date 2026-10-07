/**
 * The context builders' documents the agent tests read back: a small
 * abstractions index and data model over the slice fixture, and a helper
 * that serves one as a succeeded run's artifact.
 */

import { createHash } from "node:crypto";
import type { StoredAnalysisRun, StoredArtifact } from "@sandbox-factory/db";
import type {
  AbstractionIndex,
  DataEntity,
  DataModel,
  ModuleSurface,
  SurfaceExport,
} from "sandbox-factory";

const stamp = "2026-10-06T00:00:00.000Z";

export const createServiceExport: SurfaceExport = {
  id: "symbol:lib/service.ts:service_createservice",
  name: "createService",
  kind: "function",
  signature:
    "export declare function createService(options: ServiceOptions): Service;",
  line: 18,
  references: [],
};
export const serviceModule: ModuleSurface = {
  path: "lib/service.ts",
  language: "typescript",
  coverage: "typed",
  importers: 2,
  exports: [
    {
      id: "symbol:lib/service.ts#ServiceOptions",
      name: "ServiceOptions",
      kind: "interface",
      signature:
        "export interface ServiceOptions extends Config {\n    retries: number;\n}",
      line: 4,
      references: ["symbol:lib/types.ts#Config"],
    },
    createServiceExport,
  ],
};
export const ownersEntity: DataEntity = {
  name: "owners",
  table: "owners",
  kind: "table",
  source: "drizzle",
  file: "lib/schema.ts",
  line: 12,
  fields: [],
  primaryKey: [],
  uniques: [],
};
export const contextIndex: AbstractionIndex = {
  schemaVersion: 1,
  toolVersion: "abstractions@1",
  extractors: { typescript: "typescript@5.9.3", syntactic: null },
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_graph",
  graphSha256: "g".repeat(64),
  modules: [
    serviceModule,
    {
      path: "scripts/tool.py",
      language: "python",
      coverage: "names-only",
      importers: 1,
      exports: [
        {
          id: "symbol:scripts/tool.py:tool_run",
          name: "run",
          kind: "function",
          signature: null,
          line: 1,
          references: [],
        },
      ],
    },
  ],
  externals: [],
  omissions: [],
};

export const contextModel: DataModel = {
  schemaVersion: 1,
  toolVersion: "data_model@1",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_graph",
  graphSha256: "g".repeat(64),
  sources: [
    {
      kind: "drizzle",
      storage: "postgresql",
      files: ["lib/schema.ts"],
      evidence: ["dependency:drizzle-orm/pg-core"],
      entities: 2,
      shadowed: 0,
    },
    {
      kind: "sql_migrations",
      storage: "postgresql",
      files: ["migrations/1.sql"],
      evidence: [],
      entities: 0,
      shadowed: 2,
    },
  ],
  entities: [
    {
      name: "things",
      table: "app.things",
      kind: "table",
      source: "drizzle",
      file: "lib/schema.ts",
      line: 3,
      fields: [
        {
          name: "id",
          column: "id",
          type: "string",
          nativeType: "text",
          list: false,
          nullable: false,
          default: null,
          unique: false,
          primaryKey: true,
          enum: null,
        },
        {
          name: "ownerId",
          column: "owner_id",
          type: "string",
          nativeType: "text",
          list: false,
          nullable: true,
          default: null,
          unique: true,
          primaryKey: false,
          enum: null,
        },
        {
          name: "state",
          column: "state",
          type: "enum",
          nativeType: "state",
          list: false,
          nullable: false,
          default: "'new'",
          unique: false,
          primaryKey: false,
          enum: "state",
        },
        {
          name: "tags",
          column: "tags",
          type: "string",
          nativeType: "text[]",
          list: true,
          nullable: true,
          default: null,
          unique: false,
          primaryKey: false,
          enum: "missing",
        },
      ],
      primaryKey: ["id"],
      uniques: [["ownerId", "state"]],
    },
    ownersEntity,
  ],
  enums: [
    {
      name: "state",
      values: ["new", "done"],
      source: "drizzle",
      file: "lib/schema.ts",
      line: 1,
    },
  ],
  relations: [
    {
      name: null,
      from: { entity: "things", fields: ["ownerId"] },
      to: { entity: "owners", fields: ["id"] },
      cardinality: "one-to-one",
      onDelete: "cascade",
      onUpdate: null,
      source: "drizzle",
    },
    {
      name: null,
      from: { entity: "owners", fields: [] },
      to: { entity: "things", fields: [] },
      cardinality: "many-to-many",
      onDelete: null,
      onUpdate: null,
      source: "drizzle",
    },
    {
      name: null,
      from: { entity: "things", fields: ["id"] },
      to: { entity: "things", fields: [] },
      cardinality: "many-to-one",
      onDelete: null,
      onUpdate: null,
      source: "drizzle",
    },
  ],
  accessors: [
    { module: "lib/service.ts", entities: ["owners", "things"], importers: 2 },
  ],
  omissions: [],
};

/** A succeeded context run whose document is served back as an artifact. */
export function contextRun(
  id: string,
  tool: "abstractions" | "data_model",
  document: unknown,
): { run: StoredAnalysisRun; artifact: StoredArtifact; bytes: Buffer } {
  const bytes = Buffer.from(JSON.stringify(document));
  return {
    run: {
      id,
      snapshotId: "rsn_1",
      repoId: "ghr_1",
      tool,
      toolVersion: "test",
      params: { deadlineMinutes: 30, builder: tool, graphRunId: "arn_graph" },
      status: "succeeded",
      attempt: 0,
      maxAttempts: 2,
      errorCode: null,
      errorDetail: null,
      startedAt: stamp,
      finishedAt: stamp,
      deadlineAt: stamp,
      createdAt: stamp,
    },
    artifact: {
      id: `art_${id}`,
      runId: id,
      kind: tool === "abstractions" ? "abstraction_index" : "data_model",
      path: tool === "abstractions" ? "abstractions.json" : "data-model.json",
      objectKey: `runs/${id}/document.json`,
      contentType: "application/json",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      meta: null,
      createdAt: stamp,
    },
    bytes,
  };
}
