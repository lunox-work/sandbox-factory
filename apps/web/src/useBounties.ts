import { ApiError } from "@sandbox-factory/client";
import {
  activeRunConflictSchema,
  createBountySchema,
  bountyResponseSchema,
  updateBountySchema,
} from "@sandbox-factory/shared";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { observeUntil, terminalRun } from "./data/observe";
import { clients, queryKeys, useUserId } from "./data/query";
/**
 * The organization's bounties: read a page at a time, written, changed,
 * deleted and proposed through the feature client; every read and write
 * is scoped by the organization in
 * the path, and the server decides what the caller may do.
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
  issueType: string;
  priority: string | null;
  labels: string[];
  repoId: string | null;
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

export interface Bounties {
  bounties: BountySummaryDto[];
  loading: boolean;
  error: string | null;
  more: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  read: (bountyId: string) => Promise<BountyRead>;
  create: (draft: BountyDraft) => Promise<BountyWrite>;
  update: (
    bountyId: string,
    expectedRevision: number,
    change: Partial<BountyDraft>,
  ) => Promise<BountyWrite>;
  remove: (bountyId: string) => Promise<string | null>;
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
   * proposal lands. Resolves to the proposal, or to why there is none.
   */
  propose: (bountyId: string, signal?: AbortSignal) => Promise<ProposeResult>;
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

export function useBounties(organizationId: string): Bounties {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const key = queryKeys.resource(userId, organizationId, "bounties");
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      clients.bounties.bounties(
        organizationId,
        {
          limit: PAGE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const bounties = query.data?.pages.flatMap((page) => page.bounties) ?? [];
  const loading = query.isPending;
  const error = query.isError ? "Could not load the bounties." : null;
  const load = useCallback(async () => {
    await Promise.all(
      [
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
    );
  }, [queryClient, userId, organizationId]);
  const loadMore = useCallback(async () => {
    await query.fetchNextPage();
  }, [query.fetchNextPage]);
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
    async (bountyId: string, signal?: AbortSignal): Promise<ProposeResult> => {
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
        let active: string | null = null;
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
        if (started?.proposalId !== undefined) {
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
    bounties,
    loading,
    error,
    more: query.hasNextPage,
    loadMore,
    refresh: load,
    read,
    create,
    update,
    remove,
    createSandbox,
    linkSandboxSource,
    propose,
  };
}
