import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type { BountyProposalDto } from "@sandbox-factory/shared";
import { useCallback } from "react";
import { clients, queryKeys, useUserId } from "../../data/query";
import type { EnrichedProposal } from "./types";

type Page = { proposals: EnrichedProposal[]; nextCursor: string | null };
export function useProposalResources(
  owner: string,
  boardId: string | undefined,
  category: string | null,
  selectedId: string | null,
) {
  const userId = useUserId();
  const cache = useQueryClient();
  const listKey = queryKeys.resource(
    userId,
    owner,
    "proposals",
    boardId,
    category,
  );
  const list = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      clients.pricing.proposals(
        owner,
        {
          ...(boardId === undefined ? {} : { boardId }),
          limit: "50",
          ...(category === null ? {} : { category }),
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const categories = useQuery({
    queryKey: queryKeys.resource(userId, owner, "proposal-categories", boardId),
    queryFn: ({ signal }) => clients.pricing.categories(owner, boardId, signal),
  });
  const runs = useQuery({
    queryKey: queryKeys.resource(userId, owner, "board-runs", boardId),
    enabled: boardId !== undefined,
    queryFn: ({ signal }) => clients.runs.runs(owner, boardId ?? "", signal),
  });
  const detailKey = queryKeys.resource(
    userId,
    owner,
    "proposal-detail",
    selectedId,
    boardId,
  );
  const detail = useQuery({
    queryKey: detailKey,
    enabled: selectedId !== null,
    staleTime: 0,
    queryFn: ({ signal }) =>
      clients.pricing.detail(owner, selectedId ?? "", boardId, signal),
  });
  const refresh = useProposalRefresh(owner);
  const staleBounties = useBountiesStale(owner);
  const apply = (proposal: BountyProposalDto) => {
    staleBounties();
    cache.setQueriesData<InfiniteData<Page>>(
      { queryKey: queryKeys.resource(userId, owner, "proposals") },
      (current) =>
        current === undefined
          ? current
          : {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                proposals: page.proposals.map((row) =>
                  row.id === proposal.id ? { ...row, ...proposal } : row,
                ),
              })),
            },
    );
    cache.setQueryData<Awaited<ReturnType<typeof clients.pricing.detail>>>(
      detailKey,
      (current) => (current === undefined ? current : { ...current, proposal }),
    );
  };
  return { list, categories, runs, detail, refresh, apply };
}

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
    await Promise.all(
      [
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
    );
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
