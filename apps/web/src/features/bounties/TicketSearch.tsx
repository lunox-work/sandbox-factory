import { ApiError } from "@sandbox-factory/client";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { terminalRun, useObservation } from "../../data/observe";
import { clients, queryKeys, useUserId } from "../../data/query";

import { ErrorBanner } from "@/components/Message";
import { Input } from "@/components/ui/input";

import { plural } from "../../ProposalSpec";

interface TicketResult {
  id: string;
  key: string;
  summary: string;
  status: string;
  issueType: string;
  /** How many sub-tasks it is split into. Absent from an older API. */
  subtaskCount?: number;
}

/**
 * Whether a found ticket can be sized. One split into sub-tasks is priced
 * through them, never itself, so it is listed, to say why, but not offered.
 */
function addable(ticket: TicketResult): boolean {
  return (ticket.subtaskCount ?? 0) === 0;
}

/**
 * Find a ticket on the board and size it now.
 *
 * For the ticket the automatic run did not pick — too new, assigned, past
 * the board's limit — or one somebody wants priced before anything else.
 * The search reads the board live from Jira and lists only tickets not yet
 * on the platform — one with a proposal is already in the list below.
 * Picking one starts a run for that ticket alone, follows it, and opens the
 * proposal the moment it lands. A ticket split into sub-tasks is shown but
 * cannot be picked: its sub-tasks are what is sized.
 */
export function TicketSearch({
  base,
  boardId,
  onProposal,
}: {
  base: string;
  boardId: string;
  onProposal: (proposalId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<{
    key: string;
    summary: string;
    runId: string;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /*
    Searched as the person types, a quarter-second after they stop. The
    generation check drops an answer that arrives after a newer query was
    sent, so a slow search cannot overwrite a faster later one.
  */
  const userId = useUserId();
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const searchQuery = useQuery({
    queryKey: queryKeys.resource(
      userId,
      decodeURIComponent(base.split("/").at(-1) ?? ""),
      "jira-search",
      boardId,
      search,
    ),
    enabled: search !== "",
    queryFn: ({ signal }) =>
      clients.jira.search(
        decodeURIComponent(base.split("/").at(-1) ?? ""),
        boardId,
        search,
        signal,
      ),
  });
  const results = search === "" ? null : (searchQuery.data ?? []);
  const searching =
    query.trim() !== "" && (search !== query.trim() || searchQuery.isFetching);
  useEffect(() => {
    if (searchQuery.isError)
      setMessage(
        searchQuery.error instanceof ApiError
          ? searchQuery.error.message
          : "Could not reach the server.",
      );
  }, [searchQuery.error, searchQuery.isError]);

  const owner = decodeURIComponent(base.split("/").at(-1) ?? "");
  const following = useObservation({
    owner,
    resource: "run",
    id: pending?.runId,
    read: (id, signal) => clients.runs.run(owner, id, signal),
    terminal: (run) =>
      terminalRun(run) || run.outcomes[0]?.proposalId !== undefined,
    interval: 1000,
    startDelay: 1000,
  });
  const finished = useRef<string | null>(null);
  useEffect(() => {
    const run = following.data;
    if (pending === null || run === undefined || finished.current === run.id)
      return;
    const outcome = run.outcomes[0];
    if (outcome?.proposalId === undefined && !terminalRun(run)) return;
    finished.current = run.id;
    let live = true;
    void (async () => {
      if (outcome?.proposalId !== undefined) {
        await onProposal(outcome.proposalId);
      } else if (outcome?.code === "live_proposal") {
        const listed = await clients.pricing.proposals(owner, { boardId });
        const found = listed.proposals.find(
          (row) => row.issueKey === pending.key,
        );
        if (live && found !== undefined) await onProposal(found.id);
        else if (live) setMessage(`Could not size ${pending.key}.`);
      } else setMessage(`Could not size ${pending.key}.`);
      if (live) setPending(null);
    })().catch(() => {
      if (live) setMessage("Could not reach the server.");
    });
    return () => {
      live = false;
    };
  }, [following.data, pending, onProposal, owner, boardId]);
  const selectionRef = useRef(`${base}:${boardId}`);
  selectionRef.current = `${base}:${boardId}`;

  async function pick(ticket: TicketResult) {
    const selection = `${base}:${boardId}`;
    setMessage(null);
    try {
      const body = await clients.jira.proposeIssue(
        owner,
        boardId,
        ticket.id,
        crypto.randomUUID(),
      );
      if (selectionRef.current !== selection) return;
      setQuery("");
      if (body.proposalId !== undefined) {
        await onProposal(body.proposalId);
      } else if (body.run !== undefined) {
        setPending({
          key: ticket.key,
          summary: ticket.summary,
          runId: body.run.id,
        });
      }
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? error.message
          : "Could not reach the server.",
      );
    }
  }

  return (
    <div className="relative flex flex-col gap-2">
      {following.isError && (
        <ErrorBanner>
          Lost track of the sizing run.{" "}
          <button
            onClick={() => {
              void following.refetch();
            }}
          >
            Try again
          </button>
        </ErrorBanner>
      )}
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          type="search"
          aria-label="Find a ticket to size"
          placeholder="Find a ticket to size — key or words from its title"
          className="pl-9"
          value={query}
          disabled={pending !== null}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
            const first = results?.find(addable);
            if (event.key === "Enter" && first !== undefined) {
              event.preventDefault();
              void pick(first);
            }
          }}
        />
      </div>

      {query.trim() !== "" && (
        <div
          className="bg-popover absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-md border shadow-md"
          data-testid="ticket-results"
        >
          {searching && results === null ? (
            <p className="text-muted-foreground flex items-center gap-2 px-3 py-2.5 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Searching…
            </p>
          ) : results !== null && results.length === 0 ? (
            <p className="text-muted-foreground px-3 py-2.5 text-sm">
              No tickets to add match — tickets already proposed are in the list
              below.
            </p>
          ) : (
            <ul className="divide-y">
              {(results ?? []).map((ticket) => (
                <li key={ticket.id}>
                  <button
                    type="button"
                    className="hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-2 text-left text-sm disabled:pointer-events-none disabled:opacity-60"
                    disabled={!addable(ticket)}
                    onClick={() => void pick(ticket)}
                  >
                    <span className="w-20 shrink-0 font-mono text-xs">
                      {ticket.key}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {ticket.summary}
                    </span>
                    <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
                      {ticket.status}
                    </span>
                    {addable(ticket) ? (
                      <span className="text-primary flex shrink-0 items-center gap-1 text-xs font-medium">
                        <Plus className="size-3.5" />
                        Add
                      </span>
                    ) : (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {plural(ticket.subtaskCount ?? 0, "sub-task")}: size
                        those
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pending !== null && (
        <p
          className="text-muted-foreground flex items-center gap-2 text-sm"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" />
          Sizing <span className="font-mono text-xs">{pending.key}</span>
          <span className="truncate">{pending.summary}</span>…
        </p>
      )}
      {message !== null && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

/** How many tickets the executor sizes at once. Mirrors the API's own. */
