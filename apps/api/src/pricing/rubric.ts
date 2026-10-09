/**
 * The pricing rubric, applied: what sizes a proposal once its code is
 * measured (`sandbox-factory`'s `assessRubric`).
 *
 * A sizing scores the spec straight away, with the code pending, and the
 * model's size stands. The code is profiled in each repository the work
 * touches; when the profiler has settled every one, the rubric is scored
 * again with the code, and a proposal still proposed takes the
 * rubric's size, unless a reviewer has set one: then the assessment is only
 * recorded beside it, for the reviewer to take or leave. An approved
 * proposal is not touched; its size is what was approved.
 */

import type {
  BountyProfileStore,
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

/**
 * How often a write that met a concurrent change is tried again, beyond
 * once for each profile of the revision: each one's settle writes the
 * proposal, and any of them can be the change another meets.
 */
const ATTEMPTS = 3;

/** The name a profile's repository is shown by once it is gone. */
const REMOVED_REPOSITORY = "a removed repository";

/**
 * What the rubric reads of the code: one spec revision's profiles, one per
 * repository its work touches, once every one is ready. One failed fails
 * the code, and one still in flight leaves it pending. `otherwise` is the
 * status with none: `pending` while some have been asked for,
 * `unavailable` when none will be.
 */
export function rubricCode(
  profiles: readonly StoredBountyProfile[],
  otherwise: Exclude<RubricCodeStatus, "measured" | "failed">,
): RubricCode {
  const [first] = profiles;
  if (first === undefined) return { status: otherwise };
  if (profiles.some(({ status }) => status === "failed"))
    return { status: "failed" };
  const measured = profiles.flatMap(({ status, profile, repository }) =>
    status === "ready" && profile !== null
      ? [{ repository: repository ?? REMOVED_REPOSITORY, profile }]
      : [],
  );
  return measured.length === profiles.length
    ? {
        status: "measured",
        profiles: measured,
        specRevision: first.specRevision,
      }
    : { status: "pending" };
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
  readonly profiles: Pick<BountyProfileStore, "forRevision">;
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
   * its revision's profiles, which is a size once every repository's has
   * settled ready. Never throws; the profile stands whatever happens here.
   */
  async settled(owner: string, profile: StoredBountyProfile): Promise<void> {
    try {
      let attempts = ATTEMPTS;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const applied = await this.#apply(owner, profile);
        if (applied === "done") return;
        attempts = ATTEMPTS + applied.profiles;
      }
      // Left as the last settle to write it saw: say so, as no later
      // settle of this revision comes to correct it.
      this.#options.onError?.("bounty_rubric_contended");
    } catch (error) {
      this.#options.onError?.("bounty_rubric_failed", error);
    }
  }

  /**
   * Done, whether or not anything was written; else the write met a
   * concurrent change, among the revision's this many profiles.
   */
  async #apply(
    owner: string,
    profile: StoredBountyProfile,
  ): Promise<"done" | { profiles: number }> {
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
      return "done";
    const spec = await this.#options.specs.get(
      owner,
      proposal.id,
      proposal.specRevision,
    );
    if (spec === null) return "done";
    const profiles = await this.#options.profiles.forRevision(
      owner,
      proposal.id,
      profile.specRevision,
    );
    const rubric = assessRubric({
      spec: spec.draft,
      code: rubricCode(profiles, "pending"),
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
    return written.ok || written.reason !== "changed"
      ? "done"
      : { profiles: profiles.length };
  }
}
