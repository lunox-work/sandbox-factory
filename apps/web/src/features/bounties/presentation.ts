import type { BountyProposalDto } from "@sandbox-factory/shared";
export function capitalize(value: string): string {
  return value === "" ? value : value[0]!.toUpperCase() + value.slice(1);
}

/**
 * A size with no step behind it: its spec was drafted before scenarios
 * were weighed, or it has none. A scenario added later cannot move it until
 * the proposal is re-analyzed. An unsized proposal has no size to move.
 */
export function unweighed(
  proposal: Pick<BountyProposalDto, "complexity" | "step">,
) {
  // `?? null`: a row from an API that predates steps carries none at all.
  return proposal.complexity !== "unsized" && (proposal.step ?? null) === null;
}

/**
 * The open proposal, in three tabs.
 *
 * Bounty is the decision — one card of what the proposal is, with each
 * action beside the fact it changes (for those who may act), the model's
 * reasoning as prose, and where delivery to Jira stands. Scenarios is what
 * the ticket was taken to ask for when it was sized, with the count in the
 * tab once it is known. Spec is the ticket itself, read live, so the
 * decision is made against what Jira says now rather than what was stored
 * at sizing time.
 *
 * Two states. Proposed: Re-analyze (the re-price) beside the status, the
 * resize as the size itself level with the amount, and Approve after the
 * reasoning with Remove under it. Approved: Re-analyze beside the status
 * and Unapprove after the reasoning —
 * removal comes after unapproving, because that is what owes Jira the
 * withdrawal. Approve needs a current ticket; a resize, a re-price and an
 * unapprove do not.
 */
