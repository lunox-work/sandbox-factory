import type { PricingRouteOptions } from "./options.js";
export type { PricingRouteOptions } from "./options.js";
export { sizeIfNeverSized, startRun, startBountyRun } from "./start-run.js";
export type { StartRunResult, StartBountyRunResult } from "./start-run.js";

import { type PricedComplexity } from "sandbox-factory";

import { freshProposal } from "./review.js";

import { reviewOptions, siteOf } from "./review-deps.js";
function outcome<T extends object>(
  body: T,
  kind: "success" | "not-found" | "conflict" = "success",
) {
  return { kind, body };
}
export async function approveProposal(
  options: PricingRouteOptions,
  input: {
    organizationId: string;
    proposalId: string;
    actorId: string;
    expectedRevision: number;
  },
) {
  const { organizationId, expectedRevision } = input;
  const proposal = await options.proposals.get(
    organizationId,
    input.proposalId,
  );
  if (proposal === null) return outcome({ error: "Not found" }, "not-found");
  if (proposal.revision !== expectedRevision) {
    return outcome(
      {
        code: "proposal_changed",
        error: "The proposal changed. Reload it before continuing.",
        proposal,
      },
      "conflict",
    );
  }
  const fresh = await freshProposal(
    reviewOptions(options),
    organizationId,
    proposal,
  );
  if (fresh.freshness !== "current") {
    const code =
      fresh.freshness === "stale" ? "proposal_stale" : "spec_unavailable";
    return outcome(
      {
        code,
        error:
          code === "proposal_stale"
            ? "The bounty changed since it was sized. Re-price before continuing."
            : "The bounty could not be checked.",
        freshness: fresh.freshness,
      },
      "conflict",
    );
  }
  if (fresh.liveSpec?.inputTruncated || proposal.inputTruncated) {
    return outcome(
      {
        code: "spec_too_large",
        error: "Shorten or split the bounty, then re-price it.",
      },
      "conflict",
    );
  }
  if (
    proposal.complexity === "unsized" ||
    proposal.amountMinor === null ||
    proposal.currency === null
  ) {
    return outcome(
      { code: "unsized", error: "Choose a size before approval." },
      "conflict",
    );
  }
  // Whether the approval is posted to the bounty is the site's grant: every
  // consent asks for the write scope, so a site holds it unless the person
  // withheld it. No grant means the approval is recorded here and nowhere
  // else, which is what a read-only site was connected for, and what a
  // bounty with no Jira issue always has.
  const site = await siteOf(options, organizationId, proposal.bountyId);
  const registered = site?.registered ?? null;
  const connection = site?.connection ?? null;
  if (registered !== null && connection?.writeGranted === true) {
    if (!connection.healthy) {
      // Not approved without the post: the site was connected to receive
      // it, and a reconnect is a minute's work. Approving now would leave
      // the bounty silent with nothing to say so later.
      return outcome(
        {
          code: "reconnect",
          error: "Reconnect this Jira site before approving.",
        },
        "conflict",
      );
    }
    if (
      options.writebacks === undefined ||
      options.delivery === undefined ||
      options.appUrl === undefined ||
      options.organizationSlug === undefined
    ) {
      return outcome(
        {
          code: "write_consent_required",
          error: "Jira delivery is not configured.",
        },
        "conflict",
      );
    }
    const slug = await options.organizationSlug(organizationId);
    if (slug === undefined) return outcome({ error: "Not found" }, "not-found");
    const proposalUrl = `${options.appUrl}/o/${encodeURIComponent(slug)}/jira/${encodeURIComponent(registered.connectionId)}/${encodeURIComponent(registered.board.id)}?tab=proposals&proposal=${encodeURIComponent(proposal.id)}`;
    const decision = await options.writebacks.approveWithIntent(
      organizationId,
      proposal.id,
      expectedRevision,
      input.actorId,
      {
        complexity: proposal.complexity as PricedComplexity,
        amountMinor: proposal.amountMinor,
        currency: proposal.currency,
        proposalUrl,
      },
    );
    if (decision.status !== "created") {
      return outcome(
        {
          code: "proposal_changed",
          error: "The proposal changed. Reload it before continuing.",
        },
        decision.status === "not-found" ? "not-found" : "conflict",
      );
    }
    options.delivery.start(organizationId, decision.operation.id);
    const approved = await options.proposals.get(organizationId, proposal.id);
    return outcome({
      proposal: approved,
      writebackOperation: decision.operation,
    });
  }
  const mutation = await options.proposals.approve(
    organizationId,
    proposal.id,
    expectedRevision,
    input.actorId,
    "off",
  );
  if (mutation.ok) return outcome({ proposal: mutation.proposal });
  if (mutation.reason === "not-found")
    return outcome({ error: "Not found" }, "not-found");
  return outcome(
    {
      error: "The proposal changed. Reload it before continuing.",
      proposal: mutation.current,
    },
    "conflict",
  );
}
