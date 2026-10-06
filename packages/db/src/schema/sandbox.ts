/**
 * Sandboxes: a bounty's task, its immutable versions, the private
 * provenance behind each version, and the submissions judged by them.
 *
 * A bounty has one sandbox, and the sandbox three faces. The private one is
 * `sandbox_source` and `sandbox_version_source`: the source repository, the
 * alias table, the approved task with its spec and price, hidden tests and
 * every hash that locates private evidence. The public one is `sandbox` and
 * `sandbox_version`, which hold public-safe columns only, so a publication
 * receipt can expose them without a filter. The protected one is
 * `submission`: a contributor's patch, run against the version it was made
 * for. No public store joins a private table.
 *
 * The repository is enrichment, not a requirement: a sandbox exists without
 * `sandbox_source`, and only slicing a version needs one. Without one, a
 * version is generated: an agent writes a starter from the bounty's text,
 * and the version names that run (`starter_run_id`) where a sliced one
 * names its snapshot, slice run, manifest and contract.
 *
 * Owner scoping: `sandbox.organization_id` is the owner, and the version
 * tables reach it through `sandbox`. A version's snapshot and slice run
 * must belong to the sandbox's own source repository, and a starter run to
 * its owner, which the store checks when it creates the version; the
 * source association cannot change once a version is frozen.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import type {
  AcceptanceTest,
  AliasRule,
  StoredApprovedTaskSnapshot,
  DependencyChoice,
  SandboxStatus,
  ScopeRecord,
  SubmissionResult,
  SubmissionStatus,
  VersionFixtures,
} from "sandbox-factory";

import { analysisRun, repoSnapshot } from "./analysis.js";
import { user } from "./auth.js";
import { bounty } from "./bounty.js";
import { githubRepo } from "./github.js";
import { organization } from "./organizations.js";

const ts = (name: string) => timestamp(name, { withTimezone: true });
const owner = () =>
  text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

export const sandbox = pgTable(
  "sandbox",
  {
    id: text("id").primaryKey(),
    organizationId: owner(),
    /**
     * The bounty this is the sandbox of, one each. Private, like the rest
     * of the bounty: never in a public listing. Removing a bounty that has
     * a sandbox is refused, so a published task keeps its provenance.
     */
    bountyId: text("bounty_id")
      .notNull()
      .unique()
      .references(() => bounty.id),
    /** Opaque, so the source module cannot be inferred from the listing. */
    slug: text("slug").notNull().unique(),
    status: text("status").$type<SandboxStatus>().notNull().default("draft"),
    /** `role = sandbox`; set by publication, null until then. */
    publicRepoId: text("public_repo_id").references(() => githubRepo.id),
    /** Stores validate that this is one of this sandbox's published versions. */
    currentVersionId: text("current_version_id"),
    /**
     * When the publication lapses: set by each publish, cleared by an
     * unpublish. Past it the sandbox reads as no longer published.
     */
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("sandbox_organization_id_idx").on(t.organizationId)],
);

