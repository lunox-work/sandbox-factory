import {
  PENDING_PROFILE_STATUSES,
  type StoredBountyProfile,
  type StoredBountyProposal,
} from "@sandbox-factory/db";
import type { ProposalPriceDto } from "@sandbox-factory/shared";
import { pricedFromOf, type PricedComplexity } from "sandbox-factory";

import { decisionsConfirmUrl, decisionsStanding } from "./decisions.js";
import type { PricingRouteOptions } from "./options.js";
import { freshProposal } from "./review.js";
import { reviewOptions, siteOf, writebackBusy } from "./review-deps.js";

function outcome<T extends object>(
  body: T,
  kind: "success" | "not-found" | "conflict" = "success",
) {
  return { kind, body };
}

/** The price a proposal stands at, or null while it has none. */
function priceOf(
  proposal: Pick<
    StoredBountyProposal,
    "complexity" | "amountMinor" | "currency"
  >,
): ProposalPriceDto | null {
  return proposal.complexity === "unsized" ||
    proposal.amountMinor === null ||
    proposal.currency === null
    ? null
    : {
        complexity: proposal.complexity as PricedComplexity,
        amountMinor: proposal.amountMinor,
        currency: proposal.currency,
      };
}

function samePrice(
  a: ProposalPriceDto | null,
  b: ProposalPriceDto | null,
): boolean {
  return (
    a?.complexity === b?.complexity &&
    a?.amountMinor === b?.amountMinor &&
    a?.currency === b?.currency
  );
}

/**
 * The refusal for an approval made against a proposal that moved on: the
 * price the person saw against the one it stands at now when those differ
 * (`price_changed`, typically a profile landing while the page was open),
 * otherwise that it changed. `seen` is the caller's `expectedPrice`, or the
 * price at the revision it named when the server read it.
 */
function changed(
  seen: ProposalPriceDto | null,
  current: StoredBountyProposal | undefined | null,
) {
  const now =
    current === undefined || current === null ? null : priceOf(current);
  if (current !== undefined && current !== null && !samePrice(seen, now))
    return outcome(
      {
        code: "price_changed",
        error:
          "The price changed since it was loaded. Check the new price, then approve.",
        previous: seen,
        current: now,
        proposal: current,
      },
      "conflict",
    );
  return outcome(
    {
      code: "proposal_changed",
      error: "The proposal changed. Reload it before continuing.",
      ...(current === undefined || current === null
        ? {}
        : { proposal: current }),
    },
    "conflict",
  );
}

/**
 * Whether an approval waits on the code: a price is approved only once it
 * has seen the code, or once the code is known not to come. Any of the
 * proposal's newest profiles still in flight holds it (`profile_pending`).
 * All settled while the stored rubric still says pending means the
 * re-score that follows a settle (`RubricPricer`) has not landed: it is
 * run here (`rescore`), and the approval is then made against what it
 * wrote. Without `rescore`, or when it writes nothing, the price stands
 * as it is, spec-only. A failed profile, or none at all, approves the
 * spec's price and says so (`pricedFrom: "spec"`).
 */
async function profileHold(
  options: PricingRouteOptions,
  organizationId: string,
  proposal: StoredBountyProposal,
): Promise<
  | { readonly kind: "held"; readonly profiles: readonly StoredBountyProfile[] }
  | { readonly kind: "rescored"; readonly proposal: StoredBountyProposal }
  | null
> {
  if (options.profiles === undefined) return null;
  const profiles = await options.profiles.latest(organizationId, proposal.id);
  if (profiles.some(({ status }) => PENDING_PROFILE_STATUSES.includes(status)))
    return { kind: "held", profiles };
  const [settled] = profiles;
  if (
    settled === undefined ||
    proposal.rubric?.code.status !== "pending" ||
    options.rescore === undefined
  )
    return null;
  await options.rescore(organizationId, settled);
  const after = await options.proposals.get(organizationId, proposal.id);
  return after !== null && after.revision !== proposal.revision
    ? { kind: "rescored", proposal: after }
    : null;
}

export async function approveProposal(
  options: PricingRouteOptions,
  input: {
    organizationId: string;
    proposalId: string;
    actorId: string;
    expectedRevision: number;
    /** The price the person saw; absent, the current one is approved. */
    expectedPrice?: ProposalPriceDto | undefined;
  },
) {
  const { organizationId, expectedRevision } = input;
  const proposal = await options.proposals.get(
    organizationId,
    input.proposalId,
  );
  if (proposal === null) return outcome({ error: "Not found" }, "not-found");
  // What the approval is of: the price the caller says it saw, else the
  // price at the revision it named, which is the current one if it matches.
  const seen = input.expectedPrice ?? priceOf(proposal);
  if (proposal.revision !== expectedRevision) {
    // Without the price it saw, a caller only knows the revision moved.
    return input.expectedPrice === undefined
      ? outcome(
          {
            code: "proposal_changed",
            error: "The proposal changed. Reload it before continuing.",
            proposal,
          },
          "conflict",
        )
      : changed(seen, proposal);
  }
  if (!samePrice(seen, priceOf(proposal))) return changed(seen, proposal);
  const hold = await profileHold(options, organizationId, proposal);
  if (hold?.kind === "held") {
    return outcome(
      {
        code: "profile_pending",
        error:
          "The code is still being profiled, and the price may change. Approve once it settles.",
        profiles: hold.profiles.map(({ repository, status }) => ({
          repository,
          status,
        })),
      },
      "conflict",
    );
  }
  if (hold?.kind === "rescored") return changed(seen, hold.proposal);
  /*
    Not before its decisions are confirmed: the price is approved for the
    spec as it stands, and its hidden tests are written to what that spec
    decided where the bounty was silent. A spec with no decisions needs
    nothing (`decisionsStanding`).
  */
  const spec =
    proposal.specRevision === null
      ? null
      : await options.specs.get(
          organizationId,
          proposal.id,
          proposal.specRevision,
        );
  const decided = await decisionsStanding(
    {
      store: options.decisions,
      confirmUrl: async (owner, bountyId) =>
        decisionsConfirmUrl(
          options.appUrl,
          await options.organizationSlug?.(owner),
          owner,
          bountyId,
        ),
    },
    organizationId,
    proposal.bountyId,
    spec === null
      ? null
      : {
          proposalId: proposal.id,
          specRevision: spec.revision,
          draft: spec.draft,
        },
    "approving the price",
  );
  if (!decided.ok) return outcome(decided.body, "conflict");
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
    // The bounty's own page, open on its price, for whoever follows the
    // comment back from Jira.
    const proposalUrl = `${options.appUrl}/bounties/${encodeURIComponent(slug)}/${encodeURIComponent(proposal.bountyId)}?tab=price`;
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
      return changed(
        seen,
        await options.proposals.get(organizationId, proposal.id),
      );
    }
    options.delivery.start(organizationId, decision.operation.id);
    const approved = await options.proposals.get(organizationId, proposal.id);
    return outcome({
      proposal: approved,
      pricedFrom: pricedFromOf(proposal.rubric),
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
  // The price approved is the one checked above: the store's write holds
  // to the same revision, so a re-score landing in between misses it.
  if (mutation.ok)
    return outcome({
      proposal: mutation.proposal,
      pricedFrom: pricedFromOf(proposal.rubric),
    });
  if (mutation.reason === "not-found")
    return outcome({ error: "Not found" }, "not-found");
  return changed(seen, mutation.current);
}
