/**
 * The organization's tickets: read a page at a time, written, changed,
 * deleted and proposed. Plain `fetch` with the session cookie, like the
 * other hooks here; every read and write is scoped by the organization in
 * the path, and the server decides what the caller may do.
 */

import type {
  BountyRunDto,
  TicketDto,
  TicketSummaryDto,
} from "@sandbox-factory/shared";
import { useCallback, useEffect, useRef, useState } from "react";

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

export type ProposeResult =
  { ok: true; proposalId: string } | { ok: false; error: string };

export interface Tickets {
  tickets: TicketSummaryDto[];
  loading: boolean;
  error: string | null;
  more: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  read: (ticketId: string) => Promise<TicketDto | null>;
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

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string" ? body.error : fallback;
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
    default:
      return code === null || code === undefined
        ? "Sizing finished without a proposal."
        : `Sizing finished without a proposal (${code}).`;
  }
}

export function useTickets(organizationId: string): Tickets {
  const base = `/api/v1/orgs/${encodeURIComponent(organizationId)}`;
  const [tickets, setTickets] = useState<TicketSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  /*
    How many rows the list holds open, so a refresh after a write re-reads
    as many as were showing rather than folding back to one page.
  */
  const wanted = useRef(PAGE);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const rows: TicketSummaryDto[] = [];
      let next: string | null = null;
      do {
        const response: Response = await fetch(
          `${base}/tickets?limit=${PAGE}${
            next === null ? "" : `&cursor=${encodeURIComponent(next)}`
          }`,
          { credentials: "include" },
        );
        if (!response.ok) throw new Error();
        const body = (await response.json()) as {
          tickets: TicketSummaryDto[];
          nextCursor: string | null;
        };
        rows.push(...body.tickets);
        next = body.nextCursor;
      } while (next !== null && rows.length < wanted.current);
      if (current !== generation.current) return;
      setTickets(rows);
      setCursor(next);
      setError(null);
    } catch {
      if (current === generation.current) {
        setError("Could not load the tickets.");
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const loadMore = useCallback(async () => {
    wanted.current += PAGE;
    await load();
  }, [load]);

  const read = useCallback(
    async (ticketId: string) => {
      try {
        const response = await fetch(
          `${base}/tickets/${encodeURIComponent(ticketId)}`,
          { credentials: "include" },
        );
        if (!response.ok) return null;
        return ((await response.json()) as { ticket: TicketDto }).ticket;
      } catch {
        return null;
      }
    },
    [base],
  );

  const write = useCallback(
    async (
      path: string,
      method: "POST" | "PATCH",
      body: unknown,
      fallback: string,
    ): Promise<TicketWrite> => {
      try {
        const response = await fetch(`${base}${path}`, {
          method,
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const failed = (await response
            .clone()
            .json()
            .catch(() => null)) as { ticket?: TicketDto } | null;
          return {
            ok: false,
            error: await errorOf(response, fallback),
            ...(failed?.ticket === undefined ? {} : { ticket: failed.ticket }),
          };
        }
        const { ticket } = (await response.json()) as { ticket: TicketDto };
        await load();
        return { ok: true, ticket };
      } catch {
        return { ok: false, error: "Could not reach the server." };
      }
    },
    [base, load],
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
        const response = await fetch(
          `${base}/tickets/${encodeURIComponent(ticketId)}`,
          { method: "DELETE", credentials: "include" },
        );
        if (!response.ok) {
          return errorOf(response, "The ticket could not be deleted.");
        }
        await load();
        return null;
      } catch {
        return "Could not reach the server.";
      }
    },
    [base, load],
  );

  const propose = useCallback(
    async (ticketId: string, signal?: AbortSignal): Promise<ProposeResult> => {
      try {
        const response = await fetch(
          `${base}/tickets/${encodeURIComponent(ticketId)}/propose`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: crypto.randomUUID() }),
            ...(signal === undefined ? {} : { signal }),
          },
        );
        if (!response.ok) {
          return {
            ok: false,
            error: await errorOf(response, "The ticket could not be proposed."),
          };
        }
        const started = (await response.json()) as {
          run?: BountyRunDto;
          proposalId?: string;
        };
        if (started.proposalId !== undefined) {
          return { ok: true, proposalId: started.proposalId };
        }
        let run = started.run;
        // Followed until its one outcome lands or it ends without one.
        while (run !== undefined) {
          const landed = run.outcomes[0]?.proposalId;
          if (landed !== undefined) {
            await load();
            return { ok: true, proposalId: landed };
          }
          if (run.status !== "queued" && run.status !== "running") {
            await load();
            return { ok: false, error: runFailure(run) };
          }
          await new Promise((resolve) =>
            window.setTimeout(resolve, PROPOSE_POLL_MS),
          );
          if (signal?.aborted) return { ok: false, error: "Stopped." };
          const polled = await fetch(
            `${base}/runs/${encodeURIComponent(run.id)}`,
            {
              credentials: "include",
              ...(signal === undefined ? {} : { signal }),
            },
          );
          if (!polled.ok) {
            return { ok: false, error: "Lost track of the sizing run." };
          }
          run = ((await polled.json()) as { run: BountyRunDto }).run;
        }
        return { ok: false, error: "The ticket could not be proposed." };
      } catch {
        return signal?.aborted
          ? { ok: false, error: "Stopped." }
          : { ok: false, error: "Could not reach the server." };
      }
    },
    [base, load],
  );

  return {
    tickets,
    loading,
    error,
    more: cursor !== null,
    loadMore,
    refresh: load,
    read,
    create,
    update,
    remove,
    propose,
  };
}
