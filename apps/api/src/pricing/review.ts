import {
  followsJira,
  type BountyProposalStore,
  type JiraBoardStore,
  type JiraIssueStore,
  type StoredBountyProposal,
  type StoredBounty,
  type BountyStore,
} from "@sandbox-factory/db";
import { JiraApiError, JiraAuthError } from "@sandbox-factory/jira";
import type {
  ProposalFreshnessDto,
  ProposalLiveSpecDto,
} from "@sandbox-factory/shared";
import { BOUNTY_SPEC_HASH_VERSION, bountySpecHash } from "sandbox-factory";

import type { RunClientResult } from "./executor.js";

export type FreshProposal = ProposalFreshnessDto & {
  readonly proposal: StoredBountyProposal;
  readonly liveSpec?: ProposalLiveSpecDto;
};

export interface ProposalReviewOptions {
  readonly proposals: BountyProposalStore;
  readonly issues: JiraIssueStore;
  readonly bounties: BountyStore;
  readonly boards: JiraBoardStore;
  /**
   * A Jira site's client, for a bounty still following its issue. Where
   * Jira is not configured it answers `reconnect`, and where it is absent
   * the same is assumed: such a bounty's freshness is then unknown, and
   * every other bounty's is read as stored.
   */
  readonly clientFor?: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  readonly now?: () => Date;
}

/**
 * Whether a proposal was priced from what its bounty says now.
 *
 * A bounty following a Jira issue is read from Jira, and the bounty takes
 * what was read, as it does whenever the issue is read. Any other bounty is
 * compared as it is stored: one written here, or one whose issue Jira no
 * longer has, which keeps the text it last had.
 */
export async function freshProposal(
  options: ProposalReviewOptions,
  organizationId: string,
  proposal: StoredBountyProposal,
): Promise<FreshProposal> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const bounty = await options.bounties.get(organizationId, proposal.bountyId);
  if (bounty === null) {
    return { proposal, freshness: "missing", checkedAt, code: "not_found" };
  }
  if (bounty.jira !== null && followsJira(bounty)) {
    const registered = await options.boards.forRun(
      organizationId,
      bounty.jira.boardId,
    );
    const ready: RunClientResult =
      registered === null
        ? { ok: false, reason: "not-found" }
        : options.clientFor === undefined
          ? { ok: false, reason: "reconnect" }
          : await options.clientFor(organizationId, registered.connectionId);
    if (!ready.ok || registered === null) {
      return {
        proposal,
        freshness: "unknown",
        checkedAt,
        // On the wire as every other code is, in snake case.
        code:
          ready.ok || ready.reason === "not-found" ? "not_found" : ready.reason,
      };
    }
    try {
      const spec = await ready.client.issueSpec(bounty.jira.externalId);
      await options.bounties
        .refreshFromJira(organizationId, bounty.id, {
          title: spec.summary,
          description: spec.descriptionText,
          issueType: spec.issueType,
          priority: spec.priority,
          labels: spec.labels,
          components: spec.components,
          inputTruncated: spec.inputTruncated,
        })
        // The review answers with what Jira said; keeping a copy is not
        // what it is for, and the next read writes it again.
        .catch(() => false);
      const liveUrl = `${registered.siteUrl}/browse/${encodeURIComponent(spec.key)}`;
      return compared(proposal, checkedAt, spec.pricingSpecHash, {
        summary: spec.summary,
        descriptionText: spec.descriptionText,
        issueType: spec.issueType,
        key: spec.key,
        url: liveUrl,
        inputTruncated: spec.inputTruncated,
      });
    } catch (error) {
      if (!(error instanceof JiraApiError && error.isNotFound)) {
        return {
          proposal,
          freshness: "unknown",
          checkedAt,
          code: reviewFailureCode(error),
        };
      }
      // Gone from Jira: the bounty keeps what it said, and is read so. Why
      // the stored text is stale, when it is, says more than where it is.
      await options.issues.markRemoved(organizationId, bounty.jira.issueId);
      const stored = await storedFreshness(proposal, checkedAt, bounty);
      return { ...stored, code: stored.code ?? "jira_removed" };
    }
  }
  return storedFreshness(proposal, checkedAt, bounty);
}

async function storedFreshness(
  proposal: StoredBountyProposal,
  checkedAt: string,
  bounty: StoredBounty,
): Promise<FreshProposal> {
  return compared(
    proposal,
    checkedAt,
    await bountySpecHash(bounty.title, bounty.description, bounty.issueType),
    {
      summary: bounty.title,
      descriptionText: bounty.description,
      issueType: bounty.issueType,
      key: bounty.key,
      url: null,
      inputTruncated: bounty.inputTruncated,
    },
  );
}

function compared(
  proposal: StoredBountyProposal,
  checkedAt: string,
  liveHash: string,
  liveSpec: ProposalLiveSpecDto,
): FreshProposal {
  const common = {
    proposal,
    checkedAt,
    liveTitle: liveSpec.summary,
    liveKey: liveSpec.key,
    ...(liveSpec.url === null ? {} : { liveUrl: liveSpec.url }),
    liveSpec,
  };
  if (proposal.specHashVersion !== BOUNTY_SPEC_HASH_VERSION) {
    return { ...common, freshness: "stale", code: "hash_version" };
  }
  return {
    ...common,
    freshness: liveHash === proposal.specHash ? "current" : "stale",
    ...(liveSpec.inputTruncated ? { code: "spec_too_large" } : {}),
  };
}

/**
 * One line of the titles stream: a proposal's live title, or why there is
 * none. `not_found` is a proposal that is not on the board asked about;
 * `missing` is a bounty Jira no longer has.
 */
export type ProposalTitleLine =
  | { readonly id: string; readonly key: string; readonly title: string }
  | {
      readonly id: string;
      readonly code:
        "not_found" | "missing" | "reconnect" | "scope" | "unavailable";
    };

/**
 * A proposal's live title, read without the bounty's description.
 *
 * Never throws: whatever goes wrong becomes this row's code, so one bounty
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
      // As the freshness check does, so a deleted bounty stops being
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
