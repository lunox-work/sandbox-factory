/**
 * A connected board's backlog scan on onboarding, under getting started: the
 * tickets worth outsourcing, with the board they are from picked above them.
 *
 * Opens on a board of the workspace — the one last picked here, or failing
 * that its first — so a reload lands where the person left off. Remembered
 * per person and per workspace, so switching workspace in the rail moves to
 * that workspace's board rather than keeping one that is not its. A
 * workspace with no board yet shows `fallback`.
 *
 * Above the scan is the board bar: which board, and a menu of what can be
 * done to the whole board — sizing every candidate, scanning again — so the
 * scan below is only the tickets, and the one-at-a-time sizing beside them.
 * Sizing, of one ticket or all of them, waits for GitHub where the server
 * offers it: a ticket is sized beside the code.
 */

import { isWorkspaceSource } from "@sandbox-factory/shared";
import {
  ChevronsUpDown,
  EllipsisVertical,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Combobox } from "@/components/Combobox";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { BoardsError, OutcomeBanner } from "../../Jira";
import { JiraIcon } from "../../ProviderIcon";
import { useGithubRepos } from "../../useGithub";
import {
  useJira,
  useJiraBoards,
  useJiraOutcome,
  type JiraBoard as Board,
} from "../../useJira";
import {
  BacklogScan,
  SizeAllDialog,
  useBacklogScan,
  type RepositoryAction,
} from "./BacklogScan";

export interface RememberedBoard {
  connectionId: string;
  boardId: string;
}

/** The key home used when the scan was there, kept so the pick survives. */
function boardKey(userId: string, organizationId: string): string {
  return `lunox:home-board:${userId}:${organizationId}`;
}

/**
 * Storage can be missing or throw — a private window, blocked site data — and
 * the page must still render, so every access is guarded and a miss reads as
 * nothing remembered.
 */
export function readScanBoard(
  userId: string,
  organizationId: string,
): RememberedBoard | null {
  try {
    const raw = window.localStorage.getItem(boardKey(userId, organizationId));
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<RememberedBoard> | null;
    return typeof parsed?.connectionId === "string" &&
      typeof parsed.boardId === "string"
      ? { connectionId: parsed.connectionId, boardId: parsed.boardId }
      : null;
  } catch {
    return null;
  }
}

export function writeScanBoard(
  userId: string,
  organizationId: string,
  board: RememberedBoard,
): void {
  try {
    window.localStorage.setItem(
      boardKey(userId, organizationId),
      JSON.stringify(board),
    );
  } catch {
    // Not remembered; the scan falls back to the workspace's first board.
  }
}

export function BoardScan({
  userId,
  organizationId,
  organizationSlug,
  canManage,
  repositoryAction,
  githubAvailable,
  fallback,
}: {
  userId: string;
  organizationId: string;
  organizationSlug: string;
  /** Owner or admin: may size a ticket or the board, and reconnect a site. */
  canManage: boolean;
  /** How a workspace with no repository gets one; see `BacklogScan`. */
  repositoryAction?: RepositoryAction | undefined;
  /** The server offers GitHub: sizing asks for a repository first. */
  githubAvailable: boolean;
  /** Shown when the workspace has no board to open. */
  fallback: ReactNode;
}) {
  const { boards, loading, error, refresh } = useJiraBoards(organizationId);
  const { connections, connect } = useJira(organizationId);
  const { repos } = useGithubRepos(organizationId);
  const { outcome, missingScopes, dismiss } = useJiraOutcome();
  // Held in state, not only in storage: choosing a board in the picker has
  // to re-render, and a write to storage does not.
  const [chosenId, setChosenId] = useState<string | undefined>(
    () => readScanBoard(userId, organizationId)?.boardId,
  );

  if (loading) return <LoadingLine />;

  // Checked against the list rather than trusted: a board removed since, or a
  // site disconnected, would otherwise open on a scan with nothing behind it.
  const board =
    boards.find((candidate) => candidate.id === chosenId) ?? boards[0];

  if (board === undefined) {
    // Not known to have none: a list that failed is said to have failed,
    // rather than passed off as a workspace with no board yet.
    if (error !== null && boards.length === 0)
      return (
        <div className="flex flex-col items-start gap-3">
          <ErrorBanner className="mt-0">
            Could not load this workspace&rsquo;s boards.
          </ErrorBanner>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
          >
            <RefreshCw />
            Try again
          </Button>
        </div>
      );
    return <>{fallback}</>;
  }

  const site = connections.find(({ id }) => id === board.connectionId);
  // Any of them may be what a ticket's work touches: the board names none.
  const repositories = repos.filter(isWorkspaceSource);

  return (
    <div className="flex flex-col gap-6" data-testid="board-scan">
      {outcome !== null && (
        <OutcomeBanner
          outcome={outcome}
          missingScopes={missingScopes}
          onDismiss={dismiss}
        />
      )}

      <BoardBar
        // A different board is a different menu: its counts are its own.
        key={board.id}
        boards={boards}
        current={board}
        siteName={site?.siteName}
        organizationId={organizationId}
        canManage={canManage}
        needsCode={githubAvailable && repositories.length === 0}
        onChoose={(next) => {
          setChosenId(next.id);
          writeScanBoard(userId, organizationId, {
            connectionId: next.connectionId,
            boardId: next.id,
          });
        }}
      />

      {error !== null && (
        <BoardsError
          error={error}
          onReconnect={canManage ? () => connect() : undefined}
          onRetry={() => void refresh()}
        />
      )}

      <BacklogScan
        // Keyed by the board: a different board is a different scan, not
        // the same one with new tickets.
        key={`${organizationId}:${board.id}`}
        organizationId={organizationId}
        organizationSlug={organizationSlug}
        boardId={board.id}
        canManage={canManage}
        repositories={repositories}
        repositoryAction={repositoryAction}
        githubAvailable={githubAvailable}
      />
    </div>
  );
}

