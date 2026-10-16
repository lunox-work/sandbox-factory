import {
  textFollowsJira,
  type BountyProposalStore,
  type JiraBoardStore,
  type JiraIssueStore,
  type StoredBountyProposal,
  type StoredBounty,
  type BountyStore,
} from "@sandbox-factory/db";
import {
  JiraApiError,
  JiraAuthError,
  type JiraIssueSpec,
} from "@sandbox-factory/jira";
import type {
  ProposalFreshnessDto,
  ProposalLiveSpecDto,
} from "@sandbox-factory/shared";
import { BOUNTY_SPEC_HASH_VERSION, bountySpecHash } from "sandbox-factory";

import { issueKey, type RecentReads } from "../jira/recent.js";
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
  /**
   * Issues read in the last minute. Given, an issue read that recently is
   * not read again: a proposal's page, and its poll while a Jira update is
   * on its way, read Jira at most once a minute per bounty. Absent, as for
   * an approval, Jira is read every time.
   */
  readonly recent?: RecentReads<JiraIssueSpec>;
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
  // Compared with Jira's text only while that is the bounty's.
  if (bounty.jira !== null && textFollowsJira(bounty)) {
    const registered = await options.boards.forRun(
      organizationId,
      bounty.jira.boardId,
    );
    const key =
      registered === null
        ? null
        : issueKey(
            organizationId,
            registered.connectionId,
            bounty.jira.externalId,
          );
    const kept = key === null ? undefined : options.recent?.get(key);
    // Read in the last minute: answered as it was then, without asking for
    // a client, which may itself go to Atlassian to refresh its token.
    if (kept !== undefined && registered !== null)
      return live(proposal, checkedAt, registered.siteUrl, kept);
    const ready: RunClientResult =
      registered === null
        ? { ok: false, reason: "not-found" }
        : options.clientFor === undefined
          ? { ok: false, reason: "reconnect" }
          : await options.clientFor(organizationId, registered.connectionId);
    if (!ready.ok || registered === null || key === null) {
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
      options.recent?.set(key, spec);
      await options.bounties
        .refreshFromJira(organizationId, bounty.id, {
          title: spec.summary,
          description: spec.descriptionText,
          components: spec.components,
          inputTruncated: spec.inputTruncated,
        })
        // The review answers with what Jira said; keeping a copy is not
        // what it is for, and the next read writes it again.
        .catch(() => false);
      return live(proposal, checkedAt, registered.siteUrl, spec);
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

/** The proposal against its issue as Jira said it. */
function live(
  proposal: StoredBountyProposal,
  checkedAt: string,
  siteUrl: string,
  spec: JiraIssueSpec,
): FreshProposal {
  return compared(proposal, checkedAt, spec.pricingSpecHash, {
    summary: spec.summary,
    descriptionText: spec.descriptionText,
    key: spec.key,
    url: `${siteUrl}/browse/${encodeURIComponent(spec.key)}`,
    inputTruncated: spec.inputTruncated,
  });
}

async function storedFreshness(
  proposal: StoredBountyProposal,
  checkedAt: string,
  bounty: StoredBounty,
): Promise<FreshProposal> {
  return compared(
    proposal,
    checkedAt,
    await bountySpecHash(bounty.title, bounty.description),
    {
      summary: bounty.title,
      descriptionText: bounty.description,
      key: bounty.jira?.key ?? null,
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
    ...(liveSpec.key === null ? {} : { liveKey: liveSpec.key }),
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
