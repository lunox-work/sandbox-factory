/**
 * What is known about a registered repository's source at one commit.
 *
 * Pointers only, like the GitHub tables this hangs from. A snapshot records
 * a commit, the tree there and facts computed from the tree's paths; the
 * file list itself is in object storage (`trees/<repoId>/<sha>/<objectId>.json.gz`),
 * and no file's contents are kept anywhere.
 *
 * No `organization_id` here: a snapshot is always reached through its
 * `github_repo`, whose `organization_id` every store joins into its `WHERE`.
 * The repository cannot change organization (its composite key with the
 * connection holds it), so the join is the owner check.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import type { TreeFacts } from "sandbox-factory";
import type {
  AnalysisParams,
  AnalysisStatus,
  AnalysisErrorCode,
  ArtifactKind,
} from "sandbox-factory";

import { githubRepo } from "./github.js";
import { user } from "./auth.js";

const ts = (name: string) => timestamp(name, { withTimezone: true });

/**
 * One commit of a source repository, as the tree there describes it.
 *
 * Immutable once written. The repository's `head_sha` moves on; each head
 * seen is its own snapshot, so whatever was priced or prepared against one
 * still names the exact commit it read.
 */
export const repoSnapshot = pgTable(
  "repo_snapshot",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => githubRepo.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    /** The branch it was read from, as `refs/heads/<name>`. */
    ref: text("ref").notNull(),
    /** The root tree's own id. */
    treeSha: text("tree_sha").notNull(),
    /** `trees/<repoId>/<commitSha>/<objectId>.json.gz` in the private bucket. */
    treeKey: text("tree_key").notNull(),
    /** GitHub's 100,000-entry / 7 MB cap cut the listing short. */
    treeTruncated: boolean("tree_truncated").notNull().default(false),
    fileCount: integer("file_count").notNull(),
    /** The sum of the files' sizes. */
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    /** Bytes per language, from `GET /repos/{o}/{r}/languages`. */
    languages: jsonb("languages").$type<Record<string, number>>().notNull(),
    /** `TreeFacts` from `packages/core`. */
    facts: jsonb("facts").$type<TreeFacts>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (table) => [
    // The webhook and the sweep can both see a new head within seconds;
    // the second insert is a no-op.
    unique("repo_snapshot_repo_sha_unique").on(table.repoId, table.commitSha),
    // Newest first per repository: the list, the sizing outline, pruning.
    index("repo_snapshot_repo_created_at_idx").on(
      table.repoId,
      table.createdAt,
    ),
  ],
);

export type RepoSnapshotRow = typeof repoSnapshot.$inferSelect;
export type NewRepoSnapshotRow = typeof repoSnapshot.$inferInsert;

export const analysisRun = pgTable(
  "analysis_run",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => repoSnapshot.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    toolVersion: text("tool_version").notNull(),
    params: jsonb("params").$type<AnalysisParams>().notNull(),
    paramsHash: text("params_hash").notNull(),
    status: text("status").$type<AnalysisStatus>().notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    requestedBy: text("requested_by").references(() => user.id, {
      onDelete: "set null",
    }),
    leaseToken: text("lease_token"),
    leaseExpiresAt: ts("lease_expires_at"),
    heartbeatAt: ts("heartbeat_at"),
    deadlineAt: ts("deadline_at"),
    errorCode: text("error_code").$type<AnalysisErrorCode>(),
    errorDetail: text("error_detail"),
    logKey: text("log_key"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("analysis_run_cache_unique").on(
      t.snapshotId,
      t.tool,
      t.toolVersion,
      t.paramsHash,
    ),
    index("analysis_run_status_created_at_idx").on(t.status, t.createdAt),
  ],
);

export const artifact = pgTable(
  "artifact",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => analysisRun.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ArtifactKind>().notNull(),
    path: text("path").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique("artifact_run_path_unique").on(t.runId, t.path)],
);
export type AnalysisRunRow = typeof analysisRun.$inferSelect;
export type ArtifactRow = typeof artifact.$inferSelect;
