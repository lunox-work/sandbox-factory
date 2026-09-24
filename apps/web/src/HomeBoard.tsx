/**
 * What home shows: a board, not a list of the places boards come from.
 *
 * Sizing proposals are the work, and the connections list sat one site and
 * one board away from them. Home now opens straight on a board of the active
 * organization — the one last opened there, or failing that its first — so a
 * reload lands where the person left off.
 *
 * Remembered per person and per organization, so switching organization in
 * the rail moves home to that organization's board rather than keeping one
 * that is not its. An organization with no board yet falls back to the
 * connections list, which is where a site gets connected.
 */

import { Check, ChevronDown, LayoutList } from "lucide-react";
import { useState, type ReactNode } from "react";

import { LoadingLine } from "@/components/Message";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { BoardIcon, JiraBoard } from "./Jira";
import { isPlainLeftClick, pathForScreen } from "./routes";
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

/** Said by the clock on the person's own machine, which is their day. */
function greeting(now: Date): string {
  const hour = now.getHours();
  return hour < 12
    ? "Good morning"
    : hour < 18
      ? "Good afternoon"
      : "Good evening";
}

/**
 * The first word of the name, for a greeting rather than a form of address.
 * An empty name greets no one rather than greeting a blank.
 */
function firstName(name: string): string | undefined {
  const first = name.trim().split(/\s+/)[0];
  return first === undefined || first === "" ? undefined : first;
}

/**
 * Which board home is showing, and the way to another.
 *
 * Also the way out to the board's own page: home has no trail, and without
 * this the only route to it would be through the organization's settings.
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
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Switch board — ${current.name}`}
          className="text-foreground -ml-1 h-7 max-w-full gap-1.5 px-1.5 [&_svg]:size-4"
        >
          <span className="text-muted-foreground shrink-0">
            <BoardIcon boardType={current.boardType} />
          </span>
          <span className="min-w-0 truncate">{current.name}</span>
          <ChevronDown className="text-muted-foreground shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">
          Boards
        </DropdownMenuLabel>
        {boards.map((board) => {
          const chosen = board.id === current.id;
          return (
            <DropdownMenuItem
              key={board.id}
              aria-current={chosen ? "true" : undefined}
              onSelect={() => onChoose(board)}
              className="[&_svg]:size-4"
            >
              <span className="text-muted-foreground shrink-0">
                <BoardIcon boardType={board.boardType} />
              </span>
              <span className="min-w-0 flex-1 truncate">{board.name}</span>
              {chosen && (
                <Check aria-hidden="true" className="text-foreground" />
              )}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <a
            href={pathForScreen(
              "org-jira-board",
              organizationSlug,
              current.connectionId,
              current.id,
            )}
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                setOpen(false);
                onOpenBoard(current);
              }
            }}
          >
            <LayoutList />
            Open board page
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function HomeBoard({
  userId,
  name,
  organizationId,
  organizationSlug,
  role,
  onBoardName,
  onOpenBoard,
  fallback,
}: {
  userId: string;
  /** The signed-in person's name, for the greeting. */
  name: string;
  organizationId: string;
  organizationSlug: string;
  role: string;
  onBoardName: (name: string | undefined) => void;
  /** Leaves home for the board's own page, with its trail. */
  onOpenBoard: (board: Board) => void;
  /** Shown when the organization has no board to open. */
  fallback: ReactNode;
}) {
  const { boards, loading } = useJiraBoards(organizationId);
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
    return <>{fallback}</>;
  }

  const who = firstName(name);
  const today = new Date();

  return (
    <JiraBoard
      // Keyed by the board, as on its own screen: a different board is a
      // different page, not the same one with new tickets.
      key={`${organizationId}:${board.id}`}
      organizationId={organizationId}
      connectionId={board.connectionId}
      boardId={board.id}
      boardName={board.name}
      onBoardName={onBoardName}
      role={role}
      header={
        <header>
          <p className="text-muted-foreground text-sm">
            {today.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {greeting(today)}
            {who === undefined ? "" : `, ${who}`}
          </h1>
          <div className="text-muted-foreground mt-2 flex min-w-0 items-center gap-1 text-sm">
            <span className="shrink-0">Sizing proposals from</span>
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
