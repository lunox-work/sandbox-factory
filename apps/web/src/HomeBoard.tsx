/**
 * Home for a workspace with Jira: a board, not a list of the places boards
 * come from.
 *
 * Home opens straight on a board of the active organization — the one last
 * opened there, or failing that its first — so a reload lands where the
 * person left off. The board shows its backlog scan (see `JiraBoard`),
 * under home's own greeting and checklist, which `Home` hands in as
 * `intro`.
 *
 * Remembered per person and per organization, so switching organization in
 * the rail moves home to that organization's board rather than keeping one
 * that is not its. An organization with no board yet shows `fallback`.
 */

import { ChevronDown, LayoutList, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Combobox } from "@/components/Combobox";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { Button } from "@/components/ui/button";

import type { RepositoryAction } from "./features/onboarding/BacklogScan";
import { BoardIcon, JiraBoard } from "./Jira";
import { bountiesUrl } from "./routes";
import { useJiraBoards, type JiraBoard as Board } from "./useJira";

export interface RememberedBoard {
  connectionId: string;
  boardId: string;
}

function boardKey(userId: string, organizationId: string): string {
  return `lunox:home-board:${userId}:${organizationId}`;
}

/**
 * Storage can be missing or throw — a private window, blocked site data — and
 * home must still render, so every access is guarded and a miss reads as
 * nothing remembered.
 */
export function readHomeBoard(
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

export function writeHomeBoard(
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
    // Not remembered; home falls back to the organization's first board.
  }
}

/**
 * Which board home is showing, and the way to another.
 *
 * Also the way out to the board's bounties: the list narrowed to the
 * board, which its scan's tickets were imported into.
 */
function BoardPicker({
  boards,
  current,
  organizationSlug,
  onChoose,
  onOpenBoard,
}: {
  boards: Board[];
  current: Board;
  organizationSlug: string;
  onChoose: (board: Board) => void;
  onOpenBoard: (board: Board) => void;
}) {
  return (
    <Combobox
      label="Boards"
      searchPlaceholder="Search boards…"
      emptyMessage="No boards match."
      contentClassName="w-64"
      options={boards.map((board) => ({
        value: board.id,
        label: board.name,
        icon: (
          <span className="text-muted-foreground [&_svg]:size-4">
            <BoardIcon boardType={board.boardType} />
          </span>
        ),
      }))}
      value={current.id}
      onValueChange={(boardId) => {
        const board = boards.find(({ id }) => id === boardId);
        if (board !== undefined) onChoose(board);
      }}
      actions={[
        {
          key: "open",
          label: "Open its bounties",
          icon: <LayoutList />,
          href: bountiesUrl(null, {
            board: { workspace: organizationSlug, boardId: current.id },
          }),
          onSelect: () => onOpenBoard(current),
        },
      ]}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Switch board — ${current.name}`}
          className="text-foreground data-[state=open]:bg-accent -ml-1 h-7 max-w-full gap-1.5 px-1.5 [&_svg]:size-4"
        >
          <span className="text-muted-foreground shrink-0">
            <BoardIcon boardType={current.boardType} />
          </span>
          <span className="min-w-0 truncate">{current.name}</span>
          <ChevronDown className="text-muted-foreground shrink-0" />
        </Button>
      }
    />
  );
}

export function HomeBoard({
  userId,
  organizationId,
  organizationSlug,
  role,
  intro,
  repositoryAction,
  onOpenBoard,
  fallback,
}: {
  userId: string;
  organizationId: string;
  organizationSlug: string;
  role: string;
  /** Home's greeting and checklist, above the board. */
  intro: ReactNode;
  /** How a workspace with no repository gets one; see `JiraBoard`. */
  repositoryAction?: RepositoryAction | undefined;
  /** Leaves home for the board's bounties. */
  onOpenBoard: (board: Board) => void;
  /** Shown when the organization has no board to open. */
  fallback: ReactNode;
}) {
  const { boards, loading, error, refresh } = useJiraBoards(organizationId);
  // Held in state, not only in storage: choosing a board in the picker has
  // to re-render, and a write to storage does not.
  const [chosenId, setChosenId] = useState<string | undefined>(
    () => readHomeBoard(userId, organizationId)?.boardId,
  );

  if (loading) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <LoadingLine />
      </main>
    );
  }

  // Checked against the list rather than trusted: a board removed since, or a
  // site disconnected, would otherwise open on a page with nothing behind it.
  const board =
    boards.find((candidate) => candidate.id === chosenId) ?? boards[0];

  if (board === undefined) {
    // Not known to have none: a list that failed is said to have failed,
    // rather than passed off as a workspace with no board yet.
    if (error !== null && boards.length === 0)
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
          {intro}
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
        </main>
      );
    return <>{fallback}</>;
  }

  return (
    <JiraBoard
      // Keyed by the board, as on its own screen: a different board is a
      // different page, not the same one with new tickets.
      key={`${organizationId}:${board.id}`}
      organizationId={organizationId}
      organizationSlug={organizationSlug}
      boardId={board.id}
      role={role}
      repositoryAction={repositoryAction}
      header={
        <header className="flex flex-col gap-6">
          {intro}
          <div className="text-muted-foreground -mb-2 flex min-w-0 items-center gap-1 text-sm">
            <span className="shrink-0">Board</span>
            <BoardPicker
              boards={boards}
              current={board}
              organizationSlug={organizationSlug}
              onChoose={(next) => {
                setChosenId(next.id);
                writeHomeBoard(userId, organizationId, {
                  connectionId: next.connectionId,
                  boardId: next.id,
                });
              }}
              onOpenBoard={onOpenBoard}
            />
          </div>
        </header>
      }
    />
  );
}
