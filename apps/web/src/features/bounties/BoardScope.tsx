/**
 * The bounties list narrowed to one Jira board, and what can be done there:
 * import the board's scan again, and find one of its issues to add.
 *
 * A board has no page of its own. Its backlog scan is imported as bounties
 * when its site is connected or synced, each with its overview filled from
 * Jira and nothing sized, so the board's view is the bounty list with
 * `?board=` naming it. Everything here costs Jira reads, never a model
 * call, so any member may do it.
 */

import { ApiError } from "@sandbox-factory/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { RetryableError } from "@/components/Message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { clients, queryKeys, useUserId } from "../../data/query";
import { plural } from "../../lib/format";
import { BoardIcon } from "../../Jira";
import { useJiraBoards } from "../../useJira";

interface IssueResult {
  id: string;
  key: string;
  summary: string;
  status: string;
  /** How many sub-tasks it is split into. Absent from an older API. */
  subtaskCount?: number | undefined;
  /** The bounty it already is; null or absent while it is none. */
  bountyId?: string | null | undefined;
}

/**
 * Whether a found issue can be added. One split into sub-tasks is not a
 * bounty, its sub-tasks are, so it is listed, to say why, but not offered.
 */
function addable(issue: IssueResult): boolean {
  return (issue.subtaskCount ?? 0) === 0;
}

