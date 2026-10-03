import { ApiError } from "@sandbox-factory/client";
import {
  activeRunConflictSchema,
  createTicketSchema,
  ticketResponseSchema,
  updateTicketSchema,
} from "@sandbox-factory/shared";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { observeUntil, terminalRun } from "./data/observe";
import { clients, queryKeys, useUserId } from "./data/query";
/**
 * The organization's tickets: read a page at a time, written, changed,
 * deleted and proposed through the feature client; every read and write
 * is scoped by the organization in
 * the path, and the server decides what the caller may do.
 */

import type {
  BountyRunDto,
  TicketDto,
  TicketSummaryDto,
} from "@sandbox-factory/shared";
import { useCallback } from "react";

/** How many tickets a page reads; the route's largest. */
const PAGE = 50;

/** How often a proposal's sizing run is asked about while it runs. */
export const PROPOSE_POLL_MS = 1_000;

/** What a ticket form sends: everything a ticket written here has. */
export interface TicketDraft {
  title: string;
  description: string;
  issueType: string;
  priority: string | null;
  labels: string[];
  repoId: string | null;
}

export type TicketWrite =
  | { ok: true; ticket: TicketDto }
  | { ok: false; error: string; ticket?: TicketDto };

/**
 * One ticket read by id. `notFound` separates a ticket that is gone from a
 * read that failed and is worth trying again.
 */
export type TicketRead =
  { ok: true; ticket: TicketDto } | { ok: false; notFound: boolean };

export type ProposeResult =
  { ok: true; proposalId: string } | { ok: false; error: string };

export interface Tickets {
  tickets: TicketSummaryDto[];
  loading: boolean;
  error: string | null;
  more: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  read: (ticketId: string) => Promise<TicketRead>;
  create: (draft: TicketDraft) => Promise<TicketWrite>;
  update: (
    ticketId: string,
    expectedRevision: number,
    change: Partial<TicketDraft>,
  ) => Promise<TicketWrite>;
  remove: (ticketId: string) => Promise<string | null>;
  /**
   * Sizes the ticket and proposes a bounty for it, following the run until
   * the proposal lands. Resolves to the proposal, or to why there is none.
   */
  propose: (ticketId: string, signal?: AbortSignal) => Promise<ProposeResult>;
}

/** What a sizing run that ended without a proposal is told as. */
function runFailure(run: BountyRunDto): string {
  const code = run.outcomes[0]?.code ?? run.fatalErrorCode;
  switch (code) {
    case "reconnect":
      return "This ticket's Jira site needs reconnecting before it can be read.";
    case "sizing_failed":
    case "spec_failed":
      return "The model could not size this ticket. Try again.";
    case "live_proposal":
      return "This ticket already has a proposal.";
    case "issue_has_subtasks":
      return "This ticket is split into sub-tasks in Jira. Size its sub-tasks instead.";
    default:
      return code === null || code === undefined
        ? "Sizing finished without a proposal."
        : `Sizing finished without a proposal (${code}).`;
  }
}

export function useTickets(organizationId: string): Tickets {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const key = queryKeys.resource(userId, organizationId, "tickets");
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      clients.tickets.tickets(
        organizationId,
        {
          limit: PAGE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const tickets = query.data?.pages.flatMap((page) => page.tickets) ?? [];
  const loading = query.isPending;
  const error = query.isError ? "Could not load the tickets." : null;
  const load = useCallback(async () => {
    await Promise.all(
      [
        "tickets",
        "ticket-detail",
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
    async (id: string): Promise<TicketRead> => {
      try {
        return {
          ok: true,
          ticket: await queryClient.fetchQuery({
            queryKey: queryKeys.resource(
              userId,
              organizationId,
              "ticket-detail",
              id,
            ),
            queryFn: ({ signal }) =>
              clients.tickets.ticket(organizationId, id, signal),
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
    ): Promise<TicketWrite> => {
      try {
        const ticket =
          method === "POST"
            ? await clients.tickets.createTicket(
                organizationId,
                createTicketSchema.parse(body),
              )
            : await clients.tickets.updateTicket(
                organizationId,
                decodeURIComponent(path.split("/").at(-1) ?? ""),
                updateTicketSchema.parse(body),
              );
        await load();
        return { ok: true, ticket };
      } catch (error) {
        const current =
          error instanceof ApiError
            ? ticketResponseSchema.safeParse(error.details)
            : null;
        return {
          ok: false,
          error: error instanceof ApiError ? error.message : fallback,
          ...(current?.success ? { ticket: current.data.ticket } : {}),
        };
      }
    },
    [organizationId, load],
  );

  const create = useCallback(
    (draft: TicketDraft) =>
      write("/tickets", "POST", draft, "The ticket could not be saved."),
    [write],
  );

  const update = useCallback(
    (
      ticketId: string,
      expectedRevision: number,
      change: Partial<TicketDraft>,
    ) =>
      write(
        `/tickets/${encodeURIComponent(ticketId)}`,
        "PATCH",
        { expectedRevision, ...change },
        "The ticket could not be saved.",
      ),
    [write],
  );

  const remove = useCallback(
    async (ticketId: string) => {
      try {
        await clients.tickets.deleteTicket(organizationId, ticketId);
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
    async (ticketId: string, signal?: AbortSignal): Promise<ProposeResult> => {
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
        let started: Awaited<ReturnType<typeof clients.tickets.proposeTicket>> =
          {};
        let active: string | null = null;
        try {
          started = await clients.tickets.proposeTicket(
            organizationId,
            ticketId,
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
          return { ok: false, error: "The ticket could not be proposed." };
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
    tickets,
    loading,
    error,
    more: query.hasNextPage,
    loadMore,
    refresh: load,
    read,
    create,
    update,
    remove,
    propose,
  };
}
