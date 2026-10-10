/**
 * The bounties list narrowed to one Jira board, and what can be done there:
 * import the board's scan again, and find one of its issues to add.
 *
 * The board is picked beside the category, from every board in every
 * workspace the person is in, beside Lunox's own, and let go by picking
 * "Show all". While a board is picked, a ⋮ in the picker's own box holds what can be done with it:
 * adding one of its issues, which slides a search field open beside the
 * box, and reading its scan again.
 *
 * A board has no page of its own. Its backlog scan is imported as bounties
 * when its site is connected or synced, each with its overview filled from
 * Jira and nothing sized, so the board's view is the bounty list with
 * `?board=` naming it. Everything here costs Jira reads, never a model
 * call, so any member may do it.
 */

import { ApiError } from "@sandbox-factory/client";
import type { MembershipDto } from "@sandbox-factory/shared";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EllipsisVertical,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { RetryableError } from "@/components/Message";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { clients, queryKeys, useUserId } from "../../data/query";
import { plural } from "../../lib/format";
import { JiraIcon } from "../../ProviderIcon";
import type { BoardScope } from "../../routes";
import { withoutJira, type JiraBoard } from "../../useJira";
import { FilterSelect } from "./FilterSelect";

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

/** The values "Show all" and "Created in Lunox" have in the picker. */
const SHOW_ALL = "";
const LUNOX = "lunox";

/**
 * A board as the picker names it: its workspace's handle and its id. The
 * slash keeps it apart from `LUNOX`, which no board's value can be.
 */
function boardValue(workspace: string, boardId: string): string {
  return `${workspace}/${boardId}`;
}

/** Where bounties came from, by its mark, at the size a filter's text is. */
function SourceGlyph({ source }: { source: "all" | "lunox" | "jira" }) {
  return (
    <span className="text-muted-foreground inline-flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5!">
      {source === "all" ? (
        <Layers />
      ) : source === "lunox" ? (
        // The brand's gradient mark, one file a theme, as Connections has it.
        <>
          <img
            src="/brand/svg/logo-gradient.svg"
            alt=""
            draggable={false}
            className="size-3.5 dark:hidden"
          />
          <img
            src="/brand/svg/logo-gradient-dark.svg"
            alt=""
            draggable={false}
            className="hidden size-3.5 dark:block"
          />
        </>
      ) : (
        <JiraIcon />
      )}
    </span>
  );
}

/**
 * The list's source filter: everything, the bounties written in Lunox, or
 * one Jira board's — every board of every workspace the person is in, each
 * by Jira's mark, read as each workspace's Jira page reads them, so the two
 * share a cache. A workspace without Jira has none. The workspace is named
 * beside each board when boards come from more than one.
 *
 * While a board is picked, its box gains a ⋮, holding what can be done
 * with that board: search its issues or add one, which open the same field,
 * or read its scan again. The field slides open just before the box,
 * focused, and slides shut again when left empty. The box sits at the end
 * of the filter row. What a rescan did is said on a line of its own under
 * the row.
 */