/** The repository a sandbox is cut from, when it has one. */
export const sandboxSource = pgTable("sandbox_source", {
  sandboxId: text("sandbox_id")
    .primaryKey()
    .references(() => sandbox.id, { onDelete: "cascade" }),
  /** Must have `role = source`; checked by the store. */
  sourceRepoId: text("source_repo_id")
    .notNull()
    .references(() => githubRepo.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const sandboxVersion = pgTable(
  "sandbox_version",
  {
    id: text("id").primaryKey(),
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandbox.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    /** Written post-alias; covered by the disclosure scan. */
    specSummary: text("spec_summary").notNull(),
    /** The shared size contract proposals use. */
    complexity: text("complexity").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    testSummary: jsonb("test_summary")
      .$type<{ label: string; count: number }[]>()
      .notNull()
      .default([]),
    /** Prepared privately, fixed before publication. */
    publicBaseCommitSha: text("public_base_commit_sha"),
    readme: text("readme"),
    languages: jsonb("languages").$type<Record<string, number>>(),
    /** Immutable once set; an edit creates version + 1. */
    frozenAt: ts("frozen_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("sandbox_version_sandbox_version_unique").on(t.sandboxId, t.version),
  ],
);

export const sandboxVersionSource = pgTable(
  "sandbox_version_source",
  {
    sandboxVersionId: text("sandbox_version_id")
      .primaryKey()
      .references(() => sandboxVersion.id, { onDelete: "cascade" }),
    /** A sliced version's inputs; all null for a generated one. */
    sourceSnapshotId: text("source_snapshot_id").references(
      () => repoSnapshot.id,
    ),
    sliceRunId: text("slice_run_id").references(() => analysisRun.id),
    /** Hashes locate immutable private artifacts through the run manifests. */
    manifestSha256: text("manifest_sha256"),
    contractSha256: text("contract_sha256"),
    /** The run that writes a generated version's starter; null for a sliced one. */
    starterRunId: text("starter_run_id").references(() => analysisRun.id),
    /** The `starter_set` artifact's hash, once that run has committed. */
    starterSha256: text("starter_sha256"),
    transformConfigSha256: text("transform_config_sha256").notNull(),
    approvedTaskSha256: text("approved_task_sha256").notNull(),
    /**
     * The bounty version (its proposal's approved version) the task was
     * taken from. Null for one taken before this was kept, which reads as
     * built on an earlier version.
     */
    proposalVersion: integer("proposal_version"),
    /** The approved task copied at selection; survives the live proposal. */
    approvedTask: jsonb("approved_task")
      .$type<StoredApprovedTaskSnapshot>()
      .notNull(),
    /** Ordered, scoped rules; never returned publicly. */
    aliasRules: jsonb("alias_rules").$type<AliasRule[]>().notNull(),
    dependencyChoices: jsonb("dependency_choices")
      .$type<Record<string, DependencyChoice>>()
      .notNull()
      .default({}),
    /** Hidden tests and their expected baseline outcomes. */
    acceptanceTests: jsonb("acceptance_tests")
      .$type<AcceptanceTest[]>()
      .notNull()
      .default([]),
    /** Behaviour for the mocked seams and the dev walkthrough; null when none. */
    fixtures: jsonb("fixtures").$type<VersionFixtures>(),
    /** Editable paths, generated paths and resolved dependencies. */
    scope: jsonb("scope").$type<ScopeRecord>().notNull(),
    /** Required at freeze; assembled by the build (5B). */
    harnessSha256: text("harness_sha256"),
    toolchainDigest: text("toolchain_digest"),
    buildRunId: text("build_run_id").references(() => analysisRun.id),
    roundTripRunId: text("round_trip_run_id").references(() => analysisRun.id),
    disclosureRunId: text("disclosure_run_id").references(() => analysisRun.id),
    approvedBy: text("approved_by").references(() => user.id),
    approvedAt: ts("approved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Sliced or generated, never both and never neither.
    check(
      "sandbox_version_source_origin_check",
      sql`(${t.sliceRunId} is not null and ${t.sourceSnapshotId} is not null and ${t.manifestSha256} is not null and ${t.contractSha256} is not null and ${t.starterRunId} is null) or (${t.sliceRunId} is null and ${t.sourceSnapshotId} is null and ${t.manifestSha256} is null and ${t.contractSha256} is null and ${t.starterRunId} is not null)`,
    ),
  ],
);

/**
 * One contributor's attempt at a sandbox version: the protected sandbox,
 * where their patch is applied to the version it was made against and run
 * with the hidden tests. See `sandbox/submission.ts` in core.
 *
 * Pinned to its version, not the sandbox's current one, so a later version
 * never changes what an earlier verdict was measured against. The patch
 * itself is in the private bucket; this row names it by hash. A result is
 * counts only, never the names of hidden tests.
 */
export const submission = pgTable(
  "submission",
  {
    id: text("id").primaryKey(),
    organizationId: owner(),
    sandboxVersionId: text("sandbox_version_id")
      .notNull()
      .references(() => sandboxVersion.id, { onDelete: "cascade" }),
    /** The contributor. Kept as null when their account goes. */
    submittedBy: text("submitted_by").references(() => user.id, {
      onDelete: "set null",
    }),
    /** `patches/<sandboxVersionId>/<patchSha256>.diff` in the private bucket. */
    patchKey: text("patch_key").notNull(),
    patchSha256: text("patch_sha256").notNull(),
    status: text("status")
      .$type<SubmissionStatus>()
      .notNull()
      .default("queued"),
    /** Present once the run passed or failed, and only then. */
    result: jsonb("result").$type<SubmissionResult>(),
    /** The run that applied and tested the patch, while it is kept. */
    runId: text("run_id").references(() => analysisRun.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // The same patch against the same version is the same submission.
    unique("submission_version_patch_unique").on(
      t.sandboxVersionId,
      t.patchSha256,
    ),
    index("submission_organization_id_idx").on(t.organizationId),
    check(
      "submission_status_check",
      sql`${t.status} in ('queued', 'running', 'passed', 'failed', 'errored')`,
    ),
    check(
      "submission_result_check",
      sql`(${t.status} in ('passed', 'failed')) = (${t.result} IS NOT NULL)`,
    ),
    check("submission_patch_hash_check", sql`length(${t.patchSha256}) = 64`),
  ],
);

export type SandboxRow = typeof sandbox.$inferSelect;
export type SandboxSourceRow = typeof sandboxSource.$inferSelect;
export type SandboxVersionRow = typeof sandboxVersion.$inferSelect;
export type SandboxVersionSourceRow = typeof sandboxVersionSource.$inferSelect;
export type SubmissionRow = typeof submission.$inferSelect;
export type NewSubmissionRow = typeof submission.$inferInsert;
