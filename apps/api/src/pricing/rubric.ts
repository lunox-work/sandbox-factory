/**
 * The pricing rubric, applied: what sizes a proposal once its code is
 * measured (`sandbox-factory`'s `assessRubric`).
 *
 * A sizing scores the spec straight away, with the code pending, and the
 * model's size stands. When the profiler settles the profile, the rubric is
 * scored again with the code, and a proposal still proposed takes the
 * rubric's size, unless a reviewer has set one: then the assessment is only
 * recorded beside it, for the reviewer to take or leave. An approved
 * proposal is not touched; its size is what was approved.
 */

import type {
  BountyProposalStore,
  BountySpecStore,
  StoredBountyProfile,
  StoredBountyProposal,
} from "@sandbox-factory/db";
import {
  assessRubric,
  priceFor,
  WEIGHT_POINTS,
  type RubricAssessment,
  type RubricCode,
  type RubricCodeStatus,
  type ScenarioWeight,
} from "sandbox-factory";

/** How often a write that met a concurrent change is tried again. */
const ATTEMPTS = 3;

/**
 * What the rubric reads of the code: the profile, when one is ready.
 * `otherwise` is the status without one: `pending` while one has been asked
 * for, `unavailable` when none will be.
 */
export function rubricCode(
  profile: StoredBountyProfile | null,
  otherwise: Exclude<RubricCodeStatus, "measured" | "failed">,
): RubricCode {
  if (profile === null) return { status: otherwise };
  if (profile.status === "ready" && profile.profile !== null)
    return {
      status: "measured",
      profile: profile.profile,
      specRevision: profile.specRevision,
    };
  return { status: profile.status === "failed" ? "failed" : "pending" };
}

/**
 * The weights a proposal's scenarios are scored with: those its step was
 * computed with, which are its board's, so the rubric and the step agree.
 */
export function weightPointsOf(
  proposal: Pick<StoredBountyProposal, "step" | "rubric">,
): Readonly<Record<ScenarioWeight, number>> {
  return (
    proposal.step?.settings.weightPoints ??
    proposal.rubric?.weightPoints ??
    WEIGHT_POINTS
  );
}

/** The size and price an assessment comes to on a proposal's card, if any. */
export function rubricPrice(
  rubric: RubricAssessment,
  proposal: Pick<StoredBountyProposal, "rateCard">,
) {
  if (rubric.size === null) return null;
  const amountMinor = priceFor(rubric.size, proposal.rateCard);
  return amountMinor === null
    ? null
    : {
        complexity: rubric.size,
        amountMinor,
        currency: proposal.rateCard.currency,
      };
}

export interface RubricPricerOptions {
  readonly proposals: Pick<BountyProposalStore, "get" | "applyRubric">;
  readonly specs: Pick<BountySpecStore, "get">;
  readonly onError?: (code: string, error?: unknown) => void;
}

export class RubricPricer {
  readonly #options: RubricPricerOptions;

  constructor(options: RubricPricerOptions) {
    this.#options = options;
  }

  /**
   * A profile has settled, ready or failed: score the proposal's spec with
   * it. Never throws; the profile stands whatever happens here.
   */
  async settled(owner: string, profile: StoredBountyProfile): Promise<void> {
    try {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1)
        if (await this.#apply(owner, profile)) return;
    } catch (error) {
      this.#options.onError?.("bounty_rubric_failed", error);
    }
  }

  /** True when done, whether or not anything was written. */
  async #apply(owner: string, profile: StoredBountyProfile): Promise<boolean> {
    const proposal = await this.#options.proposals.get(
      owner,
      profile.proposalId,
    );
    // A profile measured for a spec the proposal has since moved past by a
    // re-price is not this spec's: the re-price asked for its own.
    if (
      proposal === null ||
      proposal.status !== "proposed" ||
      proposal.specRevision === null ||
      proposal.specRevision < profile.specRevision
    )
      return true;
    const spec = await this.#options.specs.get(
      owner,
      proposal.id,
      proposal.specRevision,
    );
    if (spec === null) return true;
    const rubric = assessRubric({
      spec: spec.draft,
      code: rubricCode(profile, "pending"),
      weightPoints: weightPointsOf(proposal),
    });
    const written = await this.#options.proposals.applyRubric(
      owner,
      proposal.id,
      proposal.revision,
      {
        rubric,
        // A reviewer's size stands; the rubric is recorded for them to take.
        price:
          proposal.sizedBy === "reviewer"
            ? null
            : rubricPrice(rubric, proposal),
      },
    );
    return written.ok || written.reason !== "changed";
  }
}
