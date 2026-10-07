import type { PricedComplexity } from "sandbox-factory";

import type { PricingRouteOptions } from "./options.js";
import { freshProposal } from "./review.js";
import { reviewOptions, siteOf, writebackBusy } from "./review-deps.js";

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
  /*
    Not over a Jira update still unresolved: a withdrawal of the last
    approval, queued or sent without an answer. The approval's own comment
    would race it to the bounty, and a running one holds the proposal's
    only delivery slot (`bounty_writeback_proposal_running_unique`), so the
    approval's write could not even be claimed. Unapprove, re-price and
    remove wait the same way.
  */
  if (
    options.writebacks !== undefined &&
    writebackBusy(
      await options.writebacks.listForProposal(organizationId, proposal.id),
    )
  ) {
    return outcome(
      {
        code: "writeback_busy",
        error: "Resolve the Jira update before approving.",
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
    if (decision.status === "not-found") {
      return outcome({ error: "Not found" }, "not-found");
    }
    if (decision.status !== "created") {
      return outcome(
        {
          code: "proposal_changed",
          error: "The proposal changed. Reload it before continuing.",
        },
        "conflict",
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
      code: "proposal_changed",
      error: "The proposal changed. Reload it before continuing.",
      proposal: mutation.current,
    },
    "conflict",
  );
}
