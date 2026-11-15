/**
 * The decisions gate: a spec whose draft decided something the bounty was
 * silent on (`specDecisions`) stands only once a person confirmed exactly
 * those decisions (`decision_confirmation`, keyed by proposal, spec
 * revision and the hash of `decisionsText`). Hidden tests are written to
 * them, so approving the price, every build that writes hidden tests and
 * publishing a version each check it: approval first, the others again,
 * since what they build on is the spec frozen into the version's task. A
 * spec with no decisions needs nothing. There is no waiver: the refusal
 * carries the page where a person confirms (`confirmUrl`), never a token.
 */

import type { DecisionConfirmationStore } from "@sandbox-factory/db";
import { createHash } from "node:crypto";
import { decisionsText, specDecisions, type SpecDraft } from "sandbox-factory";

/** The hash a confirmation is bound to, of the decisions a spec holds. */
export function decisionsSha256(draft: SpecDraft): string {
  return createHash("sha256")
    .update(decisionsText(specDecisions(draft)), "utf8")
    .digest("hex");
}

/** The bounty's Price step, where a person reads and confirms decisions. */
export function decisionsConfirmUrl(
  appUrl: string | undefined,
  slug: string | undefined,
  organizationId: string,
  bountyId: string,
): string {
  return `${appUrl ?? ""}/bounties/${encodeURIComponent(slug ?? organizationId)}/${encodeURIComponent(bountyId)}?tab=price#decisions`;
}

export interface DecisionsGate {
  /** Absent, decisions cannot be confirmed, so a spec with any never stands. */
  readonly store?: Pick<DecisionConfirmationStore, "get"> | undefined;
  readonly confirmUrl: (
    organizationId: string,
    bountyId: string,
  ) => Promise<string>;
}

/**
 * Whether a spec's decisions stand: `{ ok: true }` with the hash a build
 * quotes them under (null for a spec with none, or no spec), else the 409
 * body `decisions_unconfirmed`.
 */
export async function decisionsStanding(
  gate: DecisionsGate,
  organizationId: string,
  bountyId: string,
  spec: {
    readonly proposalId: string;
    readonly specRevision: number;
    readonly draft: SpecDraft;
  } | null,
  action: string,
): Promise<
  | { readonly ok: true; readonly decisionsSha256: string | null }
  | { readonly ok: false; readonly body: Record<string, unknown> }
> {
  if (spec === null || spec.draft.assumptions.length === 0)
    return { ok: true, decisionsSha256: null };
  const sha256 = decisionsSha256(spec.draft);
  const confirmed =
    (await gate.store?.get(
      organizationId,
      spec.proposalId,
      spec.specRevision,
      sha256,
    )) ?? null;
  if (confirmed !== null) return { ok: true, decisionsSha256: sha256 };
  return {
    ok: false,
    body: {
      code: "decisions_unconfirmed",
      error: `Confirm the spec's decisions before ${action}: hidden tests are written to them. A person confirms them on the bounty's Price step.`,
      proposalId: spec.proposalId,
      specRevision: spec.specRevision,
      decisions: spec.draft.assumptions.length,
      confirmUrl: await gate.confirmUrl(organizationId, bountyId),
    },
  };
}
