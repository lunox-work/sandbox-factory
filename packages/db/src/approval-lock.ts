/**
 * A bounty's approval and its sandbox's publication stack: a sandbox is
 * published only over an approved proposal, and the proposal is not taken
 * back from approved while its sandbox is published.
 *
 * Both sides hold the proposal's row lock before reading the other side, so
 * the two can never both go through: whichever locks second waits, and then
 * reads what the first committed. Publishing takes a share lock, so two
 * publishes do not wait on each other; taking the approval back takes the
 * update lock its own write would.
 */

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { QueryExecutor } from "./errors.js";
import { bountyProposal, sandbox } from "./schema.js";

/**
 * Share-locks the bounty's approved proposal, for a publish to stand on.
 * False when the bounty has none: it is not approved, so nothing of it may
 * be published.
 */
export async function lockApproval(
  tx: QueryExecutor,
  organizationId: string,
  bountyId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: bountyProposal.id })
    .from(bountyProposal)
    .where(
      and(
        eq(bountyProposal.organizationId, organizationId),
        eq(bountyProposal.bountyId, bountyId),
        eq(bountyProposal.status, "approved"),
      ),
    )
    .for("share");
  return rows[0] !== undefined;
}

/**
 * Whether the bounty's sandbox is published, and its publication has not
 * lapsed. Read after the proposal is locked, so a publish in flight is
 * waited for rather than missed.
 */
export async function sandboxPublished(
  tx: QueryExecutor,
  organizationId: string,
  bountyId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: sandbox.id })
    .from(sandbox)
    .where(
      and(
        eq(sandbox.organizationId, organizationId),
        eq(sandbox.bountyId, bountyId),
        eq(sandbox.status, "published"),
        or(isNull(sandbox.expiresAt), gt(sandbox.expiresAt, sql`now()`)),
      ),
    )
    .limit(1);
  return rows[0] !== undefined;
}

/**
 * Update-locks the proposal, as taking back its approval is about to, and
 * says whether its bounty's sandbox is published, which refuses that. False
 * for a proposal not found: the write that follows reports it.
 */
export async function approvalPublished(
  tx: QueryExecutor,
  organizationId: string,
  proposalId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ bountyId: bountyProposal.bountyId })
    .from(bountyProposal)
    .where(
      and(
        eq(bountyProposal.organizationId, organizationId),
        eq(bountyProposal.id, proposalId),
      ),
    )
    .for("update");
  const locked = rows[0];
  return (
    locked !== undefined &&
    (await sandboxPublished(tx, organizationId, locked.bountyId))
  );
}