export function BoardFilter({
  organizations,
  selected,
  source,
  onSelect,
  organizationId,
  onOpenBounty,
}: {
  organizations: MembershipDto[];
  /** The board the list is narrowed to; undefined for every board's. */
  selected: BoardScope | undefined;
  /** `lunox` while the list is narrowed to the bounties written there. */
  source: "lunox" | undefined;
  onSelect: (next: {
    board?: BoardScope | undefined;
    source?: "lunox" | undefined;
  }) => void;
  /** The picked board's workspace; undefined while it is not known. */
  organizationId: string | undefined;
  /** Opens one of the picked board's bounties over the list. */
  onOpenBounty: (bountyId: string) => void;
}) {
  const userId = useUserId();
  const reads = useQueries({
    queries: organizations.map((organization) => ({
      queryKey: queryKeys.resource(userId, organization.id, "jira-boards"),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        withoutJira(clients.jira.boards(organization.id, signal)),
    })),
  });
  const loading = reads.some((read) => read.isPending);
  const boards: { workspace: MembershipDto; board: JiraBoard }[] =
    organizations.flatMap((workspace, index) =>
      ((reads[index]?.data ?? []) as JiraBoard[]).map((board) => ({
        workspace,
        board,
      })),
    );
  const severalWorkspaces =
    new Set(boards.map(({ workspace }) => workspace.id)).size > 1;
  const value =
    selected !== undefined
      ? boardValue(selected.workspace.toLowerCase(), selected.boardId)
      : source === "lunox"
        ? LUNOX
        : SHOW_ALL;
  const chosen = boards.find(
    ({ workspace, board }) =>
      boardValue(workspace.slug.toLowerCase(), board.id) === value,
  );
  const tools = {
    ...useBoardTools(organizationId, selected?.boardId, value),
    searchable: selected !== undefined && organizationId !== undefined,
  };

  return (
    <>
      {selected !== undefined && organizationId !== undefined && (
        // Its parts are the filter row's own items: the field just before the
        // box, pushing the two to the row's end, and the note on a line of its
        // own under the row.
        <div className="contents" data-testid="board-scope">
          <div
            inert={!tools.searching}
            aria-hidden={!tools.searching}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget)
                tools.setSettled(tools.searching);
            }}
            className={cn(
              "ml-auto transition-[width,opacity] duration-300 ease-out motion-reduce:transition-none",
              tools.searching
                ? "w-72 max-w-[calc(100vw-6rem)] opacity-100"
                : "-mr-2 w-0 opacity-0",
              !(tools.searching && tools.settled) && "overflow-hidden",
            )}
          >
            <IssueSearch
              // Another board's query is not this one's.
              key={value}
              organizationId={organizationId}
              boardId={selected.boardId}
              inputRef={tools.input}
              onAdded={tools.imported}
              onOpenBounty={onOpenBounty}
              onDismiss={tools.closeSearch}
            />
          </div>
          {tools.note !== null && (
            <p
              role={tools.note.error ? "alert" : "status"}
              className={
                tools.note.error
                  ? "order-last basis-full text-xs text-red-600 dark:text-red-400"
                  : "text-muted-foreground order-last basis-full text-xs"
              }
            >
              {tools.note.text}
            </p>
          )}
        </div>
      )}
      <FilterSelect
        data-testid="board-filter"
        // At the row's end; the search field, while there is one, puts it
        // there instead.
        className={tools.searchable ? undefined : "ml-auto"}
        label="Source"
        align="end"
        searchPlaceholder="Search boards…"
        value={value}
        onValueChange={(next) => {
          if (next === SHOW_ALL) return onSelect({});
          if (next === LUNOX) return onSelect({ source: "lunox" });
          const [workspace = "", boardId = ""] = next.split("/");
          onSelect({ board: { workspace, boardId } });
        }}
        options={[
          {
            value: SHOW_ALL,
            label: "Show all",
            icon: <SourceGlyph source="all" />,
          },
          {
            value: LUNOX,
            label: "Created in Lunox",
            keywords: ["created", "written"],
            icon: <SourceGlyph source="lunox" />,
          },
          ...boards.map(({ workspace, board }) => ({
            value: boardValue(workspace.slug.toLowerCase(), board.id),
            label: board.name,
            keywords: ["jira", board.projectKey ?? "", workspace.name],
            icon: <SourceGlyph source="jira" />,
            detail: severalWorkspaces
              ? workspace.name
              : (board.projectKey ?? undefined),
          })),
          ...(boards.length === 0 && !loading
            ? [
                {
                  value: "none",
                  label: "No Jira boards yet",
                  icon: <SourceGlyph source="jira" />,
                  detail: "Connect Jira in a workspace",
                  disabled: true,
                },
              ]
            : []),
        ]}
        icon={
          <SourceGlyph
            source={
              selected !== undefined
                ? "jira"
                : source === "lunox"
                  ? "lunox"
                  : "all"
            }
          />
        }
        text={
          selected !== undefined
            ? (chosen?.board.name ?? (loading ? "Loading…" : "Not found"))
            : source === "lunox"
              ? "Created in Lunox"
              : "Show all"
        }
        // No ×: it is let go by picking "Show all".
        end={
          selected === undefined ? undefined : (
            <BoardMenu tools={tools} disabled={organizationId === undefined} />
          )
        }
      />
    </>
  );
}

