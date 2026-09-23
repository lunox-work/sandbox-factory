import type {
  BountyProposalStore,
  JiraBoardStore,
  JiraIssueStore,
  StoredBountyProposal,
} from "@sandbox-factory/db";
import { JiraApiError, JiraAuthError } from "@sandbox-factory/jira";
import type {
  ProposalFreshnessDto,
  ProposalLiveSpecDto,
} from "@sandbox-factory/shared";

import type { RunClientResult } from "./executor.js";

export type FreshProposal = ProposalFreshnessDto & {
  readonly proposal: StoredBountyProposal;
  readonly liveSpec?: ProposalLiveSpecDto;
};

export interface ProposalReviewOptions {
  readonly proposals: BountyProposalStore;
  readonly issues: JiraIssueStore;
  readonly boards: JiraBoardStore;
  readonly clientFor: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  readonly now?: () => Date;
}

/** Reads a proposal's current Jira sizing inputs and discards them after hashing. */
export async function freshProposal(
  options: ProposalReviewOptions,
  organizationId: string,
  proposal: StoredBountyProposal,
): Promise<FreshProposal> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const pointer = await options.issues.get(
    organizationId,
    proposal.jiraIssueId,
  );
  if (pointer === null) {
    return { proposal, freshness: "missing", checkedAt, code: "not_found" };
  }
  const registered = await options.boards.forRun(
    organizationId,
    pointer.boardId,
  );
  if (registered === null) {
    return { proposal, freshness: "missing", checkedAt, code: "not_found" };
  }
  const ready = await options.clientFor(
    organizationId,
    registered.connectionId,
  );
  if (!ready.ok) {
    return { proposal, freshness: "unknown", checkedAt, code: ready.reason };
  }
  try {
    const spec = await ready.client.issueSpec(pointer.externalId);
    const liveUrl = `${registered.siteUrl}/browse/${encodeURIComponent(spec.key)}`;
    const common = {
      proposal,
      checkedAt,
      liveTitle: spec.summary,
      liveKey: spec.key,
      liveUrl,
      liveSpec: {
        summary: spec.summary,
        descriptionText: spec.descriptionText,
        issueType: spec.issueType,
        key: spec.key,
        url: liveUrl,
        inputTruncated: spec.inputTruncated,
      },
    };
    if (proposal.specHashVersion !== 1) {
      return { ...common, freshness: "stale", code: "hash_version" };
    }
    return {
      ...common,
      freshness:
        spec.pricingSpecHash === proposal.specHash ? "current" : "stale",
      ...(spec.inputTruncated ? { code: "spec_too_large" } : {}),
    };
  } catch (error) {
    if (error instanceof JiraApiError && error.isNotFound) {
      await options.issues.markRemoved(organizationId, proposal.jiraIssueId);
      return {
        proposal,
        freshness: "missing",
        checkedAt,
        code: "spec_unavailable",
      };
    }
    return {
      proposal,
      freshness: "unknown",
      checkedAt,
      code: reviewFailureCode(error),
    };
  }
}

function reviewFailureCode(error: unknown): string {
  if (error instanceof JiraAuthError && error.needsReconnect)
    return "reconnect";
  if (error instanceof JiraApiError) {
    if (error.isUnauthorized) return "reconnect";
    if (error.isForbidden) return "scope";
  }
  return "spec_unavailable";
}

/** Runs at most `concurrency` live Jira reads at once. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await work(value);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
  return results;
}
