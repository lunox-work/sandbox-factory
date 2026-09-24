/**
 * Connected Jira sites, for one organization.
 *
 * The list is the Jira tab of the organization's settings, under Connections,
 * rather than a page of its own, and so is everything about one site; only a
 * board is still a page. The tab
 * is where a client lands after consenting, which is why the outcome banner is
 * the first thing it renders: they have just been through
 * Atlassian's consent screen and need to know whether it worked, and if not,
 * what to do about it.
 *
 * What may be done depends on the caller's role, which comes from the API
 * rather than being inferred here. The server checks it again on every write;
 * hiding a control the API would refuse is courtesy, not security.
 */

import {
  ChevronRight,
  CircleCheck,
  CircleX,
  Columns3,
  EllipsisVertical,
  ExternalLink,
  LayoutGrid,
  Link2,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import { JiraIcon } from "./ProviderIcon";
import { isPlainLeftClick, pathForScreen } from "./routes";
import { BoardBounties } from "./Bounties";

import {
  useJira,
  useJiraBoards,
  useJiraOutcome,
  type JiraBoard,
  type JiraConnection,
  type JiraFetchError,
  type JiraOutcome,
} from "./useJira";

/** Roles that may connect or disconnect, matching the API's own floor. */
function canManage(role: string): boolean {
  return role
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "owner" || entry === "admin");
}

/**
 * What each outcome means, in the words the person needs.
 *
 * `cancelled` and `no-sites` are deliberately not errors: the first is a
 * choice, and the second usually means the account has no Jira product rather
 * than anything being broken.
 */
function describeOutcome(
  outcome: JiraOutcome,
  missingScopes: string[],
): { tone: "ok" | "warn" | "error"; title: string; detail: string } {
  switch (outcome) {
    case "connected":
      return {
        tone: "ok",
        title: "Jira connected",
        detail:
          "We can read the boards on that site, and approvals will post back to its tickets.",
      };
    case "cancelled":
      return {
        tone: "warn",
        title: "Connection cancelled",
        detail: "Nothing was changed. You can try again whenever you like.",
      };
    case "no-sites":
      return {
        tone: "warn",
        title: "No Jira site was granted",
        detail:
          "The Atlassian account you used has no Jira site, or you granted only Confluence. Try again with an account that can see the board you want.",
      };
    case "partial-scopes":
      return {
        tone: "warn",
        title: "Connected, but some permissions are missing",
        detail: describeMissingScopes(missingScopes),
      };
    case "denied":
      return {
        tone: "error",
        title: "Atlassian refused the connection",
        detail:
          "The authorisation could not be completed. Try connecting again.",
      };
    case "state":
      return {
        tone: "error",
        title: "That connection link could not be verified",
        detail:
          "It may have expired, or been started in another browser. Start again from this page.",
      };
    case "forbidden":
      return {
        tone: "error",
        title: "You are no longer allowed to connect a site",
        detail:
          "Your role in this workspace changed while you were on Atlassian. Nothing was connected. Ask an owner or admin to do it.",
      };
    case "error":
      return {
        tone: "error",
        title: "Something went wrong",
        detail: "The connection did not complete. Try again.",
      };
  }
}

/**
 * What a withheld scope costs, in the words of what stops working.
 *
 * The write scope is named apart from the read ones because its remedy is
 * different in kind: a site connected without it still works, read-only,
 * and approvals simply stay here — whereas a missing read scope makes boards
 * read as "not found", which nobody would guess was a permission.
 */
function describeMissingScopes(missingScopes: string[]): string {
  const reads = missingScopes.filter((scope) => scope !== "write:jira-work");
  const writeMissing = reads.length !== missingScopes.length;
  const parts: string[] = [];
  if (reads.length > 0) {
    parts.push(
      `Reading boards needs ${reads.join(" and ")}. These are granular scopes: on the Atlassian console they are under the "Granular scopes" tab rather than the classic list. Without them a board reads as "not found" rather than "not permitted".`,
    );
  }
  if (writeMissing) {
    parts.push(
      "Without write:jira-work approvals stay here rather than posting to the ticket. Connect the site again to grant it.",
    );
  }
  return parts.length === 0
    ? "Boards and sprints may not be readable."
    : parts.join(" ");
}

