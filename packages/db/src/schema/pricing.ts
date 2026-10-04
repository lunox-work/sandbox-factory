/** Commercial records: what bounties are priced at, and how they got there. */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import type {
  AnalysisErrorCode,
  BountyRunOutcome,
  BountyRunPlannedIssue,
  BountySelection,
  ComplexityProfile,
  ProfileErrorCode,
  ProfileStatus,
  ProfileBounty,
  RateCardSnapshot,
  PricedComplexity,
  RespecRequest,
  SpecDraft,
  StepResult,
} from "sandbox-factory";

import { analysisRun, repoSnapshot } from "./analysis.js";
import { user } from "./auth.js";
import { jiraBoard } from "./jira.js";
import { organization } from "./organizations.js";
import { bounty } from "./bounty.js";

const ts = (name: string) => timestamp(name, { withTimezone: true });
const safeMinor = (name: string) => bigint(name, { mode: "number" });

export const rateCard = pgTable(
  "rate_card",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    // Legacy cards inherit their S rate until the next edit.
    xsMinor: safeMinor("xs_minor"),
    sMinor: safeMinor("s_minor").notNull(),
    mMinor: safeMinor("m_minor").notNull(),
    lMinor: safeMinor("l_minor").notNull(),
    xlMinor: safeMinor("xl_minor").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedBy: text("updated_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("rate_card_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      "rate_card_amounts_check",
      sql`coalesce(${table.xsMinor}, ${table.sMinor}) > 0 AND coalesce(${table.xsMinor}, ${table.sMinor}) <= ${table.sMinor} AND ${table.sMinor} <= ${table.mMinor} AND ${table.mMinor} <= ${table.lMinor} AND ${table.lMinor} <= ${table.xlMinor} AND ${table.xlMinor} <= 9007199254740991`,
    ),
    check("rate_card_revision_check", sql`${table.revision} > 0`),
  ],
);

