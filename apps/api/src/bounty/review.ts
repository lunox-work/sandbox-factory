import {
  followsJira,
  type BountyProposalStore,
  type JiraBoardStore,
  type JiraIssueStore,
  type StoredBountyProposal,
  type StoredTicket,
  type TicketStore,
} from "@sandbox-factory/db";
import { JiraApiError, JiraAuthError } from "@sandbox-factory/jira";
import type {
  ProposalFreshnessDto,
  ProposalLiveSpecDto,
} from "@sandbox-factory/shared";
import { TICKET_SPEC_HASH_VERSION, ticketSpecHash } from "sandbox-factory";

import type { RunClientResult } from "./executor.js";

export type FreshProposal = ProposalFreshnessDto & {
  readonly proposal: StoredBountyProposal;
  readonly liveSpec?: ProposalLiveSpecDto;
};

export interface ProposalReviewOptions {
  readonly proposals: BountyProposalStore;
  readonly issues: JiraIssueStore;
  readonly tickets: TicketStore;
  readonly boards: JiraBoardStore;
  /**
   * A Jira site's client, for a ticket still following its issue. Where
   * Jira is not configured it answers `reconnect`, and where it is absent
   * the same is assumed: such a ticket's freshness is then unknown, and
   * every other ticket's is read as stored.
   */
  readonly clientFor?: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  readonly now?: () => Date;
}

/**
 * Whether a proposal was priced from what its ticket says now.
 *
 * A ticket following a Jira issue is read from Jira, and the ticket takes
 * what was read, as it does whenever the issue is read. Any other ticket is
 * compared as it is stored: one written here, or one whose issue Jira no
 * longer has, which keeps the text it last had.
 */
export async function freshProposal(
  options: ProposalReviewOptions,
  organizationId: string,
  proposal: StoredBountyProposal,
): Promise<FreshProposal> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const ticket = await options.tickets.get(organizationId, proposal.ticketId);
  if (ticket === null) {
    return { proposal, freshness: "missing", checkedAt, code: "not_found" };
  }
  if (ticket.jira !== null && followsJira(ticket)) {
    const registered = await options.boards.forRun(
      organizationId,
      ticket.jira.boardId,
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
      const spec = await ready.client.issueSpec(ticket.jira.externalId);
      await options.tickets
        .refreshFromJira(organizationId, ticket.id, {
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
      // Gone from Jira: the ticket keeps what it said, and is read so. Why
      // the stored text is stale, when it is, says more than where it is.
      await options.issues.markRemoved(organizationId, ticket.jira.issueId);
      const stored = await storedFreshness(proposal, checkedAt, ticket);
      return { ...stored, code: stored.code ?? "jira_removed" };
    }
  }
  return storedFreshness(proposal, checkedAt, ticket);
}

async function storedFreshness(
  proposal: StoredBountyProposal,
  checkedAt: string,
  ticket: StoredTicket,
): Promise<FreshProposal> {
  return compared(
    proposal,
    checkedAt,
    await ticketSpecHash(ticket.title, ticket.description, ticket.issueType),
    {
      summary: ticket.title,
      descriptionText: ticket.description,
      issueType: ticket.issueType,
      key: ticket.key,
      url: null,
      inputTruncated: ticket.inputTruncated,
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
  if (proposal.specHashVersion !== TICKET_SPEC_HASH_VERSION) {
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
