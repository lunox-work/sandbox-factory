/** Commercial records produced from Jira issue pointers. */

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
  BountyRunOutcome,
  BountySelection,
  RateCardSnapshot,
  PricedComplexity,
} from "sandbox-factory";

import { user } from "./auth.js";
import { jiraBoard, jiraIssue } from "./jira.js";
import { organization } from "./organizations.js";

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
    boardId: text("board_id")
      .notNull()
      .references(() => jiraBoard.id, { onDelete: "cascade" }),
    startedBy: text("started_by").references(() => user.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull().default("backlog"),
    sourceProposalId: text("source_proposal_id").references(
      (): AnyPgColumn => bountyProposal.id,
      { onDelete: "set null" },
    ),
    sourceRevision: integer("source_revision"),
    requestId: text("request_id").notNull(),
    status: text("status").notNull().default("queued"),
    selection: jsonb("selection").$type<BountySelection>().notNull(),
    rateCard: jsonb("rate_card").$type<RateCardSnapshot>().notNull(),
    requestedModel: text("requested_model").notNull(),
    promptVersion: text("prompt_version").notNull(),
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
      .where(sql`${table.status} in ('queued', 'running')`),
    index("bounty_run_organization_id_idx").on(table.organizationId),
    index("bounty_run_board_created_idx").on(table.boardId, table.createdAt),
    check(
      "bounty_run_kind_check",
      sql`${table.kind} in ('backlog', 'reprice')`,
    ),
    check(
      "bounty_run_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'partial', 'failed')`,
    ),
    check(
      "bounty_run_source_check",
      sql`(${table.kind} = 'backlog' AND ${table.sourceProposalId} IS NULL AND ${table.sourceRevision} IS NULL) OR (${table.kind} = 'reprice' AND ${table.sourceProposalId} IS NOT NULL AND ${table.sourceRevision} > 0)`,
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
    jiraIssueId: text("jira_issue_id")
      .notNull()
      .references(() => jiraIssue.id, { onDelete: "cascade" }),
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
      .on(table.jiraIssueId)
      .where(sql`${table.status} in ('proposed', 'approved')`),
    index("bounty_proposal_organization_id_idx").on(table.organizationId),
    index("bounty_proposal_run_id_idx").on(table.runId),
    check(
      "bounty_proposal_model_complexity_check",
      sql`${table.modelComplexity} in ('XS', 'S', 'M', 'L', 'XL', 'unsized')`,
    ),
    check(
      "bounty_proposal_complexity_check",
      sql`${table.complexity} in ('XS', 'S', 'M', 'L', 'XL', 'unsized')`,
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
export type BountyWritebackRow = typeof bountyWriteback.$inferSelect;
export type NewBountyWritebackRow = typeof bountyWriteback.$inferInsert;
