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

/**
 * One line of the titles stream: a proposal's live title, or why there is
 * none. `not_found` is a proposal that is not on the board asked about;
 * `missing` is a ticket Jira no longer has.
 */
export type ProposalTitleLine =
  | { readonly id: string; readonly key: string; readonly title: string }
  | {
      readonly id: string;
      readonly code:
        "not_found" | "missing" | "reconnect" | "scope" | "unavailable";
    };

/**
 * A proposal's live title, read without the ticket's description.
 *
 * Never throws: whatever goes wrong becomes this row's code, so one ticket
 * cannot end the stream for the rest. The client is resolved once per board
 * by the caller, since every row on a board shares its connection.
 */
export async function proposalTitle(
  issues: Pick<JiraIssueStore, "markRemoved">,
  organizationId: string,
  proposalId: string,
  target:
    { readonly jiraIssueId: string; readonly externalId: string } | undefined,
  ready: RunClientResult,
): Promise<ProposalTitleLine> {
  const id = proposalId;
  if (target === undefined) return { id, code: "not_found" };
  if (!ready.ok) {
    return {
      id,
      code: ready.reason === "reconnect" ? "reconnect" : "unavailable",
    };
  }
  try {
    const issue = await ready.client.issue(target.externalId);
    return { id, key: issue.key, title: issue.summary };
  } catch (error) {
    if (error instanceof JiraApiError && error.isNotFound) {
      // As the freshness check does, so a deleted ticket stops being
      // offered for sizing. The row still says why it has no title.
      await issues
        .markRemoved(organizationId, target.jiraIssueId)
        .catch(() => false);
      return { id, code: "missing" };
    }
    const code = reviewFailureCode(error);
    return { id, code: code === "spec_unavailable" ? "unavailable" : code };
  }
}

function reviewFailureCode(
  error: unknown,
): "reconnect" | "scope" | "spec_unavailable" {
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