/**
 * The board being scanned, as a bar: the picker for another board, under
 * Jira's mark, and the menu of what applies to the whole board.
 */
function BoardBar({
  boards,
  current,
  siteName,
  organizationId,
  canManage,
  needsCode,
  onChoose,
}: {
  boards: Board[];
  current: Board;
  siteName: string | undefined;
  organizationId: string;
  canManage: boolean;
  /** No repository to size beside yet: GitHub comes first. */
  needsCode: boolean;
  onChoose: (board: Board) => void;
}) {
  const { preview, summary, sizingAvailable, boardRun, sized } = useBacklogScan(
    organizationId,
    current.id,
  );
  const [confirming, setConfirming] = useState(false);
  const candidates = summary?.candidates ?? 0;

  /** Why "Size all" cannot be chosen now, or null when it can. */
  const sizeAllBlocked = !canManage
    ? "An owner or admin can size the board"
    : !sizingAvailable
      ? "Sizing is not configured here"
      : needsCode
        ? "Needs GitHub connected first"
        : boardRun !== undefined
          ? "Sizing the board now"
          : summary === null
            ? "Scanning…"
            : candidates === 0
              ? "Nothing left to size"
              : null;

  return (
    <div
      className="bg-card flex min-w-0 items-center gap-1.5 rounded-xl border p-1.5 shadow-xs"
      data-testid="board-bar"
    >
      <Combobox
        label="Boards"
        searchPlaceholder="Search boards…"
        emptyMessage="No boards match."
        contentClassName="w-72"
        options={boards.map((board) => ({
          value: board.id,
          label: board.name,
          detail: board.projectKey ?? undefined,
        }))}
        value={current.id}
        onValueChange={(boardId) => {
          const board = boards.find(({ id }) => id === boardId);
          if (board !== undefined) onChoose(board);
        }}
        trigger={
          <button
            type="button"
            aria-label={`Switch board — ${current.name}`}
            className="hover:bg-muted/70 data-[state=open]:bg-muted focus-visible:ring-ring/50 flex h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-[#2684FF]/8 [&_svg]:size-[1.125rem]">
              <JiraIcon />
            </span>
            <span className="flex min-w-0 flex-col">
              {/* Jira's mark already says it is a board: the site is enough. */}
              <span className="text-muted-foreground truncate text-xs leading-4">
                {siteName ?? "Board"}
              </span>
              <span className="truncate text-[0.9375rem] leading-5 font-semibold tracking-tight">
                {current.name}
                {current.projectKey !== null &&
                  !namesKey(current.name, current.projectKey) && (
                    <span className="text-muted-foreground ml-1.5 font-mono text-xs font-normal">
                      {current.projectKey}
                    </span>
                  )}
              </span>
            </span>
            <ChevronsUpDown className="text-muted-foreground ml-auto size-4 shrink-0" />
          </button>
        }
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Board actions"
            title="Board actions"
            className="text-muted-foreground hover:text-foreground data-[state=open]:bg-muted size-9 shrink-0"
          >
            {boardRun !== undefined || preview.isFetching ? (
              <Loader2 className="animate-spin" />
            ) : (
              <EllipsisVertical />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem
            disabled={sizeAllBlocked !== null}
            onSelect={() => setConfirming(true)}
            className="items-start"
          >
            <Sparkles className="mt-0.5" />
            <span className="flex flex-col">
              <span>
                {candidates > 0
                  ? `Size all ${candidates} ${candidates === 1 ? "ticket" : "tickets"}…`
                  : "Size all…"}
              </span>
              <span className="text-muted-foreground text-xs">
                {sizeAllBlocked ?? "One model call per ticket"}
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={preview.isFetching}
            onSelect={() => void preview.refetch()}
          >
            <RefreshCw />
            {preview.isFetching ? "Scanning…" : "Scan again"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {candidates > 0 && (
        <SizeAllDialog
          organizationId={organizationId}
          boardId={current.id}
          count={candidates}
          open={confirming}
          onOpenChange={setConfirming}
          onStarted={sized}
        />
      )}
    </div>
  );
}

/** Jira's default board name, "BOX board", already says its key. */
function namesKey(name: string, key: string): boolean {
  return name.split(/\s+/).some((word) => word.toUpperCase() === key);
}

/** Said in place of the scan when the account that connected sees no board. */
export function NoBoards({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-8 text-center text-sm">
      Jira is connected, but the account that connected it can see no boards
      yet. Boards made since are picked up from the{" "}
      <button
        type="button"
        className="text-foreground underline underline-offset-2"
        onClick={onOpenSettings}
      >
        Jira settings
      </button>
      .
    </p>
  );
}