/** "1 bounty", "3 bounties": `plural` adds an s, which this is not. */
function bounties(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "bounty" : "bounties"}`;
}

function failure(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Could not reach the server.";
}

/** Reads again everything an import may have added to or moved. */
function useImported() {
  const userId = useUserId();
  const cache = useQueryClient();
  return () =>
    Promise.all(
      ["bounties", "bounty-categories"].map((resource) =>
        cache.invalidateQueries({ queryKey: queryKeys.me(userId, resource) }),
      ),
    );
}

export function BoardScope({
  organizationId,
  boardId,
  onClear,
  onOpenBounty,
}: {
  /** The workspace the board is in; undefined while it is not known. */
  organizationId: string | undefined;
  boardId: string;
  /** Widens the list back to every board's bounties, and the rest. */
  onClear: () => void;
  /** Opens one of the board's bounties over the list. */
  onOpenBounty: (bountyId: string) => void;
}) {
  const { boards, loading } = useJiraBoards(organizationId);
  const board = boards.find(({ id }) => id === boardId);
  const imported = useImported();
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(
    null,
  );

  async function rescan() {
    if (organizationId === undefined) return;
    setImporting(true);
    setNote(null);
    try {
      const result = await clients.jira.importBoard(organizationId, boardId);
      await imported();
      setNote({
        text:
          result.created === 0 && result.refreshed === 0
            ? "The scan found nothing in a category."
            : [
                result.created > 0 ? `${bounties(result.created)} added` : null,
                result.refreshed > 0
                  ? `${bounties(result.refreshed)} refreshed`
                  : null,
                result.failed > 0
                  ? `${plural(result.failed, "issue")} could not be read`
                  : null,
              ]
                .filter((part) => part !== null)
                .join(", ") + ".",
        error: false,
      });
    } catch (error) {
      setNote({ text: failure(error), error: true });
    } finally {
      setImporting(false);
    }
  }

  return (
    <section
      aria-label="Board"
      className="flex flex-col gap-3 rounded-lg border px-4 py-3"
      data-testid="board-scope"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-muted-foreground shrink-0 [&_svg]:size-4">
          <BoardIcon boardType={board?.boardType ?? ""} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {board?.name ?? (loading ? "Board" : "A board not found")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={importing || organizationId === undefined}
          title="Read the board's backlog scan again, and import what is in a category"
          onClick={() => void rescan()}
        >
          <RefreshCw className={importing ? "animate-spin" : undefined} />
          Rescan
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground size-8"
          aria-label="Show every board's bounties"
          title="Show every board's bounties"
          onClick={onClear}
        >
          <X />
        </Button>
      </div>
      {note !== null && (
        <p
          role={note.error ? "alert" : "status"}
          className={
            note.error
              ? "text-sm text-red-600 dark:text-red-400"
              : "text-muted-foreground text-sm"
          }
        >
          {note.text}
        </p>
      )}
      {organizationId !== undefined && (
        <IssueSearch
          organizationId={organizationId}
          boardId={boardId}
          onAdded={imported}
          onOpenBounty={onOpenBounty}
        />
      )}
    </section>
  );
}

/**
 * Find an issue on the board and add it as a bounty.
 *
 * For the issue the scan did not put in a category, or one added on the
 * board since. Read live from Jira as the person types. An issue that is a
 * bounty already opens it rather than adding it twice; picking one that is
 * not imports it, with its overview filled from Jira and nothing sized, and
 * opens it.
 */
function IssueSearch({
  organizationId,
  boardId,
  onAdded,
  onOpenBounty,
}: {
  organizationId: string;
  boardId: string;
  onAdded: () => Promise<unknown>;
  onOpenBounty: (bountyId: string) => void;
}) {
  const userId = useUserId();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<IssueResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Closed by Escape or a click elsewhere, opened again by typing or focus.
  const [open, setOpen] = useState(true);
  // The result the arrow keys are on, and Enter takes.
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (
        container.current !== null &&
        event.target instanceof Node &&
        !container.current.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  // A quarter-second after typing stops, so each keystroke is not a search.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const searched = useQuery({
    queryKey: queryKeys.resource(
      userId,
      organizationId,
      "jira-search",
      boardId,
      search,
    ),
    enabled: search !== "",
    queryFn: ({ signal }) =>
      clients.jira.search(organizationId, boardId, search, signal),
  });
  const results: IssueResult[] | null =
    search === "" ? null : (searched.data ?? []);
  const pickable = (results ?? []).filter(addable);
  const searching =
    query.trim() !== "" && (search !== query.trim() || searched.isFetching);
  const showing = open && query.trim() !== "";

  async function pick(issue: IssueResult) {
    setMessage(null);
    setQuery("");
    if (issue.bountyId !== undefined && issue.bountyId !== null) {
      onOpenBounty(issue.bountyId);
      return;
    }
    setAdding(issue);
    try {
      const result = await clients.jira.importBoard(
        organizationId,
        boardId,
        issue.id,
      );
      await onAdded();
      if (result.bountyId !== undefined) onOpenBounty(result.bountyId);
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setAdding(null);
    }
  }

  return (
    <div ref={container} className="relative flex flex-col gap-2">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          type="search"
          aria-label="Find an issue on this board to add"
          placeholder="Add an issue — its key or title"
          className="pl-9"
          role="combobox"
          aria-expanded={showing}
          aria-controls="board-issue-results"
          aria-autocomplete="list"
          aria-activedescendant={
            showing && pickable[active] !== undefined
              ? `board-issue-${pickable[active].id}`
              : undefined
          }
          value={query}
          disabled={adding !== null}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
            setMessage(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              if (showing) setOpen(false);
              else setQuery("");
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const count = pickable.length;
              if (count === 0) return;
              setOpen(true);
              setActive(
                (current) =>
                  (current + (event.key === "ArrowDown" ? 1 : count - 1)) %
                  count,
              );
              return;
            }
            const chosen = pickable[active] ?? pickable[0];
            // Only a result in sight: closed, Enter would take one unseen.
            if (event.key === "Enter" && showing && chosen !== undefined) {
              event.preventDefault();
              void pick(chosen);
            }
          }}
        />
      </div>

      {showing && (
        <div
          className="bg-popover absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-md border shadow-md"
          data-testid="board-issue-results"
        >
          {searched.isError ? (
            <RetryableError onRetry={() => void searched.refetch()}>
              {failure(searched.error)}
            </RetryableError>
          ) : searching && results === null ? (
            <p className="text-muted-foreground flex items-center gap-2 px-3 py-2.5 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Searching…
            </p>
          ) : results !== null && results.length === 0 ? (
            <p className="text-muted-foreground px-3 py-2.5 text-sm">
              No issues on this board match.
            </p>
          ) : (
            <ul className="divide-y" role="listbox" id="board-issue-results">
              {(results ?? []).map((issue) => {
                const current = pickable[active]?.id === issue.id;
                const existing =
                  issue.bountyId !== undefined && issue.bountyId !== null;
                return (
                  <li
                    key={issue.id}
                    id={`board-issue-${issue.id}`}
                    role="option"
                    aria-selected={current}
                    aria-disabled={!addable(issue)}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-2 text-left text-sm disabled:pointer-events-none disabled:opacity-60 ${current ? "bg-muted/50" : ""}`}
                      disabled={!addable(issue)}
                      onClick={() => void pick(issue)}
                    >
                      <span className="w-20 shrink-0 font-mono text-xs">
                        {issue.key}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {issue.summary}
                      </span>
                      <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
                        {issue.status}
                      </span>
                      {!addable(issue) ? (
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {plural(issue.subtaskCount ?? 0, "sub-task")}: add
                          those
                        </span>
                      ) : existing ? (
                        <span className="text-muted-foreground shrink-0 text-xs">
                          Open
                        </span>
                      ) : (
                        <span className="text-primary flex shrink-0 items-center gap-1 text-xs font-medium">
                          <Plus className="size-3.5" />
                          Add
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {adding !== null && (
        <p
          className="text-muted-foreground flex items-center gap-2 text-sm"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" />
          Adding <span className="font-mono text-xs">{adding.key}</span>
          <span className="truncate">{adding.summary}</span>…
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
