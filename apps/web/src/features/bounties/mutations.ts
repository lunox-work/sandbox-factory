import { useState } from "react";
import { ApiError } from "@sandbox-factory/client";
import type { BountyProposalDto } from "@sandbox-factory/shared";
import { clients } from "../../data/query";
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
      setError(
        error instanceof ApiError
          ? error.message
          : "Could not reach the server.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, mutate };
}
