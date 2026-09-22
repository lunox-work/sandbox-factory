import { randomUUID } from "node:crypto";

import type {
  BountyProposalStore,
  BountyWritebackStore,
  JiraBoardStore,
  JiraConnectionStore,
  JiraIssueStore,
  StoredBountyWriteback,
} from "@sandbox-factory/db";
import {
  adfToText,
  JiraApiError,
  JiraWriteResponseError,
  type JiraClient,
  type JiraWriteClient,
} from "@sandbox-factory/jira";
import { formatMinorUnits } from "sandbox-factory";

const HEARTBEAT_MS = 15_000;

export interface DeliveryClients {
  readonly ok: true;
  readonly client: JiraClient;
  readonly writeClient: JiraWriteClient;
}
export type DeliveryClientResult =
  | DeliveryClients
  | { readonly ok: false; readonly reason: "not-found" | "reconnect" };

export interface BountyDeliveryOptions {
  readonly writebacks: BountyWritebackStore;
  readonly proposals: BountyProposalStore;
  readonly issues: JiraIssueStore;
  readonly boards: JiraBoardStore;
  readonly connections: JiraConnectionStore;
  readonly clientsFor: (
    organizationId: string,
    connectionId: string,
  ) => Promise<DeliveryClientResult>;
  readonly leaseToken?: () => string;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly onBackgroundError?: (code: string) => void;
}

export class BountyDelivery {
  readonly #options: BountyDeliveryOptions;

  constructor(options: BountyDeliveryOptions) {
    this.#options = options;
  }

  start(organizationId: string, id: string): void {
    void this.execute(organizationId, id).catch(() =>
      this.#options.onBackgroundError?.("writeback_worker_failed"),
    );
  }

