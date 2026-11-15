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
  BountyRunModelCall,
  BountyRunOutcome,
  BountyRunProgress,
  BountyRunPlannedIssue,
  BountySelection,
  ComplexityProfile,
  ProfileErrorCode,
  ProfileStatus,
  ProfileTransitionTime,
  RateCardSnapshot,
  PricedComplexity,
  RespecRequest,
  RubricAssessment,
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
    /**
     * What a run sizing one bounty has made so far: the spec and the size,
     * each written as its model call returns, so a page following the run
     * shows them before the proposal is written. Null until the first
     * returns, and on a board's runs, which write none.
     */
    progress: jsonb("progress").$type<BountyRunProgress>(),
    /**
     * Every model call the run made, in the order they started, written
     * once when it ends: how long each took and whether it fell back.
     * Empty for a run that made none, or ended before this was kept.
     */
    modelCalls: jsonb("model_calls")
      .$type<BountyRunModelCall[]>()
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
    /**
     * When the run wrote its proposal, or re-priced one, in the write's
     * transaction: the end of its price (`flow_wait_sample`). Kept on the
     * run because the proposal is not the run's alone: a re-price moves
     * its `run_id` and keeps its `created_at`. Null for a run that wrote
     * none, and for runs that ended before this was kept.
     */
    proposalWrittenAt: ts("proposal_written_at"),
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

/** A repository a proposal's work touches, at the snapshot it was sized beside. */
export interface ProposalRepository {
  readonly repoId: string;
  readonly snapshotId: string;
}

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
    // The version people see: how many times what it says has been
    // approved. Unlike `revision`, which every write moves and every
    // write is checked against, it moves only on an approval of something
    // changed since the last one, so an approval withdrawn and given again
    // is the same version. 0 until it is first approved.
    version: integer("version").notNull().default(0),
    // When the current version was approved.
    versionedAt: ts("versioned_at"),
    // The `revision` with nothing changed since the current version: the
    // approval's own, moved on by a withdrawal and by nothing else. An
    // approval from any other revision is of something new.
    versionRevision: integer("version_revision"),
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
    // The pricing rubric's assessment of the spec and the measured code.
    // When `sized_by` is `rubric`, `complexity` is its size. Stored as
    // computed, like the step. Null without a spec, or from before the
    // rubric.
    rubric: jsonb("rubric").$type<RubricAssessment>(),
    // The workspace's repositories the drafting model said the work
    // touches, each with the snapshot whose outline the spec was drafted
    // beside: what the code is profiled in and the sandbox is cut from.
    // Empty when it touches none, or no repository had a snapshot. A
    // bounty names no repository, so this is the sizing's to say; a
    // re-price says it again, and a spec change keeps it. Not keys: a
    // repository removed since is left for its readers to pass over.
    repositories: jsonb("repositories")
      .$type<ProposalRepository[]>()
      .notNull()
      .default([]),
    // The bounty's synced context versions (`bounty_context`) it was sized
    // with, one per source; null for a source that had none.
    jiraContextVersion: integer("jira_context_version"),
    githubContextVersion: integer("github_context_version"),
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
    index("bounty_proposal_repositories_idx").using("gin", table.repositories),
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
      sql`${table.sizedBy} in ('model', 'rubric', 'reviewer')`,
    ),
    // A size the rubric set is one it can show its working for.
    check(
      "bounty_proposal_rubric_check",
      sql`${table.sizedBy} <> 'rubric' or ${table.rubric} IS NOT NULL`,
    ),
    check(
      "bounty_proposal_delivery_policy_check",
      sql`${table.decisionDeliveryPolicy} IS NULL OR ${table.decisionDeliveryPolicy} in ('off', 'requested')`,
    ),
    check("bounty_proposal_revision_check", sql`${table.revision} > 0`),
    check(
      "bounty_proposal_version_check",
      sql`(${table.version} = 0 AND ${table.versionedAt} IS NULL AND ${table.versionRevision} IS NULL) OR (${table.version} > 0 AND ${table.versionedAt} IS NOT NULL AND ${table.versionRevision} > 0)`,
    ),
    // An approved proposal is a version.
    check(
      "bounty_proposal_approved_version_check",
      sql`${table.status} <> 'approved' OR ${table.version} > 0`,
    ),
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

/**
 * A reviewer's resize, kept as a human label for calibrating sizing: the
 * size and price the proposal had before (`from*`, and who had set it),
 * what the model and the rubric said then, and the size the reviewer chose.
 * Appended in the transaction that resizes (`BountyProposalStore.resize`),
 * never changed after; a resize undone (`applyRubric`) leaves its label.
 * Read on the owner's proposal detail only (`sizeLabels`).
 */
