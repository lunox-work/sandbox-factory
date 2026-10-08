import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BountyProposalDto } from "@sandbox-factory/shared";
import { useCallback } from "react";
import { clients, queryKeys, useUserId } from "../../data/query";
type Detail = Awaited<ReturnType<typeof clients.pricing.detail>>;

/** How often a proposal is read again while its Jira update is under way. */
export const DELIVERY_POLL_MS = 3_000;

/**
 * A Jira update is posted after its approval or retry answers, so the
 * proposal is read again until none is pending or running: otherwise its
 * "pending" stays on screen until the page is reloaded.
 */
const whileDelivering = (query: { state: { data: Detail | undefined } }) =>
  query.state.data?.writebackOperations.some(
    ({ status }) => status === "pending" || status === "running",
  )
    ? DELIVERY_POLL_MS
    : false;
/** What shows a bounty's live proposal in brief: its size, price and state. */
const BOUNTY_VIEWS = ["bounties", "bounty-detail"] as const;

/**
 * Marks the bounty views stale. A change applied in place reaches the
 * proposal's own reads only; without this, a bounty's row keeps the size
 * and price it had before a resize.
 */
function useBountiesStale(owner: string) {
  const userId = useUserId();
  const cache = useQueryClient();
  return useCallback(() => {
    for (const resource of BOUNTY_VIEWS)
      void cache.invalidateQueries({
        queryKey: queryKeys.resource(userId, owner, resource),
      });
    // The list across workspaces shows the same rows.
    void cache.invalidateQueries({
      queryKey: queryKeys.me(userId, "bounties"),
    });
  }, [cache, userId, owner]);
}

/**
 * Re-reads everything a proposal change can move: lists, details, specs,
 * profiles, runs and the bounties they belong to. One list, so a peek and a
 * list never disagree on what a change invalidates.
 */
function useProposalRefresh(owner: string) {
  const userId = useUserId();
  const cache = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      // The list across workspaces shows the same rows.
      cache.invalidateQueries({ queryKey: queryKeys.me(userId, "bounties") }),
      ...[
        "proposals",
        "proposal-detail",
        "proposal-categories",
        "board-runs",
        "proposal-spec",
        "proposal-spec-revisions",
        "repository-proposals",
        "profile",
        ...BOUNTY_VIEWS,
      ].map((resource) =>
        cache.invalidateQueries({
          queryKey: queryKeys.resource(userId, owner, resource),
        }),
      ),
    ]);
  }, [cache, userId, owner]);
}

/**
 * One proposal by id, with no list around it: what a bounty shows of its
 * own proposal. Keyed as a list's detail read is, so a change made from
 * either is seen by both.
 */
export function useProposalDetail(owner: string, proposalId: string) {
  const userId = useUserId();
  const cache = useQueryClient();
  const detailKey = queryKeys.resource(
    userId,
    owner,
    "proposal-detail",
    proposalId,
    undefined,
  );
  const detail = useQuery({
    queryKey: detailKey,
    staleTime: 0,
    refetchInterval: whileDelivering,
    queryFn: ({ signal }) =>
      clients.pricing.detail(owner, proposalId, undefined, signal),
  });
  const refresh = useProposalRefresh(owner);
  const staleBounties = useBountiesStale(owner);
  const apply = (proposal: BountyProposalDto) => {
    staleBounties();
    cache.setQueryData<Awaited<ReturnType<typeof clients.pricing.detail>>>(
      detailKey,
      (current) => (current === undefined ? current : { ...current, proposal }),
    );
  };
  return { detail, refresh, apply };
}
