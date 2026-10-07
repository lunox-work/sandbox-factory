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

import { ChevronDown, LayoutList, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Combobox } from "@/components/Combobox";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { OutcomeNotice } from "@/components/OutcomeNotice";
import { Button } from "@/components/ui/button";

import { describeGithubOutcome } from "./Github";
import { BoardIcon, JiraBoard } from "./Jira";
import { pathForScreen } from "./routes";
import { useGithubOutcome } from "./useGithub";
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
          label: "Open board page",
          icon: <LayoutList />,
          href: pathForScreen(
            "org-jira-board",
            organizationSlug,
            current.connectionId,
            current.id,
          ),
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
  const { boards, loading, error, refresh } = useJiraBoards(organizationId);
  /*
    A GitHub flow that could not be tied to a workspace lands on home. The
    connections page reports it when it is what home shows; over a board it
    has to be reported here, or the outcome is lost and stays in the URL.
  */
  const github = useGithubOutcome();
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

  const notice = github.outcome !== null && (
    <OutcomeNotice
      {...describeGithubOutcome(github.outcome, "home")}
      onDismiss={github.dismiss}
      testId="github-outcome"
    />
  );

  if (board === undefined) {
    // Not known to have none: a list that failed is said to have failed,
    // rather than passed off as a workspace with no board yet.
    if (error !== null && boards.length === 0)
      return (
        <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
          <div className="flex flex-col items-start gap-3">
            {notice}
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
    // The outcome was taken from the URL on mount, so the fallback's own
    // reading finds nothing: it is shown here, above it.
    return (
      <>
        {notice !== false && (
          <div className="mx-auto w-full max-w-5xl px-4 pt-10 sm:px-6 sm:pt-14">
            {notice}
          </div>
        )}
        {fallback}
      </>
    );
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
          {notice !== false && <div className="mb-6">{notice}</div>}
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