  async execute(
    organizationId: string,
    id: string,
  ): Promise<StoredBountyWriteback | null> {
    const leaseToken = (this.#options.leaseToken ?? randomUUID)();
    const operation = await this.#options.writebacks.claim(
      organizationId,
      id,
      leaseToken,
      new Date(),
    );
    if (operation === null)
      return this.#options.writebacks.get(organizationId, id);

    const leaseController = new AbortController();
    const heartbeat = (this.#options.setInterval ?? setInterval)(() => {
      void this.#options.writebacks
        .heartbeat(organizationId, id, leaseToken, new Date())
        .then((held) => {
          if (!held) leaseController.abort();
        })
        .catch(() => leaseController.abort());
    }, HEARTBEAT_MS);
    try {
      return await this.#executeClaimed(
        organizationId,
        id,
        leaseToken,
        operation,
        leaseController.signal,
      );
    } finally {
      (this.#options.clearInterval ?? clearInterval)(heartbeat);
    }
  }

  async #executeClaimed(
    organizationId: string,
    id: string,
    leaseToken: string,
    operation: StoredBountyWriteback,
    leaseSignal: AbortSignal,
  ): Promise<StoredBountyWriteback | null> {
    const context = await this.#context(organizationId, operation);
    if (!context.ok) {
      return this.#options.writebacks.fail(
        organizationId,
        id,
        leaseToken,
        "failed",
        context.code,
      );
    }

    if (operation.step === "label") {
      return this.#label(
        organizationId,
        operation,
        leaseToken,
        context.writeClient,
        context.externalId,
        leaseSignal,
      );
    }

    if (operation.kind === "approved") {
      try {
        const spec = await context.client.issueSpec(context.externalId);
        if (
          context.proposal.specHashVersion !== 1 ||
          spec.pricingSpecHash !== context.proposal.specHash ||
          spec.inputTruncated
        ) {
          return this.#options.writebacks.fail(
            organizationId,
            id,
            leaseToken,
            "failed",
            "proposal_stale",
          );
        }
      } catch {
        return this.#options.writebacks.fail(
          organizationId,
          id,
          leaseToken,
          "failed",
          "spec_unavailable",
        );
      }
    }

    const attempted = await this.#options.writebacks.markCommentAttempted(
      organizationId,
      id,
      leaseToken,
      new Date(),
    );
    if (!attempted) return null;

    const requestController = new AbortController();
    const timer = setTimeout(() => requestController.abort(), 30_000);
    let commentId: string;
    try {
      commentId = await context.writeClient.addComment(
        context.externalId,
        commentAdf(operation),
        AbortSignal.any([leaseSignal, requestController.signal]),
      );
    } catch (error) {
      clearTimeout(timer);
      const known = error instanceof JiraApiError && error.status < 500;
      return this.#options.writebacks.fail(
        organizationId,
        id,
        leaseToken,
        known ? "failed" : "uncertain",
        writeErrorCode(error),
      );
    }
    clearTimeout(timer);

    const recorded = await this.#options.writebacks.recordComment(
      organizationId,
      id,
      leaseToken,
      commentId,
      operation.kind === "approved",
    );
    if (recorded === null || operation.kind !== "approved") return recorded;
    return this.#label(
      organizationId,
      recorded,
      leaseToken,
      context.writeClient,
      context.externalId,
      leaseSignal,
    );
  }

  async reconcile(
    organizationId: string,
    id: string,
  ): Promise<{
    readonly status: "adopted" | "none" | "multiple" | "not-uncertain";
    readonly operation: StoredBountyWriteback | null;
  }> {
    const operation = await this.#options.writebacks.get(organizationId, id);
    if (
      operation === null ||
      operation.status !== "uncertain" ||
      operation.step !== "comment"
    ) {
      return { status: "not-uncertain", operation };
    }
    const context = await this.#context(organizationId, operation);
    if (!context.ok) return { status: "none", operation };
    let comments;
    try {
      comments = await context.client.comments(context.externalId);
    } catch {
      return { status: "none", operation };
    }
    const expected = commentText(operation);
    const matches = comments.filter(
      (comment) => adfToText(comment.body).trim() === expected,
    );
    if (matches.length !== 1) {
      return { status: matches.length > 1 ? "multiple" : "none", operation };
    }
    const adopted = await this.#options.writebacks.adoptComment(
      organizationId,
      id,
      matches[0]!.id,
    );
    if (adopted?.status === "pending") {
      this.start(organizationId, id);
    }
    return { status: "adopted", operation: adopted };
  }

  async #context(organizationId: string, operation: StoredBountyWriteback) {
    const proposal = await this.#options.proposals.get(
      organizationId,
      operation.proposalId,
    );
    if (proposal === null) return { ok: false as const, code: "not_found" };
    const issue = await this.#options.issues.get(
      organizationId,
      proposal.jiraIssueId,
    );
    if (issue === null) return { ok: false as const, code: "not_found" };
    const registered = await this.#options.boards.forRun(
      organizationId,
      issue.boardId,
    );
    if (registered === null) return { ok: false as const, code: "not_found" };
    const connection = await this.#options.connections.get(
      organizationId,
      registered.connectionId,
    );
    // The grant is the site's, not the board's; see `jiraWriteGranted`. An
    // operation queued while the site held it and run after a reconnect that
    // withheld it fails here rather than at Jira, with a code that says why.
    if (connection === null || !connection.writeGranted)
      return { ok: false as const, code: "write_consent_required" };
    if (!connection.healthy) return { ok: false as const, code: "reconnect" };
    const clients = await this.#options.clientsFor(
      organizationId,
      registered.connectionId,
    );
    if (!clients.ok) return { ok: false as const, code: clients.reason };
    return {
      ...clients,
      proposal,
      externalId: issue.externalId,
    };
  }

  async #label(
    organizationId: string,
    operation: StoredBountyWriteback,
    leaseToken: string,
    client: JiraWriteClient,
    externalId: string,
    leaseSignal: AbortSignal,
  ) {
    const requestController = new AbortController();
    const timer = setTimeout(() => requestController.abort(), 30_000);
    try {
      await client.addLabel(
        externalId,
        "bounty",
        AbortSignal.any([leaseSignal, requestController.signal]),
      );
      return await this.#options.writebacks.completeLabel(
        organizationId,
        operation.id,
        leaseToken,
      );
    } catch (error) {
      return await this.#options.writebacks.fail(
        organizationId,
        operation.id,
        leaseToken,
        "failed",
        writeErrorCode(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function commentText(operation: StoredBountyWriteback): string {
  const amount =
    formatMinorUnits(
      operation.payload.amountMinor,
      currencyDigits(operation.payload.currency),
    ) ?? String(operation.payload.amountMinor);
  if (operation.kind === "approved") {
    return `Bounty approved: ${operation.payload.complexity} — ${operation.payload.currency} ${amount}. Review: ${operation.payload.proposalUrl}. Reference: ${operation.id}.`;
  }
  if (operation.kind === "rejected") {
    return `The approved bounty was withdrawn. Review: ${operation.payload.proposalUrl}. Reference: ${operation.id}.`;
  }
  return `The approved bounty was replaced by a new draft. Previous: ${operation.payload.proposalUrl}. Replacement: ${operation.payload.replacementUrl ?? operation.payload.proposalUrl}. Reference: ${operation.id}.`;
}

export function commentAdf(operation: StoredBountyWriteback): unknown {
  return {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: commentText(operation) }],
      },
    ],
  };
}

function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function writeErrorCode(error: unknown): string {
  if (error instanceof JiraApiError) {
    if (error.status === 401) return "reconnect";
    if (error.status === 403) return "permission";
    if (error.status === 404) return "issue_unavailable";
    if (error.status === 429) return "jira_rate_limited";
    return error.status >= 500 ? "jira_uncertain" : "jira_rejected";
  }
  if (error instanceof JiraWriteResponseError) return error.code;
  return "jira_uncertain";
}
