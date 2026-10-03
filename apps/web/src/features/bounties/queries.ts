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
  const refresh = useCallback(async () => {
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
      ].map((resource) =>
        cache.invalidateQueries({
          queryKey: queryKeys.resource(userId, owner, resource),
        }),
      ),
    );
  }, [cache, userId, owner]);
  const apply = (proposal: BountyProposalDto) => {
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
