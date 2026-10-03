/**
 * The ticket an agent run works for, read owner-scoped: the proposal for
 * its issue key, and one immutable revision of its spec.
 */

import type { BountyProposalStore, BountySpecStore } from "@sandbox-factory/db";
import type { AgentTask } from "./tools/adapter.js";

export function createTaskReader(
  proposals: Pick<BountyProposalStore, "get">,
  specs: Pick<BountySpecStore, "get">,
): {
  get(
    organizationId: string,
    proposalId: string,
    specRevision: number,
  ): Promise<AgentTask | null>;
} {
  return {
    async get(organizationId, proposalId, specRevision) {
      const proposal = await proposals.get(organizationId, proposalId);
      if (proposal === null) return null;
      const spec = await specs.get(organizationId, proposalId, specRevision);
      if (spec === null) return null;
      return {
        issueKey: proposal.issueKey,
        specRevision: spec.revision,
        specHash: spec.specHash,
        draft: spec.draft,
      };
    },
  };
}