/**
 * The result of a just-finished OAuth round trip.
 *
 * Exported because the flow can return to either surface: `returnTo` carries
 * the path it started from, so a connection begun on the home screen reports
 * there, and one begun here reports here.
 */
export function OutcomeBanner({
  outcome,
  missingScopes,
  onDismiss,
}: {
  outcome: JiraOutcome;
  missingScopes: string[];
  onDismiss: () => void;
}) {
  const { tone, title, detail } = describeOutcome(outcome, missingScopes);
  /*
    Border and a faint wash of the same colour, matching `ErrorBanner`: the
    border alone was thin enough that the banner read as a stray input rather
    than as the page answering a round trip through Atlassian.
  */
  const skin =
    tone === "ok"
      ? "border-emerald-500/40 bg-emerald-500/7"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/7"
        : "border-destructive/40 bg-destructive/7";
  const Icon =
    tone === "ok" ? CircleCheck : tone === "warn" ? TriangleAlert : CircleX;
  const iconTone =
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-500"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-500"
        : "text-destructive";

  return (
    /*
      Title over detail, and the detail free to wrap.

      On one line with `truncate` it was clipped even for the shortest of
      these sentences. The worst case is `partial-scopes`, whose detail names
      the two scopes to grant and the tab they hide behind — instructions,
      cut off mid-word, for the one outcome a person has to act on.

      `alert` for a failure, which should interrupt, and `status` for the rest,
      which should wait until the reader is idle. It had neither, so a screen
      reader said nothing at all when the flow came back.
    */
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-lg border ${skin} px-3 py-2.5 text-sm`}
      data-testid="jira-outcome"
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${iconTone}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p
          className="text-muted-foreground mt-0.5"
          data-testid="jira-outcome-detail"
        >
          {detail}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="-my-2 -mr-2 size-10 shrink-0 [@media(pointer:coarse)]:size-11"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

/**
 * One connected site, as a way to its boards.
 *
 * The whole row is the target rather than a link on the name: there is one
 * destination per row and nothing else to press, so anything less than the
 * full row is a miss the layout invented. The chevron says so — the mark that
 * a row goes somewhere, which a row of plain text does not. A site has no
 * page of its own, so the destination is the Jira tab of its organization's
 * settings, where its boards are listed; the caller supplies that `href`.
 *
 * The Jira mark rather than Atlassian's, because what is being named is the
 * product whose boards get read. Signing in is the other one.
 *
 * Exported for the home screen, which lists every organization's sites,
 * grouped by owner.
 */
const destinationRowClass =
  "focus-visible:ring-ring/50 flex w-full items-center gap-3.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:outline-none";

export function ConnectionRow({
  connection,
  href,
  onOpen,
}: {
  connection: JiraConnection;
  href: string;
  onOpen: (connection: JiraConnection) => void;
}) {
  return (
    <li>
      <a
        href={href}
        className={destinationRowClass}
        onClick={(event) => {
          if (isPlainLeftClick(event)) {
            event.preventDefault();
            onOpen(connection);
          }
        }}
      >
        <span className="size-5 shrink-0">
          <JiraIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{connection.siteName}</span>
            {!connection.healthy && (
              <Badge variant="destructive" className="gap-1">
                <TriangleAlert className="size-3" />
                Reconnect
              </Badge>
            )}
            {connection.healthy && !connection.writeGranted && (
              /*
                A site connected before every consent asked for the write
                scope, or whose admin withheld it. Approvals on its boards
                stay here. Connecting it again is the remedy, and this is
                the page that button is on.
              */
              <Badge variant="outline">Read-only</Badge>
            )}
          </span>
          <span className="block truncate text-sm text-muted-foreground">
            {connection.siteUrl}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </a>
    </li>
  );
}

/** A Jira read that failed, in the words the person can act on. */
function BoardsError({
  error,
  onReconnect,
  onRetry,
}: {
  error: JiraFetchError;
  onReconnect?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  if (error.kind === "reconnect") {
    return (
      <div className="flex flex-col items-start gap-2">
        <ErrorBanner className="mt-0">
          That site&rsquo;s connection has expired or been revoked.
        </ErrorBanner>
        {onReconnect !== undefined && (
          <Button type="button" size="sm" onClick={onReconnect}>
            <RefreshCw />
            Reconnect
          </Button>
        )}
      </div>
    );
  }
  if (error.kind === "scope") {
    return (
      <ErrorBanner className="mt-0" data-testid="jira-scope-error">
        {error.message}
      </ErrorBanner>
    );
  }
  if (error.kind === "jira") {
    return (
      <ErrorBanner className="mt-0">
        Jira refused that request. If the site was connected without the board
        permissions, reconnect it and grant them.
      </ErrorBanner>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <ErrorBanner className="mt-0">{error.message}</ErrorBanner>
      {onRetry !== undefined && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw />
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * The mark for a board, by the kind of board it is.
 *
 * Jira reports `scrum`, `kanban`, or nothing — `unknown` is ours, for a site
 * that did not say. Three columns for a Kanban board and a sprint's repeat
 * for a Scrum one, because that is the difference a person is scanning for:
 * a Kanban board has no backlog of its own, which is why the preview reads it
 * through a different endpoint.
 *
 * Compared lowercased: the type is Jira's string, and a site is free to send
 * `Kanban`.
 */
export function BoardIcon({ boardType }: { boardType: string }) {
  const kind = boardType.toLowerCase();
  if (kind === "kanban") {
    return <Columns3 className="size-5" />;
  }
  if (kind === "scrum") {
    return <RefreshCw className="size-5" />;
  }
  // Not a guess at one of the two: a board whose type we do not know should
  // not be drawn as though we did.
  return <LayoutGrid className="size-5" />;
}

/**
 * One registered board, as a way into its tickets.
 *
 * The same row as a connected site one level up, for the same reason: there
 * is one destination and nothing else to press, so the whole row is the
 * target and the chevron says it leads somewhere. It replaced a "Preview"
 * button, which named the mechanism rather than the destination.
 */
function BoardRow({
  board,
  href,
  onOpen,
}: {
  board: JiraBoard;
  href: string;
  onOpen: (board: JiraBoard) => void;
}) {
  return (
    <li>
      <a
        href={href}
        className={cn(destinationRowClass, "gap-3 py-1.5")}
        onClick={(event) => {
          if (isPlainLeftClick(event)) {
            event.preventDefault();
            onOpen(board);
          }
        }}
      >
        <span className="text-muted-foreground shrink-0 [&_svg]:size-4">
          <BoardIcon boardType={board.boardType} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {board.name}
        </span>
        {/*
          Pills at the end of the row rather than a second line under the
          name: they are labels to scan down, and a line of their own made
          every row twice as tall as the name needed.
        */}
        <span className="flex shrink-0 items-center gap-1.5">
          {board.projectKey !== null && (
            <Badge variant="secondary" className="font-mono">
              {board.projectKey}
            </Badge>
          )}
          <Badge variant="outline" className="text-muted-foreground capitalize">
            {board.boardType}
          </Badge>
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0" />
      </a>
    </li>
  );
}

/**
 * One site's boards, and what there is to do with the site.
 *
 * Every board on a connected site is already registered — connecting is the
 * decision, and a board row is a pointer that reads nothing until somebody
 * opens it. So this card never offers to add one. What it does instead is
 * re-read the site when it mounts, and again on Re-sync, which is what picks
 * up a board created in Jira since the site was connected — and starts
 * sizing it in the background.
 *
 * Re-sync and Disconnect sit behind one menu in the corner rather than as
 * buttons in the header. Neither is what the card is for — the boards are —
 * and in a list with a card per site, a row of buttons on each read as the
 * list's actions rather than the site's. Disconnect still asks first, from
 * the menu, because it takes the boards and the grant with it.
 *
 * Drawn flat and tighter than a page's card: it sits inside the settings'
 * Connections card, and a full card there — shadow, large radius, page-level
 * padding — read as a second page stacked on the first.
 *
 * Scoped to one connection: the hook holds the organization's boards, which
 * is what the API answers with, and each card shows its own site's.
 */
function SiteBoardsCard({
  organizationId,
  organizationSlug,
  connection,
  role,
  onReconnect,
  onDisconnect,
  onOpenBoard,
}: {
  organizationId: string;
  organizationSlug: string;
  connection: JiraConnection;
  role: string;
  onReconnect: () => void;
  /** Resolves to an error to show in the question, or nothing on success. */
  onDisconnect: () => Promise<string | undefined>;
  onOpenBoard: (board: JiraBoard) => void;
}) {
  const { boards, loading, error, sync } = useJiraBoards(organizationId);
  const [syncing, setSyncing] = useState(true);
  // What the last sync found, said once under the header: how many boards
  // are new, since those are the ones now being sized in the background.
  const [found, setFound] = useState<number | null>(null);
  // Held here rather than by the dialog: it is opened from a menu item, and
  // the menu closes — taking any trigger inside it along — as it is chosen.
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const manageable = canManage(role);

  /*
    Re-read on mount, rather than on a timer.

    A client creates boards in Jira and nothing tells us, so the registered
    list goes stale. Refreshing it here spends one round trip exactly when
    somebody is looking at the list, which is the only moment the staleness
    matters. A dead connection is left alone: the sync would fail, and the
    reconnect notice is already on screen.
  */
  useEffect(() => {
    if (!connection.healthy) {
      setSyncing(false);
      return;
    }
    let live = true;
    void sync(connection.id).then((added) => {
      if (live) {
        setSyncing(false);
        if (added !== null && added.length > 0) setFound(added.length);
      }
    });
    return () => {
      live = false;
    };
  }, [connection.healthy, connection.id, sync]);

  /*
    The same re-read, on request. Mounting already does it; the item is for
    someone who has just made a board in Jira and does not want to reload to
    see it.
  */
  async function resync() {
    setSyncing(true);
    setFound(null);
    const added = await sync(connection.id);
    setSyncing(false);
    if (added !== null) setFound(added.length);
  }

  const siteBoards = boards.filter(
    (board) => board.connectionId === connection.id,
  );
  const busy = loading || syncing;

  return (
    <Card className="gap-4 rounded-lg py-4 shadow-none sm:gap-4 sm:py-4">
      <CardHeader className="flex flex-row items-start justify-between gap-4 px-4 sm:px-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 size-5 shrink-0">
            <JiraIcon />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              <span className="truncate">{connection.siteName}</span>
              {!connection.healthy && (
                <Badge variant="destructive" className="gap-1">
                  <TriangleAlert className="size-3" />
                  Connection expired
                </Badge>
              )}
              {connection.healthy && !connection.writeGranted && (
                // Approvals on its boards stay here; connecting the site
                // again is the remedy.
                <Badge variant="outline">Read-only</Badge>
              )}
            </CardTitle>
            <CardDescription>
              <a
                href={connection.siteUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex max-w-full items-center gap-1 hover:underline"
              >
                <span className="truncate">{connection.siteUrl}</span>
                <ExternalLink className="size-3 shrink-0" />
              </a>
            </CardDescription>
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="-my-1 -mr-2 shrink-0"
              aria-label={`${connection.siteName} options`}
            >
              {syncing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <EllipsisVertical className="size-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              disabled={syncing || !connection.healthy}
              onSelect={() => void resync()}
            >
              <RefreshCw />
              Re-sync
            </DropdownMenuItem>
            {manageable && !connection.healthy && (
              <DropdownMenuItem onSelect={onReconnect}>
                <Link2 />
                Reconnect
              </DropdownMenuItem>
            )}
            {manageable && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={disconnecting}
                  onSelect={() => setConfirming(true)}
                >
                  <Trash2 />
                  Disconnect
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {manageable && (
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Disconnect ${connection.siteName}?`}
            description="Removes our access, every registered board, and local proposal history. Comments already posted to Jira remain. Atlassian keeps its own grant until you revoke it in your account settings."
            confirmLabel="Disconnect"
            busy={disconnecting}
            onConfirm={async () => {
              setDisconnecting(true);
              try {
                return await onDisconnect();
              } finally {
                setDisconnecting(false);
              }
            }}
          />
        )}
      </CardHeader>
      {/* Edge to edge: the site above, what is on it below. */}
      <Separator />
      <CardContent className="flex flex-col gap-4 px-4 sm:px-4">
        {!connection.healthy &&
          (manageable ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm">
                Reconnect this site to read its boards again.
              </p>
              <Button type="button" size="sm" onClick={onReconnect}>
                <RefreshCw />
                Reconnect
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              Ask an owner or admin to reconnect this site.
            </p>
          ))}

        {error !== null && <BoardsError error={error} />}

        {found !== null && (
          <p className="text-muted-foreground text-sm" role="status">
            {found === 0
              ? "No new boards."
              : `Found ${found} new board${found === 1 ? "" : "s"} — sizing started.`}
          </p>
        )}

        {busy && siteBoards.length === 0 ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Reading this site&rsquo;s boards…
          </p>
        ) : siteBoards.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No boards on this site are visible to the connected account.
          </p>
        ) : (
          <ul className="-mx-3 divide-y">
            {siteBoards.map((board) => (
              <BoardRow
                key={board.id}
                board={board}
                href={pathForScreen(
                  "org-jira-board",
                  organizationSlug,
                  connection.id,
                  board.id,
                )}
                onOpen={onOpenBoard}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One board: its tickets on the left, the one you picked on the right.
 *
 * A split rather than a dialog with two views. The dialog made reading a
 * ticket cost the list — going back was the only way to reach the next one,
 * and comparing two meant opening each in turn from memory. Here the list
 * stays put and the panel changes under it, which is what a person scanning
 * a backlog is actually doing.
 *
 * Below `md` the panel covers the list instead of sitting beside it, with a
 * control back. Two columns on a phone would each be too narrow to hold a
 * ticket summary, let alone a spec.
 */
export function JiraBoard({
  organizationId,
  connectionId,
  boardId,
  boardName,
  onBoardName,
  role,
  header,
}: {
  organizationId: string;
  /** The site this board is on, for its write grant. */
  connectionId: string;
  boardId: string;
  /** Known already when arriving from the Jira list; absent on a reload. */
  boardName?: string | undefined;
  /**
   * Reports the board's name up to the shell, which renders the trail above
   * this page and has no other way to learn it. Called with undefined while
   * the list is still arriving, so the crumb falls back rather than keeping
   * the previous board's name.
   */
  onBoardName: (name: string | undefined) => void;
  role?: string | undefined;
  /**
   * Replaces the board's own heading. Home shows this page under a greeting
   * rather than a board title: there it is where the person starts, not a
   * place they navigated to.
   */
  header?: ReactNode;
}) {
  const { boards, error, issue } = useJiraBoards(organizationId);
  const { connections, connect } = useJira(organizationId);
  const { outcome, missingScopes, dismiss } = useJiraOutcome();

  const board = boards.find((candidate) => candidate.id === boardId) ?? null;
  // The name passed in wins while the list is still arriving, so arriving
  // from the Jira list does not flash a heading that says nothing.
  const name = board?.name ?? boardName;

  useEffect(() => {
    onBoardName(name);
  }, [name, onBoardName]);

  /*
    The ticket read the peek's Spec tab uses, bound to this board. Memoised
    because the proposals component keys a fetch effect on it: a fresh
    closure each render would read the ticket on every render.
  */
  const readIssue = useCallback(
    (issueKey: string) => issue(boardId, issueKey),
    [boardId, issue],
  );

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      {header ?? (
        <header>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground shrink-0">
              <BoardIcon boardType={board?.boardType ?? ""} />
            </span>
            <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">
              {name ?? "Board"}
            </h1>
          </div>
          <p className="text-muted-foreground mt-1.5 text-sm">
            Sizing proposals for this board. Open one to review it against the
            live ticket.
          </p>
        </header>
      )}

      {outcome !== null && (
        <OutcomeBanner
          outcome={outcome}
          missingScopes={missingScopes}
          onDismiss={dismiss}
        />
      )}

      {error !== null && (
        <BoardsError
          error={error}
          onReconnect={canManage(role ?? "") ? () => connect() : undefined}
        />
      )}

      <BoardBounties
        organizationId={organizationId}
        boardId={boardId}
        role={role ?? "member"}
        writeGranted={
          connections.find((candidate) => candidate.id === connectionId)
            ?.writeGranted ?? false
        }
        readIssue={readIssue}
      />
    </main>
  );
}

/**
 * The connected sites, each with its boards: the Jira tab of an
 * organization's Connections.
 *
 * A card per site rather than a list of sites to open one at a time: the
 * boards are what a person comes here for, and a list that named the sites
 * made reaching any board a two-step trip through a page that showed little
 * else. What there is to do to a site — re-sync it, disconnect it — sits in
 * that card's menu, so each control's target is the card it is in.
 *
 * No `main` and no page heading: this is one panel of the settings page,
 * which owns both. It opens at level three, under that page's Connections.
 */
export function JiraConnections({
  organizationId,
  organizationSlug,
  role,
  onOpenBoard,
}: {
  organizationId: string;
  organizationSlug: string;
  role: string;
  onOpenBoard: (board: JiraBoard) => void;
}) {
  const { connections, loading, error, connect, disconnect } =
    useJira(organizationId);
  const { outcome, missingScopes, dismiss } = useJiraOutcome();
  const manageable = canManage(role);

  return (
    <div className="flex flex-col gap-5">
      {/*
        No mark beside the heading: the square it was opened from already
        carries it, joined to this card.
      */}
      <header>
        <h3 className="leading-none font-semibold">Jira</h3>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Every board on a connected site is registered when it is connected. We
          never store ticket contents, which are read when a run needs them.
        </p>
      </header>

      {outcome !== null && (
        <OutcomeBanner
          outcome={outcome}
          missingScopes={missingScopes}
          onDismiss={dismiss}
        />
      )}

      {loading && connections.length === 0 ? (
        <LoadingLine />
      ) : error !== null && connections.length === 0 ? (
        <ErrorBanner className="mt-0">{error}</ErrorBanner>
      ) : connections.length === 0 ? (
        /*
          Dashed rather than a card: this is where a site will go, not a
          thing in its own right, and a bordered card inside the settings
          card read as a site that had failed to load.
        */
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          No sites connected yet.
        </p>
      ) : (
        <>
          {error !== null && (
            <ErrorBanner className="mt-0">{error}</ErrorBanner>
          )}
          {connections.map((connection) => (
            <SiteBoardsCard
              key={connection.id}
              organizationId={organizationId}
              organizationSlug={organizationSlug}
              connection={connection}
              role={role}
              onReconnect={() => connect()}
              onDisconnect={async () => {
                const result = await disconnect(connection.id);
                return result.ok ? undefined : result.error;
              }}
              onOpenBoard={onOpenBoard}
            />
          ))}
        </>
      )}

      {/*
        Outside the site cards, and to the right.

        Connecting another site is an action on the list rather than on any
        one site, and inside a card it would read as belonging to that site.
        Trailing the cards on the right is where this app puts the action a
        panel is for, which is also the corner the eye finishes a list in.
      */}
      {manageable ? (
        <div className="flex justify-end">
          <Button className="gap-2" onClick={() => connect()}>
            <Link2 className="size-4" />
            {connections.length === 0
              ? "Connect a Jira site"
              : "Connect another site"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only an owner or admin can connect a site.
        </p>
      )}
    </div>
  );
}
