import { ApiError } from "@sandbox-factory/client";
import {
  activeRunConflictSchema,
  createBountySchema,
  bountyResponseSchema,
  updateBountySchema,
} from "@sandbox-factory/shared";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { observeUntil, terminalRun } from "./data/observe";
import { clients, queryKeys, useUserId } from "./data/query";
/**
 * Bounties: the caller's, read a page at a time across every workspace they
 * belong to (`useAllBounties`), and one workspace's, read, written, changed,
 * deleted and proposed through the feature client (`useBounties`). Every
 * write is scoped by the organization in the path, and the server decides
 * what the caller may do.
 */

import type {
  BountyRunDto,
  BountyDto,
  BountySummaryDto,
} from "@sandbox-factory/shared";
import { useCallback } from "react";

/** How many bounties a page reads; the route's largest. */
const PAGE = 50;

/** How often a proposal's sizing run is asked about while it runs. */
export const PROPOSE_POLL_MS = 1_000;

/** What a bounty form sends: everything a bounty written here has. */
export interface BountyDraft {
  title: string;
  description: string;
  repoId: string | null;
  /** What the bounty adds to its repository's detected stack. */
  stack: string[];
}

export type BountyWrite =
  | { ok: true; bounty: BountyDto }
  | { ok: false; error: string; bounty?: BountyDto };

/**
 * One bounty read by id. `notFound` separates a bounty that is gone from a
 * read that failed and is worth trying again.
 */
export type BountyRead =
  { ok: true; bounty: BountyDto } | { ok: false; notFound: boolean };

export type ProposeResult =
  { ok: true; proposalId: string } | { ok: false; error: string };

/** The caller's bounties, newest first, from every workspace. */
export interface AllBounties {
  bounties: BountySummaryDto[];
  loading: boolean;
  error: string | null;
  more: boolean;
  loadMore: () => Promise<void>;
  /** Reads the list again after it failed. */
  retry: () => void;
}

/** What can be done with one workspace's bounties. */
export interface Bounties {
  /** Reads again what a change to the workspace's bounties may have moved. */
  refresh: () => Promise<void>;
  read: (bountyId: string) => Promise<BountyRead>;
  /** The bounty as last read, if it has been: shown while it is read again. */
  cached: (bountyId: string) => BountyDto | undefined;
  create: (draft: BountyDraft) => Promise<BountyWrite>;
  update: (
    bountyId: string,
    expectedRevision: number,
    change: Partial<BountyDraft>,
  ) => Promise<BountyWrite>;
  remove: (bountyId: string) => Promise<string | null>;
  /**
   * Links the bounty to a Jira issue on one of the workspace's boards, by
   * Jira's id. It follows the issue from then on, so its text becomes Jira's.
   */
  linkJira: (
    bountyId: string,
    link: { boardId: string; issueId: string },
  ) => Promise<BountyWrite>;
  /** Takes its Jira issue from the bounty, which keeps its text. */
  unlinkJira: (bountyId: string) => Promise<BountyWrite>;
  /**
   * Approves the bounty's overview at its version, which holds it as it is
   * until it is unapproved, or takes that back.
   */
  decide: (
    bountyId: string,
    decision: "approve" | "unapprove",
    expectedRevision: number,
  ) => Promise<BountyWrite>;
  /**
   * Makes the bounty's sandbox, cut from `sourceRepoId` when one is given.
   * Resolves to null, or to why there is none.
   */
  createSandbox: (
    bountyId: string,
    sourceRepoId: string | null,
  ) => Promise<string | null>;
  /**
   * Links the repository a sandbox made without one is cut from. Resolves
   * to null, or to why it was not linked.
   */
  linkSandboxSource: (
    sandboxId: string,
    sourceRepoId: string,
  ) => Promise<string | null>;
  /**
   * Sizes the bounty and makes its proposal, following the run until the
   * proposal lands. Resolves to the proposal, or to why there is none. With
   * `following`, the run already sizing it is waited on instead, and nothing
   * new is asked for.
   */
  propose: (
    bountyId: string,
    signal?: AbortSignal,
    following?: string,
  ) => Promise<ProposeResult>;
}

/** What a sizing run that ended without a proposal is told as. */
function runFailure(run: BountyRunDto): string {
  const code = run.outcomes[0]?.code ?? run.fatalErrorCode;
  switch (code) {
    case "reconnect":
      return "This bounty's Jira site needs reconnecting before it can be read.";
    case "sizing_failed":
    case "spec_failed":
      return "The model could not size this bounty. Try again.";
    case "live_proposal":
      return "This bounty already has a proposal.";
    case "issue_has_subtasks":
      return "This bounty is split into sub-tasks in Jira. Size its sub-tasks instead.";
    default:
      return code === null || code === undefined
        ? "Sizing finished without a proposal."
        : `Sizing finished without a proposal (${code}).`;
  }
}

