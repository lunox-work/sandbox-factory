import { useState } from "react";
import { ApiError } from "@sandbox-factory/client";
import type {
  BountyProposalDto,
  ProposalPriceDto,
} from "@sandbox-factory/shared";
import { clients } from "../../data/query";
import { money } from "../../lib/format";

/**
 * Refusals that mean the page shows a proposal the server has moved past:
 * the price changed (a profile landed), the code is still being profiled,
 * or the revision moved. The page reads the proposal again, so what the
 * person sees next is what they would approve.
 */
const STALE_PAGE = new Set([
  "price_changed",
  "profile_pending",
  "proposal_changed",
]);

function priceIn(value: unknown): ProposalPriceDto | null {
  if (typeof value !== "object" || value === null) return null;
  const { amountMinor, currency, complexity } = value as Record<
    string,
    unknown
  >;
  return typeof amountMinor === "number" &&
    typeof currency === "string" &&
    typeof complexity === "string"
    ? (value as ProposalPriceDto)
    : null;
}

/** What a refusal says, naming both prices when the price moved. */
export function refusalMessage(error: ApiError): string {
  if (error.code !== "price_changed") return error.message;
  const details = (error.details ?? {}) as Record<string, unknown>;
  const previous = priceIn(details["previous"]);
  const current = priceIn(details["current"]);
  if (previous === null || current === null) return error.message;
  return `The price changed from ${money(previous.amountMinor, previous.currency)} (${previous.complexity}) to ${money(current.amountMinor, current.currency)} (${current.complexity}) once the code was measured. Check it, then approve.`;
}

export function useProposalMutations(
  owner: string,
  resources: {
    apply: (proposal: BountyProposalDto) => void;
    refresh: () => Promise<void>;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function mutate(
    path: string,
    body: object,
    { apply = false }: { apply?: boolean } = {},
  ) {
    setBusy(true);
    try {
      const result = await clients.pricing.action(owner, path, body);
      setError(null);
      if (apply && result.proposal !== undefined)
        resources.apply(result.proposal);
      else await resources.refresh();
      return true;
    } catch (error) {
      if (error instanceof ApiError) {
        setError(refusalMessage(error));
        if (error.status === 409 && STALE_PAGE.has(error.code ?? ""))
          await resources.refresh().catch(() => {});
      } else setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, mutate };
}
