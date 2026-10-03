/**
 * Sandboxes: a task cut from a source repository, its immutable versions,
 * and the private provenance behind each version.
 *
 * `sandbox` and `sandbox_version` hold public-safe columns only, so a
 * publication receipt can expose them without a filter. `sandbox_source`,
 * `sandbox_ticket` and `sandbox_version_source` are private and are
 * never joined by a public store: the source repository, the alias table,
 * the approved task with its spec and price, hidden tests and every hash
 * that locates private evidence live there.
 *
 * Owner scoping: `sandbox.organization_id` is the owner, and the version
 * tables reach it through `sandbox`. A version's snapshot and slice run
 * must belong to the sandbox's own source repository, which the store
 * checks when it creates the version; the source association cannot
 * change once a version is frozen.
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  VersionFixtures,
} from "sandbox-factory";

import { analysisRun, repoSnapshot } from "./analysis.js";
import { user } from "./auth.js";
import { githubRepo } from "./github.js";
import { organization } from "./organizations.js";
import { ticket } from "./ticket.js";

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
    /** Opaque, so the source module cannot be inferred from the listing. */
    slug: text("slug").notNull().unique(),
    status: text("status").$type<SandboxStatus>().notNull().default("draft"),
    /** `role = sandbox`; set by publication, null until then. */
    publicRepoId: text("public_repo_id").references(() => githubRepo.id),
    /** Stores validate that this is one of this sandbox's published versions. */
    currentVersionId: text("current_version_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("sandbox_organization_id_idx").on(t.organizationId)],
);

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

/** The tickets a sandbox is cut for. Private, like its source. */
export const sandboxTicket = pgTable(
  "sandbox_ticket",
  {
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandbox.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.ticketId] }),
    // Deleting a ticket takes its links; without it that is a scan.
    index("sandbox_ticket_ticket_id_idx").on(t.ticketId),
  ],
);

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

export const sandboxVersionSource = pgTable("sandbox_version_source", {
  sandboxVersionId: text("sandbox_version_id")
    .primaryKey()
    .references(() => sandboxVersion.id, { onDelete: "cascade" }),
  sourceSnapshotId: text("source_snapshot_id")
    .notNull()
    .references(() => repoSnapshot.id),
  sliceRunId: text("slice_run_id")
    .notNull()
    .references(() => analysisRun.id),
  /** Hashes locate immutable private artifacts through the run manifests. */
  manifestSha256: text("manifest_sha256").notNull(),
  contractSha256: text("contract_sha256").notNull(),
  transformConfigSha256: text("transform_config_sha256").notNull(),
  approvedTaskSha256: text("approved_task_sha256").notNull(),
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
});

export type SandboxRow = typeof sandbox.$inferSelect;
export type SandboxSourceRow = typeof sandboxSource.$inferSelect;
export type SandboxTicketRow = typeof sandboxTicket.$inferSelect;
export type SandboxVersionRow = typeof sandboxVersion.$inferSelect;
export type SandboxVersionSourceRow = typeof sandboxVersionSource.$inferSelect;
