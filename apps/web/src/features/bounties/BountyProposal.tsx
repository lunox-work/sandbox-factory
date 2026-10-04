import { ApiError } from "@sandbox-factory/client";
import { RefreshCw } from "lucide-react";
import { useProposalMutations } from "./mutations";
import { ProposalPeek } from "./ProposalPeek";
import { useProposalDetail } from "./queries";
import type { EnrichedProposal } from "./types";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { Button } from "@/components/ui/button";

/**
 * A bounty's own proposal, inside the bounty: its spec, its size and the
 * decision on it, in the same peek a board's list opens.
 *
 * A proposal is made from a bounty and belongs to it, so it is reached
 * through the bounty rather than through a list of its own. Read by id, so
 * it shows the same whether the bounty was written here or came from Jira;
 * the bounty names it, since the bounty's title and key are its own.
 */
export function BountyProposal({
  organizationId,
  proposalId,
  bountyKey,
  bountyTitle,
  canDecide,
  onChanged,
  onRemoved,
}: {
  organizationId: string;
  proposalId: string;
  bountyKey: string | undefined;
  bountyTitle: string | undefined;
  canDecide: boolean;
  /** After a change has landed, for whatever shows the bounty's proposal. */
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const base = `/api/v1/orgs/${encodeURIComponent(organizationId)}`;
  const { detail, refresh, apply } = useProposalDetail(
    organizationId,
    proposalId,
  );
  const changed = async () => {
    await refresh();
    onChanged();
  };
  const { busy, error, mutate } = useProposalMutations(organizationId, {
    apply,
    refresh: changed,
  });

  if (detail.isError) {
    return detail.error instanceof ApiError && detail.error.status === 404 ? (
      <p className="text-muted-foreground text-sm">
        This proposal no longer exists.
      </p>
    ) : (
      <div className="flex flex-col items-start gap-3">
        <ErrorBanner className="mt-0">Could not load the proposal.</ErrorBanner>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void detail.refetch()}
        >
          <RefreshCw />
          Try again
        </Button>
      </div>
    );
  }
  if (detail.data === undefined)
    return <LoadingLine>Loading the proposal…</LoadingLine>;

  const read = detail.data;
  const proposal: EnrichedProposal = {
    ...read.proposal,
    ...read.freshness,
    writebackOperations: read.writebackOperations,
    ...(bountyKey === undefined ? {} : { liveKey: bountyKey }),
    ...(bountyTitle === undefined ? {} : { liveTitle: bountyTitle }),
  };
  return (
    <div className="flex flex-col gap-4">
      {error !== null && <ErrorBanner className="mt-0">{error}</ErrorBanner>}
      <ProposalPeek
        base={base}
        proposal={proposal}
        bounty={null}
        liveSpec={read.liveSpec ?? null}
        bountyError={null}
        onRetryBounty={() => void detail.refetch()}
        canDecide={canDecide}
        busy={busy}
        mutate={mutate}
        onChanged={changed}
        onRemoved={onRemoved}
      />
    </div>
  );
}