/**
 * What the board's ⋮ and its search field share: whether the field is
 * open, and what a rescan is doing or did. Put back when the board changes:
 * another board's note and open field are not this one's.
 */
function useBoardTools(
  organizationId: string | undefined,
  boardId: string | undefined,
  key: string,
) {
  const imported = useImported();
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  /*
    Whether the field has finished sliding open. Until it has, it clips what
    is in it, so it can grow from nothing; once it has, its results may hang
    below it.
  */
  const [settled, setSettled] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Set by "Add an issue", so the menu hands focus to the field on closing.
  const focusSearch = useRef(false);

  useEffect(() => {
    setNote(null);
    setSearching(false);
    setSettled(false);
  }, [key]);

  async function rescan() {
    if (organizationId === undefined || boardId === undefined) return;
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

  return {
    imported,
    importing,
    note,
    rescan,
    searching,
    settled,
    setSettled,
    input,
    focusSearch,
    openSearch: () => {
      focusSearch.current = true;
      setSettled(false);
      setSearching(true);
    },
    closeSearch: () => {
      setSettled(false);
      setSearching(false);
    },
  };
}

/** The ⋮ in the board's box, and what it offers. */
function BoardMenu({
  tools,
  disabled,
}: {
  tools: ReturnType<typeof useBoardTools>;
  disabled: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Board actions"
          title="Board actions"
          disabled={disabled}
          className="text-muted-foreground hover:text-foreground hover:bg-muted/50 data-[state=open]:bg-muted/50 data-[state=open]:text-foreground grid w-7 shrink-0 place-items-center border-l outline-none last:rounded-r-[inherit] disabled:pointer-events-none"
        >
          {tools.importing ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <EllipsisVertical aria-hidden="true" className="size-3.5" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48"
        onCloseAutoFocus={(event) => {
          if (!tools.focusSearch.current) return;
          tools.focusSearch.current = false;
          event.preventDefault();
          // A frame on, once the field is no longer inert.
          requestAnimationFrame(() => tools.input.current?.focus());
        }}
      >
        {/* Two ways in to the same field: finding an issue that is a bounty
            already opens it, and one that is not is added. */}
        <DropdownMenuItem onSelect={tools.openSearch}>
          <Search />
          Search
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={tools.openSearch}>
          <Plus />
          Add an issue
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={tools.importing}
          title="Read the board's backlog scan again, and import what is in a category"
          onSelect={() => void tools.rescan()}
        >
          <RefreshCw />
          Rescan board
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  inputRef,
  onAdded,
  onOpenBounty,
  onDismiss,
}: {
  organizationId: string;
  boardId: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onAdded: () => Promise<unknown>;
  onOpenBounty: (bountyId: string) => void;
  /** Put away: Escape on an empty field, or leaving it empty. */
  onDismiss: () => void;
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
    <div ref={container} className="relative flex w-full flex-col gap-2">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          type="search"
          aria-label="Find an issue on this board to add"
          placeholder="Find or add an issue by key or title"
          ref={inputRef}
          className="bg-card h-8 pl-8"
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
          onBlur={() => {
            if (query.trim() === "" && adding === null) onDismiss();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
            setMessage(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              if (showing) setOpen(false);
              else if (query !== "") setQuery("");
              else onDismiss();
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
          className="bg-popover absolute top-full right-0 z-20 mt-1 w-[min(32rem,calc(100vw-2rem))] overflow-hidden rounded-md border shadow-md"
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