export const proposalSizeLabel = pgTable(
  "proposal_size_label",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => bountyProposal.id, { onDelete: "cascade" }),
    /** The proposal revision the reviewer resized, and its spec revision. */
    proposalRevision: integer("proposal_revision").notNull(),
    specRevision: integer("spec_revision"),
    modelComplexity: text("model_complexity").notNull(),
    modelConfidence: text("model_confidence").notNull(),
    /** The rubric's band then, null without one; its whole assessment too. */
    rubricComplexity: text("rubric_complexity"),
    rubric: jsonb("rubric").$type<RubricAssessment>(),
    fromComplexity: text("from_complexity").notNull(),
    fromSizedBy: text("from_sized_by").notNull(),
    fromAmountMinor: safeMinor("from_amount_minor"),
    /** What the resize came to: the reviewer's size (or its step's). */
    complexity: text("complexity").notNull(),
    amountMinor: safeMinor("amount_minor").notNull(),
    currency: text("currency").notNull(),
    resizedBy: text("resized_by").references(() => user.id, {
      onDelete: "set null",
    }),
    resizedAt: ts("resized_at").notNull().defaultNow(),
  },
  (table) => [
    index("proposal_size_label_organization_id_idx").on(table.organizationId),
    index("proposal_size_label_proposal_id_idx").on(table.proposalId),
    check(
      "proposal_size_label_from_sized_by_check",
      sql`${table.fromSizedBy} in ('model', 'rubric', 'reviewer')`,
    ),
    check(
      "proposal_size_label_revision_check",
      sql`${table.proposalRevision} > 0 AND (${table.specRevision} IS NULL OR ${table.specRevision} > 0)`,
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
    // Where a revision written outside the platform came from, as
    // `duediligence@0.5.1` for the spec posted with its bounty. Null for
    // one a run drafted or a reviewer's request changed.
    source: text("source"),
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
 * A spec posted with its bounty (`POST …/bounties` with `spec`), kept until
 * a sizing run takes it as the proposal's first revision instead of
 * drafting one: the document as posted, the spec read from it, and who
 * confirmed its decisions where it was written. Sizing takes it only while
 * the bounty still hashes to `spec_hash`; an edited bounty is drafted from
 * its text again. Private to the organization, like the bounty.
 */
export const bountyPostedSpec = pgTable(
  "bounty_posted_spec",
  {
    bountyId: text("bounty_id")
      .primaryKey()
      .references(() => bounty.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    document: text("document").notNull(),
    draft: jsonb("draft").$type<SpecDraft>().notNull(),
    // `duediligence@<version>`: the engine that wrote it.
    source: text("source").notNull(),
    // The bounty's title and text when it was posted, hashed as a proposal
    // hashes them.
    specHash: text("spec_hash").notNull(),
    specHashVersion: integer("spec_hash_version").notNull(),
    // The person who posted it as confirmed; null when its decisions were
    // posted unconfirmed, or that person was removed.
    confirmedBy: text("confirmed_by").references(() => user.id, {
      onDelete: "set null",
    }),
    // The credential that posted it as confirmed: a session, or a token or
    // OAuth grant acting as its person; null when posted unconfirmed.
    confirmedCredential: text("confirmed_credential"),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("bounty_posted_spec_organization_id_idx").on(table.organizationId),
    check(
      "bounty_posted_spec_confirmed_credential_check",
      sql`${table.confirmedCredential} IS NULL OR ${table.confirmedCredential} in ('session', 'token', 'oauth')`,
    ),
    check(
      "bounty_posted_spec_hash_check",
      sql`length(${table.specHash}) = 64 AND ${table.specHashVersion} > 0`,
    ),
  ],
);

/**
 * A person's confirmation of one spec revision's decisions (its
 * assumptions, `specDecisions`): the hash of exactly the decisions they
 * read. One per revision; a new revision needs its own. Made in the web
 * app, or (`via` duediligence) by the person who posted the spec as
 * confirmed with its bounty, recorded when sizing stores it.
 */
export const decisionConfirmation = pgTable(
  "decision_confirmation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => bountyProposal.id, { onDelete: "cascade" }),
    specRevision: integer("spec_revision").notNull(),
    decisionsSha256: text("decisions_sha256").notNull(),
    confirmedBy: text("confirmed_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Null for a confirmation on the Price step; `duediligence` for one
    // posted with the spec.
    via: text("via"),
    // The credential it was made with (`session`, `token`, `oauth`); null
    // for one recorded before it was kept.
    credential: text("credential"),
    confirmedAt: ts("confirmed_at").notNull().defaultNow(),
  },
  (table) => [
    unique("decision_confirmation_proposal_revision_unique").on(
      table.proposalId,
      table.specRevision,
    ),
    index("decision_confirmation_organization_id_idx").on(table.organizationId),
    check(
      "decision_confirmation_via_check",
      sql`${table.via} IS NULL OR ${table.via} in ('duediligence')`,
    ),
    check(
      "decision_confirmation_credential_check",
      sql`${table.credential} IS NULL OR ${table.credential} in ('session', 'token', 'oauth')`,
    ),
    check(
      "decision_confirmation_sha256_check",
      sql`length(${table.decisionsSha256}) = 64 AND ${table.specRevision} > 0`,
    ),
  ],
);

/**
 * A proposal's complexity profile, one row per spec revision and snapshot:
 * the evidence its price will point back to, measured in each repository
 * its work touches.
 *
 * A row is asked for each snapshot a bounty is sized beside, and a sweep
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
    status: text("status").$type<ProfileStatus>().notNull().default("queued"),
    errorCode: text("error_code").$type<ProfileErrorCode>(),
    runErrorCode: text("run_error_code").$type<AnalysisErrorCode>(),
    scopeRunId: text("scope_run_id").references(() => analysisRun.id, {
      onDelete: "set null",
    }),
    sliceRunId: text("slice_run_id").references(() => analysisRun.id, {
      onDelete: "set null",
    }),
    // The sandbox's preparation: a fixtures run on the slice that also
    // writes the name table, queued once the profile is ready and its price
    // approved, so a Sandbox click finds both written.
    preparedRunId: text("prepared_run_id").references(() => analysisRun.id, {
      onDelete: "set null",
    }),
    profile: jsonb("profile").$type<ComplexityProfile>(),
    // Who approved its slice, and when, for one wider than the profiler
    // cuts unasked (`AUTO_SLICE_LIMITS`); null for one within them. Such a
    // profile is measured all the same, `awaiting_approval` until then, so
    // its price does not wait; nothing is cut or prepared from it before.
    sliceApprovedBy: text("slice_approved_by").references(() => user.id, {
      onDelete: "set null",
    }),
    sliceApprovedAt: ts("slice_approved_at"),
    // Each status the row has moved to, with when, oldest first. `queued`
    // is `created_at`; empty for a row that moved before this was kept.
    transitions: jsonb("transitions")
      .$type<ProfileTransitionTime[]>()
      .notNull()
      .default([]),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // One per repository the spec revision's work touches, by the snapshot
    // it was drafted beside.
    unique("bounty_profile_proposal_revision_snapshot_unique").on(
      table.proposalId,
      table.specRevision,
      table.snapshotId,
    ),
    index("bounty_profile_organization_id_idx").on(table.organizationId),
    // The sweep's discovery: rows still in flight, oldest first.
    index("bounty_profile_status_updated_at_idx").on(
      table.status,
      table.updatedAt,
    ),
    check(
      "bounty_profile_status_check",
      sql`${table.status} in ('queued', 'scoping', 'slicing', 'awaiting_approval', 'ready', 'failed')`,
    ),
    // Measured: ready, or measured and awaiting its slice's approval.
    check(
      "bounty_profile_ready_check",
      sql`(${table.status} in ('awaiting_approval', 'ready')) = (${table.profile} IS NOT NULL)`,
    ),
    check(
      "bounty_profile_failed_check",
      sql`(${table.status} = 'failed') = (${table.errorCode} IS NOT NULL)`,
    ),
    check("bounty_profile_revision_check", sql`${table.specRevision} > 0`),
  ],
);

/**
 * A workspace's settings, one row per organization, written the first time
 * one is changed: an organization with none has every default.
 */
export const workspaceSetting = pgTable("workspace_setting", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  // Whether an approved bounty's sandbox is prepared before anyone asks
  // for it: model spend for a shorter wait.
  prepareSandboxes: boolean("prepare_sandboxes").notNull().default(true),
  updatedBy: text("updated_by").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

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
export type BountyPostedSpecRow = typeof bountyPostedSpec.$inferSelect;
export type NewBountySpecRow = typeof bountySpec.$inferInsert;
export type BountyWritebackRow = typeof bountyWriteback.$inferSelect;
export type NewBountyWritebackRow = typeof bountyWriteback.$inferInsert;
export type BountyProfileRow = typeof bountyProfile.$inferSelect;
export type WorkspaceSettingRow = typeof workspaceSetting.$inferSelect;
export type NewBountyProfileRow = typeof bountyProfile.$inferInsert;