/**
 * The caller's bounties across every workspace they belong to, newest first.
 * Each carries its workspace's id, which is where anything done to it goes.
 */
/**
 * What the list is narrowed to: a category's id, `uncategorized` for the
 * bounties in none, and a board's id. Absent, all of them.
 */
export interface BountyFilter {
  category?: string | undefined;
  board?: string | undefined;
}

export function useAllBounties(filter: BountyFilter = {}): AllBounties {
  const userId = useUserId();
  const { category, board } = filter;
  const query = useInfiniteQuery({
    // Under the list's own key, so whatever reads the list again reads
    // every filtered copy of it too.
    queryKey: [...queryKeys.me(userId, "bounties"), { category, board }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      clients.bounties.myBounties(
        {
          limit: PAGE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
          ...(category === undefined ? {} : { category }),
          ...(board === undefined ? {} : { board }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const loadMore = useCallback(async () => {
    await query.fetchNextPage();
  }, [query.fetchNextPage]);
  const retry = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);
  return {
    bounties: query.data?.pages.flatMap((page) => page.bounties) ?? [],
    loading: query.isPending,
    error: query.isError ? "Could not load the bounties." : null,
    more: query.hasNextPage,
    loadMore,
    retry,
  };
}

/** How many of the caller's bounties each category holds, on `board`'s. */
export function useBountyCategories(board: string | undefined) {
  const userId = useUserId();
  return useQuery({
    queryKey: [...queryKeys.me(userId, "bounty-categories"), { board }],
    queryFn: ({ signal }) =>
      clients.bounties.myBountyCategories(
        board === undefined ? {} : { board },
        signal,
      ),
  });
}

export function useBounties(organizationId: string): Bounties {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const load = useCallback(async () => {
    await Promise.all([
      // The list across workspaces holds this one's bounties too.
      queryClient.invalidateQueries({
        queryKey: queryKeys.me(userId, "bounties"),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.me(userId, "bounty-categories"),
      }),
      ...[
        "bounties",
        "bounty-detail",
        "proposals",
        "proposal-detail",
        "proposal-categories",
        "repository-proposals",
        "proposal-spec",
        "proposal-spec-revisions",
        "profile",
      ].map((resource) =>
        queryClient.invalidateQueries({
          queryKey: queryKeys.resource(userId, organizationId, resource),
        }),
      ),
    ]);
  }, [queryClient, userId, organizationId]);
  const read = useCallback(
    async (id: string): Promise<BountyRead> => {
      try {
        return {
          ok: true,
          bounty: await queryClient.fetchQuery({
            queryKey: queryKeys.resource(
              userId,
              organizationId,
              "bounty-detail",
              id,
            ),
            queryFn: ({ signal }) =>
              clients.bounties.bounty(organizationId, id, signal),
            staleTime: 0,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          notFound: error instanceof ApiError && error.isNotFound,
        };
      }
    },
    [organizationId, queryClient, userId],
  );
  const cached = useCallback(
    (id: string) =>
      queryClient.getQueryData<BountyDto>(
        queryKeys.resource(userId, organizationId, "bounty-detail", id),
      ),
    [organizationId, queryClient, userId],
  );
  const write = useCallback(
    async (
      path: string,
      method: "POST" | "PATCH",
      body: unknown,
      fallback: string,
    ): Promise<BountyWrite> => {
      try {
        const bounty =
          method === "POST"
            ? await clients.bounties.createBounty(
                organizationId,
                createBountySchema.parse(body),
              )
            : await clients.bounties.updateBounty(
                organizationId,
                decodeURIComponent(path.split("/").at(-1) ?? ""),
                updateBountySchema.parse(body),
              );
        await load();
        return { ok: true, bounty };
      } catch (error) {
        const current =
          error instanceof ApiError
            ? bountyResponseSchema.safeParse(error.details)
            : null;
        return {
          ok: false,
          error: error instanceof ApiError ? error.message : fallback,
          ...(current?.success ? { bounty: current.data.bounty } : {}),
        };
      }
    },
    [organizationId, load],
  );

  const create = useCallback(
    (draft: BountyDraft) =>
      write("/bounties", "POST", draft, "The bounty could not be saved."),
    [write],
  );

  const update = useCallback(
    (
      bountyId: string,
      expectedRevision: number,
      change: Partial<BountyDraft>,
    ) =>
      write(
        `/bounties/${encodeURIComponent(bountyId)}`,
        "PATCH",
        { expectedRevision, ...change },
        "The bounty could not be saved.",
      ),
    [write],
  );

  const remove = useCallback(
    async (bountyId: string) => {
      try {
        await clients.bounties.deleteBounty(organizationId, bountyId);
        await load();
        return null;
      } catch (error) {
        return error instanceof ApiError
          ? error.message
          : "Could not reach the server.";
      }
    },
    [organizationId, load],
  );

  const jiraWrite = useCallback(
    async (send: () => Promise<BountyDto>): Promise<BountyWrite> => {
      try {
        const bounty = await send();
        await load();
        return { ok: true, bounty };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof ApiError
              ? error.message
              : "Could not reach the server.",
        };
      }
    },
    [load],
  );
  const linkJira = useCallback(
    (bountyId: string, link: { boardId: string; issueId: string }) =>
      jiraWrite(() =>
        clients.bounties.linkBountyJira(organizationId, bountyId, link),
      ),
    [jiraWrite, organizationId],
  );
  const unlinkJira = useCallback(
    (bountyId: string) =>
      jiraWrite(() =>
        clients.bounties.unlinkBountyJira(organizationId, bountyId),
      ),
    [jiraWrite, organizationId],
  );

  const decide = useCallback(
    (
      bountyId: string,
      decision: "approve" | "unapprove",
      expectedRevision: number,
    ) =>
      jiraWrite(() =>
        clients.bounties.decideBounty(
          organizationId,
          bountyId,
          decision,
          expectedRevision,
        ),
      ),
    [jiraWrite, organizationId],
  );

  const createSandbox = useCallback(
    async (bountyId: string, sourceRepoId: string | null) => {
      try {
        await clients.sandbox.createSandbox(organizationId, {
          bountyId,
          sourceRepoId,
        });
        await load();
        return null;
      } catch (error) {
        return error instanceof ApiError
          ? error.message
          : "Could not reach the server.";
      }
    },
    [organizationId, load],
  );

  const linkSandboxSource = useCallback(
    async (sandboxId: string, sourceRepoId: string) => {
      try {
        await clients.sandbox.linkSandboxSource(organizationId, sandboxId, {
          sourceRepoId,
        });
        await load();
        return null;
      } catch (error) {
        return error instanceof ApiError
          ? error.message
          : "Could not reach the server.";
      }
    },
    [organizationId, load],
  );

  const propose = useCallback(
    async (
      bountyId: string,
      signal?: AbortSignal,
      following?: string,
    ): Promise<ProposeResult> => {
      const readRun = async (runId: string) => {
        return queryClient.fetchQuery({
          queryKey: queryKeys.resource(
            userId,
            organizationId,
            "bounty-run",
            runId,
          ),
          queryFn: ({ signal: querySignal }) =>
            clients.runs.run(
              organizationId,
              runId,
              signal === undefined
                ? querySignal
                : AbortSignal.any([signal, querySignal]),
            ),
          staleTime: 0,
        });
      };
      try {
        let started: Awaited<
          ReturnType<typeof clients.bounties.proposeBounty>
        > = {};
        let active: string | null = following ?? null;
        if (active === null) {
          try {
            started = await clients.bounties.proposeBounty(
              organizationId,
              bountyId,
              crypto.randomUUID(),
              signal,
            );
          } catch (error) {
            const conflict =
              error instanceof ApiError
                ? activeRunConflictSchema.safeParse(error.details)
                : null;
            if (conflict?.success) active = conflict.data.runId;
            else if (error instanceof ApiError)
              return { ok: false, error: error.message };
            else throw error;
          }
        }
        if (started?.proposalId !== undefined) {
          await load();
          return { ok: true, proposalId: started.proposalId };
        }
        const initial = active === null ? started?.run : await readRun(active);
        if (initial === undefined)
          return { ok: false, error: "The bounty could not be proposed." };
        const run = await observeUntil({
          initial,
          read: readRun,
          id: (run) => run.id,
          terminal: (run) =>
            run.outcomes[0]?.proposalId !== undefined || terminalRun(run),
          interval: PROPOSE_POLL_MS,
          ...(signal === undefined ? {} : { signal }),
        });
        await load();
        const landed = run.outcomes[0]?.proposalId;
        return landed === undefined
          ? { ok: false, error: runFailure(run) }
          : { ok: true, proposalId: landed };
      } catch {
        return signal?.aborted
          ? { ok: false, error: "Stopped." }
          : { ok: false, error: "Could not reach the server." };
      }
    },
    [load, queryClient, userId, organizationId],
  );

  return {
    refresh: load,
    read,
    cached,
    create,
    update,
    remove,
    linkJira,
    unlinkJira,
    decide,
    createSandbox,
    linkSandboxSource,
    propose,
  };
}
