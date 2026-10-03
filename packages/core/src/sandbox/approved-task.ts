/**
 * The approved task a sandbox version is built for, frozen at selection.
 *
 * A proposal is live: it can be repriced, its spec changed, or it can be
 * deleted. A version must not move with it, so the selected spec content,
 * the price at selection and the approval evidence are copied into one
 * private artifact and named by their hash (`approvedTaskSha256`). The live
 * rows are not its source of truth afterwards, and the ticket's own
 * pricing-freshness hash (`specHash`) is deliberately not reused: it hashes
 * a ticket, not the build inputs.
 *
 * Nothing here is public. The listing's title and summary are separately
 * reviewed derivatives written after aliasing.
 */

import type { SpecDraft } from "../pricing/spec.js";
import type { BountyComplexity } from "../bounty.js";

/**
 * Version 2 links the sandbox's tickets (`ticketIds`). Version 1 linked
 * Jira issue pointers (`jiraIssueIds`) and is still read, never written: a
 * stored snapshot is named by its hash, so it stays exactly as it was.
 */
export const APPROVED_TASK_SCHEMA_VERSION = 2;

export interface ApprovedTaskSpec {
  readonly proposalId: string;
  readonly specRevision: number;
  /** The ticket's pricing-freshness hash, kept for the record only. */
  readonly specHash: string;
  readonly draft: SpecDraft;
}

export interface ApprovedTaskPricing {
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly complexity: BountyComplexity;
  readonly amountMinor: number | null;
  /** ISO 4217. */
  readonly currency: string | null;
  readonly status: string;
  readonly decidedAt: string | null;
}

interface ApprovedTaskSelection {
  /** The private working title and summary at selection. */
  readonly title: string;
  readonly summary: string;
  readonly spec: ApprovedTaskSpec | null;
  readonly pricing: ApprovedTaskPricing | null;
  readonly selectedBy: string;
  readonly selectedAt: string;
}

/** What a version is frozen with now. */
export interface ApprovedTaskSnapshot extends ApprovedTaskSelection {
  readonly schemaVersion: typeof APPROVED_TASK_SCHEMA_VERSION;
  /** The tickets the sandbox is linked to, by id; never their text. */
  readonly ticketIds: readonly string[];
}

/** What a version frozen before tickets holds. Read, never written. */
export interface LegacyApprovedTaskSnapshot extends ApprovedTaskSelection {
  readonly schemaVersion: 1;
  /** Jira issue pointer ids the sandbox was linked to. */
  readonly jiraIssueIds: readonly string[];
}

/** Any snapshot a stored version can hold. */
export type StoredApprovedTaskSnapshot =
  ApprovedTaskSnapshot | LegacyApprovedTaskSnapshot;

/** Which selections are complete enough to build for. */
export function approvedTaskReadiness(snapshot: StoredApprovedTaskSnapshot): {
  ready: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (snapshot.title.trim() === "") reasons.push("The task has no title.");
  if (snapshot.summary.trim() === "") reasons.push("The task has no summary.");
  if (snapshot.spec === null)
    reasons.push("No spec revision was selected for the task.");
  else if (
    snapshot.spec.draft.scenarios.length === 0 &&
    snapshot.spec.draft.openQuestions.length === 0
  )
    reasons.push("The selected spec has neither scenarios nor questions.");
  if (snapshot.pricing !== null && snapshot.pricing.status !== "approved")
    reasons.push(
      `The originating proposal is ${snapshot.pricing.status}, not approved.`,
    );
  return { ready: reasons.length === 0, reasons };
}