export const bountyRun = pgTable(
  "bounty_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * The Jira board the run reads. Required for the two kinds that read
     * one, `backlog` and `issue`; a run that starts from a bounty has its
     * bounty's board when it has one, and none otherwise.
     */
    boardId: text("board_id").references(() => jiraBoard.id, {
      onDelete: "cascade",
    }),
    /**
     * The one bounty a `bounty`, `reprice` or `respec` run is about. Null
     * for a board's runs, whose bounties are imported as they are reached.
     */
    bountyId: text("bounty_id").references(() => bounty.id, {
      onDelete: "cascade",
    }),
    startedBy: text("started_by").references(() => user.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull().default("backlog"),
    sourceProposalId: text("source_proposal_id").references(
      (): AnyPgColumn => bountyProposal.id,
      { onDelete: "set null" },
    ),
    sourceRevision: integer("source_revision"),
    // What a `respec` run was asked to do to its proposal's spec. Null for
    // every other kind, and required for that one.
    respec: jsonb("respec").$type<RespecRequest>(),
    requestId: text("request_id").notNull(),
    status: text("status").notNull().default("queued"),
    selection: jsonb("selection").$type<BountySelection>().notNull(),
    rateCard: jsonb("rate_card").$type<RateCardSnapshot>().notNull(),
    requestedModel: text("requested_model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    planned: jsonb("planned")
      .$type<BountyRunPlannedIssue[]>()
      .notNull()
      .default([]),
    outcomes: jsonb("outcomes")
      .$type<BountyRunOutcome[]>()
      .notNull()
      .default([]),
    candidatesScanned: integer("candidates_scanned").notNull().default(0),
    skippedLive: integer("skipped_live").notNull().default(0),
    scanLimitReached: boolean("scan_limit_reached").notNull().default(false),
    leaseToken: text("lease_token"),
    leaseExpiresAt: ts("lease_expires_at"),
    heartbeatAt: ts("heartbeat_at"),
    deadlineAt: ts("deadline_at"),
    fatalErrorCode: text("fatal_error_code"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("bounty_run_organization_request_unique").on(
      table.organizationId,
      table.requestId,
    ),
    uniqueIndex("bounty_run_board_active_unique")
      .on(table.boardId)
      // A one-bounty run someone asked for is not counted: it must not wait
      // behind a board's backlog run, and the proposal store already refuses
      // a second live proposal for the same bounty. Nor is a spec change on
      // one proposal, which a backlog run never touches.
      .where(
        sql`${table.status} in ('queued', 'running') and ${table.kind} not in ('issue', 'respec', 'bounty')`,
      ),
    // One sizing of a bounty at a time: a second would only meet the first's
    // proposal when it came to write, after paying for its model calls.
    uniqueIndex("bounty_run_bounty_active_unique")
      .on(table.bountyId)
      .where(
        sql`${table.status} in ('queued', 'running') and ${table.kind} = 'bounty'`,
      ),
    // One change in flight per proposal: a re-price and a spec change both
    // rewrite it, and the second would only find it changed when it came to
    // write, after paying for its model call.
    uniqueIndex("bounty_run_proposal_active_unique")
      .on(table.sourceProposalId)
      .where(
        sql`${table.status} in ('queued', 'running') and ${table.kind} in ('reprice', 'respec')`,
      ),
    index("bounty_run_organization_id_idx").on(table.organizationId),
    index("bounty_run_board_created_idx").on(table.boardId, table.createdAt),
    index("bounty_run_bounty_id_idx").on(table.bountyId),
    check(
      "bounty_run_kind_check",
      sql`${table.kind} in ('backlog', 'reprice', 'issue', 'respec', 'bounty')`,
    ),
    check(
      "bounty_run_scope_check",
      // A board's runs read the board; a bounty's run names its bounty. A
      // re-price or spec change names its proposal (below), and its bounty
      // and board only as they were when it started.
      sql`(${table.kind} not in ('backlog', 'issue') OR ${table.boardId} IS NOT NULL) AND (${table.kind} <> 'bounty' OR ${table.bountyId} IS NOT NULL)`,
    ),
    check(
      "bounty_run_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'partial', 'failed')`,
    ),
    check(
      "bounty_run_source_check",
      // A reprice run's source may be deleted later, and `ON DELETE SET NULL`
      // clears the pointer; requiring it here would make that delete fail.
      sql`(${table.kind} in ('backlog', 'issue', 'bounty') AND ${table.sourceProposalId} IS NULL AND ${table.sourceRevision} IS NULL) OR (${table.kind} in ('reprice', 'respec') AND ${table.sourceRevision} > 0)`,
    ),
    check(
      "bounty_run_respec_check",
      sql`(${table.kind} = 'respec') = (${table.respec} IS NOT NULL)`,
    ),
  ],
);

export const bountyProposal = pgTable(
  "bounty_proposal",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => bountyRun.id, { onDelete: "cascade" }),
    /** The bounty this prices. One live proposal per bounty. */
    bountyId: text("bounty_id")
      .notNull()
      .references(() => bounty.id, { onDelete: "cascade" }),
    specHash: text("spec_hash").notNull(),
    specHashVersion: integer("spec_hash_version").notNull().default(1),
    rateCard: jsonb("rate_card").$type<RateCardSnapshot>().notNull(),
    modelComplexity: text("model_complexity").notNull(),
    modelConfidence: text("model_confidence").notNull(),
    modelRationale: text("model_rationale").notNull(),
    unsizedReason: text("unsized_reason"),
    inputTruncated: boolean("input_truncated").notNull().default(false),
    actualModel: text("actual_model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    complexity: text("complexity").notNull(),
    sizedBy: text("sized_by").notNull().default("model"),
    resizedBy: text("resized_by").references(() => user.id, {
      onDelete: "set null",
    }),
    resizedAt: ts("resized_at"),
    amountMinor: safeMinor("amount_minor"),
    currency: text("currency"),
    status: text("status").notNull().default("proposed"),
    revision: integer("revision").notNull().default(1),
    // The `bounty_spec` revision this size goes with. Null for a proposal
    // with no spec: one from before specs, or a bounty nothing was drafted
    // from. A re-price moves it, or clears it when it drafts nothing.
    specRevision: integer("spec_revision"),
    // How the weight added to the spec since it was sized moved the size:
    // `complexity` is `step.complexity` when there is one. Stored as
    // computed, so the explanation is not recomputed against settings that
    // may have changed since. Null when there was nothing to step from: an
    // unsized bounty, no spec, or a spec drafted before weights.
    step: jsonb("step").$type<StepResult>(),
    stepVersion: text("step_version"),
    // The repository snapshot whose outline the spec was drafted beside.
    // Null when the bounty had no repository or it had no snapshot yet;
    // a pruned snapshot clears it rather than taking the proposal with it.
    repoSnapshotId: text("repo_snapshot_id").references(() => repoSnapshot.id, {
      onDelete: "set null",
    }),
    decidedBy: text("decided_by").references(() => user.id, {
      onDelete: "set null",
    }),
    decidedAt: ts("decided_at"),
    decisionDeliveryPolicy: text("decision_delivery_policy"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bounty_proposal_live_unique")
      .on(table.bountyId)
      .where(sql`${table.status} in ('proposed', 'approved')`),
    index("bounty_proposal_organization_id_idx").on(table.organizationId),
    index("bounty_proposal_bounty_id_idx").on(table.bountyId),
    index("bounty_proposal_run_id_idx").on(table.runId),
    // Pruning asks whether a snapshot is still referenced.
    index("bounty_proposal_repo_snapshot_id_idx").on(table.repoSnapshotId),
    check(
      "bounty_proposal_model_complexity_check",
      sql`${table.modelComplexity} in ('XS', 'S', 'M', 'L', 'XL', 'unsized')`,
    ),
    // The model answers whole sizes only; a half size is where the step
    // lands, so only the effective size may hold one.
    check(
      "bounty_proposal_complexity_check",
      sql`${table.complexity} in ('XS', 'XS+', 'S', 'S+', 'M', 'M+', 'L', 'L+', 'XL', 'unsized')`,
    ),
    check(
      "bounty_proposal_step_check",
      sql`(${table.step} IS NULL) = (${table.stepVersion} IS NULL)`,
    ),
    check(
      "bounty_proposal_confidence_check",
      sql`${table.modelConfidence} in ('low', 'medium', 'high')`,
    ),
    check(
      "bounty_proposal_status_check",
      sql`${table.status} in ('proposed', 'approved')`,
    ),
    check(
      "bounty_proposal_sized_by_check",
      sql`${table.sizedBy} in ('model', 'reviewer')`,
    ),
    check(
      "bounty_proposal_delivery_policy_check",
      sql`${table.decisionDeliveryPolicy} IS NULL OR ${table.decisionDeliveryPolicy} in ('off', 'requested')`,
    ),
    check("bounty_proposal_revision_check", sql`${table.revision} > 0`),
    check(
      "bounty_proposal_spec_revision_check",
      sql`${table.specRevision} IS NULL OR ${table.specRevision} > 0`,
    ),
    check(
      "bounty_proposal_hash_check",
      sql`length(${table.specHash}) = 64 AND ${table.specHashVersion} > 0`,
    ),
    check(
      "bounty_proposal_rationale_check",
      sql`length(${table.modelRationale}) between 1 and 500`,
    ),
    check(
      "bounty_proposal_money_check",
      sql`(${table.complexity} = 'unsized' AND ${table.amountMinor} IS NULL AND ${table.currency} IS NULL) OR (${table.complexity} <> 'unsized' AND ${table.amountMinor} IS NOT NULL AND ${table.amountMinor} > 0 AND ${table.amountMinor} <= 9007199254740991 AND ${table.currency} IS NOT NULL AND ${table.currency} ~ '^[A-Z]{3}$')`,
    ),
    check(
      "bounty_proposal_approved_sized_check",
      sql`${table.status} <> 'approved' OR (${table.complexity} <> 'unsized' AND NOT ${table.inputTruncated})`,
    ),
  ],
);

/** How a spec revision came to be. */
export const BOUNTY_SPEC_ORIGINS = [
  "draft",
  "expand",
  "trim",
  "answer",
] as const;
export type BountySpecOrigin = (typeof BOUNTY_SPEC_ORIGINS)[number];

/**
 * A proposal's spec, one row per revision: the bounty's behaviour as
 * scenarios, with the questions it left open.
 *
 * **This is text derived from a bounty, and it is kept.** It is private to
 * the organization, like the proposal it hangs from, and it goes when the
 * proposal does. A revision is never edited: a change is a new row, so what
 * a size was computed from stays readable after the spec has moved on.
 */
export const bountySpec = pgTable(
  "bounty_spec",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => bountyProposal.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    // The bounty this revision was drafted from, hashed as the proposal
    // hashes it, so a revision drafted from an older bounty can be told.
    specHash: text("spec_hash").notNull(),
    specHashVersion: integer("spec_hash_version").notNull(),
    draft: jsonb("draft").$type<SpecDraft>().notNull(),
    origin: text("origin").notNull(),
    // The reviewer's ask, for a revision that came from one.
    instruction: text("instruction"),
    // Null when a run drafted it rather than a person.
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    runId: text("run_id").references(() => bountyRun.id, {
      onDelete: "set null",
    }),
    actualModel: text("actual_model"),
    promptVersion: text("prompt_version"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("bounty_spec_proposal_revision_unique").on(
      table.proposalId,
      table.revision,
    ),
    index("bounty_spec_organization_id_idx").on(table.organizationId),
    check("bounty_spec_revision_check", sql`${table.revision} > 0`),
    check(
      "bounty_spec_origin_check",
      sql`${table.origin} in ('draft', 'expand', 'trim', 'answer')`,
    ),
    check(
      "bounty_spec_hash_check",
      sql`length(${table.specHash}) = 64 AND ${table.specHashVersion} > 0`,
    ),
  ],
);

/**
 * A proposal's complexity profile, one row per spec revision: the evidence
 * its price will point back to, measured from the bounty's repository.
 *
 * A row is asked for when a bounty is sized beside a snapshot, and a sweep
 * walks it through the scope agent and the slice the agent chose
 * (`apps/api/src/bounty/profiler.ts`). The runs are named here so what a
 * profile was measured from stays readable; a run or snapshot that is
 * later pruned leaves its column null and the profile as it was.
 */
export const bountyProfile = pgTable(
  "bounty_profile",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => bountyProposal.id, { onDelete: "cascade" }),
    specRevision: integer("spec_revision").notNull(),
    // The spec revision's own hash, which the scope run is keyed on.
    specHash: text("spec_hash").notNull(),
    snapshotId: text("snapshot_id").references(() => repoSnapshot.id, {
      onDelete: "set null",
    }),
    // What the bounty said about itself when it was sized; never re-read.
    bounty: jsonb("bounty").$type<ProfileBounty>().notNull(),
    status: text("status").$type<ProfileStatus>().notNull().default("queued"),
    errorCode: text("error_code").$type<ProfileErrorCode>(),
    runErrorCode: text("run_error_code").$type<AnalysisErrorCode>(),
    scopeRunId: text("scope_run_id").references(() => analysisRun.id, {
      onDelete: "set null",
    }),
    sliceRunId: text("slice_run_id").references(() => analysisRun.id, {
      onDelete: "set null",
    }),
    profile: jsonb("profile").$type<ComplexityProfile>(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("bounty_profile_proposal_revision_unique").on(
      table.proposalId,
      table.specRevision,
    ),
    index("bounty_profile_organization_id_idx").on(table.organizationId),
    // The sweep's discovery: rows still in flight, oldest first.
    index("bounty_profile_status_updated_at_idx").on(
      table.status,
      table.updatedAt,
    ),
    check(
      "bounty_profile_status_check",
      sql`${table.status} in ('queued', 'scoping', 'slicing', 'ready', 'failed')`,
    ),
    check(
      "bounty_profile_ready_check",
      sql`(${table.status} = 'ready') = (${table.profile} IS NOT NULL)`,
    ),
    check(
      "bounty_profile_failed_check",
      sql`(${table.status} = 'failed') = (${table.errorCode} IS NOT NULL)`,
    ),
    check("bounty_profile_revision_check", sql`${table.specRevision} > 0`),
  ],
);

export interface BountyWritebackPayload {
  readonly complexity: PricedComplexity;
  readonly amountMinor: number;
  readonly currency: string;
  readonly proposalUrl: string;
}

export const bountyWriteback = pgTable(
  "bounty_writeback",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => bountyProposal.id, { onDelete: "cascade" }),
    proposalRevision: integer("proposal_revision").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    step: text("step").notNull().default("comment"),
    payload: jsonb("payload").$type<BountyWritebackPayload>().notNull(),
    jiraCommentId: text("jira_comment_id"),
    errorCode: text("error_code"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: ts("lease_expires_at"),
    commentAttemptedAt: ts("comment_attempted_at"),
    requestedBy: text("requested_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("bounty_writeback_proposal_revision_kind_unique").on(
      table.proposalId,
      table.proposalRevision,
      table.kind,
    ),
    uniqueIndex("bounty_writeback_proposal_running_unique")
      .on(table.proposalId)
      .where(sql`${table.status} = 'running'`),
    index("bounty_writeback_organization_id_idx").on(table.organizationId),
    check(
      "bounty_writeback_kind_check",
      sql`${table.kind} in ('approved', 'withdrawn')`,
    ),
    check(
      "bounty_writeback_status_check",
      sql`${table.status} in ('pending', 'running', 'done', 'failed', 'uncertain', 'cancelled')`,
    ),
    check(
      "bounty_writeback_step_check",
      sql`${table.step} in ('comment', 'label')`,
    ),
  ],
);

export type RateCardRow = typeof rateCard.$inferSelect;
export type NewRateCardRow = typeof rateCard.$inferInsert;
export type BountyRunRow = typeof bountyRun.$inferSelect;
export type NewBountyRunRow = typeof bountyRun.$inferInsert;
export type BountyProposalRow = typeof bountyProposal.$inferSelect;
export type NewBountyProposalRow = typeof bountyProposal.$inferInsert;
export type BountySpecRow = typeof bountySpec.$inferSelect;
export type NewBountySpecRow = typeof bountySpec.$inferInsert;
export type BountyWritebackRow = typeof bountyWriteback.$inferSelect;
export type NewBountyWritebackRow = typeof bountyWriteback.$inferInsert;
export type BountyProfileRow = typeof bountyProfile.$inferSelect;
export type NewBountyProfileRow = typeof bountyProfile.$inferInsert;
