/**
 * Connected Jira sites, for one organization.
 *
 * The page a client lands on after consenting, which is why the outcome
 * banner is the first thing it renders: they have just been through
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
  ExternalLink,
  LayoutGrid,
  Link2,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
          "Your role in this organization changed while you were on Atlassian. Nothing was connected. Ask an owner or admin to do it.",
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
 * One connected site, as a way into it.
 *
 * The whole row is the target rather than a link on the name: there is one
 * destination per row and nothing else to press, so anything less than the
 * full row is a miss the layout invented. The chevron says so — the mark that
 * a row goes somewhere, which a row of plain text does not.
 *
 * The Jira mark rather than Atlassian's, because what is being named is the
 * product whose boards get read. Signing in is the other one.
 *
 * Exported because the home screen lists the same sites, grouped by owner,
 * and listed them as inert text — a row that named a site without being a way
 * into it. One row rather than two that drift apart.
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
function BoardIcon({ boardType }: { boardType: string }) {
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
        className={destinationRowClass}
        onClick={(event) => {
          if (isPlainLeftClick(event)) {
            event.preventDefault();
            onOpen(board);
          }
        }}
      >
        <span className="text-muted-foreground shrink-0">
          <BoardIcon boardType={board.boardType} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{board.name}</span>
          <span className="text-muted-foreground block truncate text-sm">
            {board.boardType}
            {board.projectKey === null ? "" : ` · ${board.projectKey}`}
          </span>
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0" />
      </a>
    </li>
  );
}

/**
 * One site's boards, and the tickets behind them.
 *
 * Every board on a connected site is already registered — connecting is the
 * decision, and a board row is a pointer that reads nothing until somebody
 * previews it. So this card never offers to add one. What it does instead is
 * re-read the site when it opens, which is what picks up a board created in
 * Jira since the site was connected.
 *
 * Scoped to one connection: the page it sits on is about one site, and
 * showing every organization's boards here would undo that.
 */
function BoardsCard({
  organizationId,
  organizationSlug,
  connection,
  onOpenBoard,
}: {
  organizationId: string;
  organizationSlug: string;
  connection: JiraConnection;
  onOpenBoard: (board: JiraBoard) => void;
}) {
  const { boards, loading, error, sync } = useJiraBoards(organizationId);
  const [syncing, setSyncing] = useState(true);

  /*
    Re-read on open, rather than on a timer or a button.

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
    void sync(connection.id).finally(() => {
      if (live) {
        setSyncing(false);
      }
    });
    return () => {
      live = false;
    };
  }, [connection.healthy, connection.id, sync]);

  // This site's boards. The hook holds the organization's, because that is
  // what the API answers with, and the page is about one site.
  const siteBoards = boards.filter(
    (board) => board.connectionId === connection.id,
  );
  const busy = loading || syncing;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Boards</CardTitle>
        <CardDescription>
          Every board on this site, read when it was connected and again just
          now. Open one to see the tickets a run would price — read live from
          Jira, and stored nowhere.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== null && <BoardsError error={error} />}

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
          <ul className="divide-y">
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
  onSiteName,
  role,
}: {
  organizationId: string;
  /** The site this board is on, so the trail can name it. */
  connectionId: string;
  boardId: string;
  /** Known already when arriving from the site page; absent on a reload. */
  boardName?: string | undefined;
  /** Reports the board's name up for the trail; see `JiraSite`. */
  onBoardName: (name: string | undefined) => void;
  /**
   * And the site's, for the crumb above it.
   *
   * Reported from here rather than left to `JiraSite`, which is not mounted
   * on this page: arriving by URL, nothing else has ever read the connection
   * list, so the crumb would read "Site" until the person navigated up.
   */
  onSiteName: (name: string | undefined) => void;
  role?: string | undefined;
}) {
  const { boards, error, issue } = useJiraBoards(organizationId);
  const { connections, connect } = useJira(organizationId);
  const { outcome, missingScopes, dismiss } = useJiraOutcome();

  const board = boards.find((candidate) => candidate.id === boardId) ?? null;
  // The name passed in wins while the list is still arriving, so arriving
  // from the site page does not flash a heading that says nothing.
  const name = board?.name ?? boardName;

  useEffect(() => {
    onBoardName(name);
  }, [name, onBoardName]);

  const siteName = connections.find(
    (candidate) => candidate.id === connectionId,
  )?.siteName;
  useEffect(() => {
    onSiteName(siteName);
  }, [siteName, onSiteName]);

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
          What sizing proposed for this board&rsquo;s tickets. An owner or admin
          reviews each one before it is approved; the ticket itself is read live
          from Jira when a proposal is opened.
        </p>
      </header>

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
 * The connected sites.
 *
 * Each row is a link into the site rather than a row with controls on it.
 * What there is to do with a site — read its boards, preview a backlog,
 * disconnect it — belongs to that one site, and a list that carried all of it
 * inline grew a column of buttons whose target was ambiguous the moment there
 * was more than one row.
 */
export function Jira({
  organizationId,
  organizationSlug,
  organizationName,
  role,
  onOpenSite,
}: {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  role: string;
  onOpenSite: (connection: JiraConnection) => void;
}) {
  const { connections, loading, error, connect } = useJira(organizationId);
  const { outcome, missingScopes, dismiss } = useJiraOutcome();
  const manageable = canManage(role);

  return (
    /*
      `main`, and the same column and padding as every other page: `px-4 py-10
      sm:px-6 sm:py-14`. The breadcrumb above pulls its bottom margin back by
      `-mb-6 sm:-mb-8` so the trail and the page heading read as one header
      block — which only works if the page's own top padding is larger than
      the pull. This page used `p-6`, 24px against a 32px pull, so at `sm` the
      heading rode up into the trail and overlapped it.
    */
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Jira</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Sites {organizationName} can read boards from.
        </p>
      </header>

      {outcome !== null && (
        <OutcomeBanner
          outcome={outcome}
          missingScopes={missingScopes}
          onDismiss={dismiss}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connected sites</CardTitle>
          <CardDescription>
            Connecting lets us read the boards, backlogs and ticket text on a
            site. Every board on it is registered at once — we never store
            ticket contents, which are read when a run needs them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingLine />
          ) : error !== null ? (
            <ErrorBanner className="mt-0">{error}</ErrorBanner>
          ) : connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sites connected yet.
            </p>
          ) : (
            <ul className="divide-y">
              {connections.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  href={pathForScreen(
                    "org-jira-site",
                    organizationSlug,
                    connection.id,
                  )}
                  onOpen={onOpenSite}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/*
        Outside the card, and to the right.

        The card is the list of what is connected; connecting another is an
        action on that list rather than a row in it, and inside the card it
        sat under the last site as though it were one more. Trailing the card
        on the right is where this app puts the action a page is for, which
        is also the corner the eye finishes a list in.
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
    </main>
  );
}

/**
 * One connected site: its boards, and the control that disconnects it.
 *
 * Disconnecting lives here rather than on the list for the same reason the
 * boards do. It is the most consequential thing there is to do with a site —
 * it takes the boards and the grant with it — and a row of bins beside a list
 * of similar names is how the wrong one gets pressed.
 *
 * The site is found in the organization's connection list rather than fetched
 * by id: the list is one request the app already makes, it is what the page
 * before this one was showing, and an endpoint for a single site would exist
 * only to save a lookup over a handful of rows. A URL naming a site that is
 * not in it — a stale bookmark, a site somebody else disconnected — is a
 * miss, which is the same answer the API would give.
 */
export function JiraSite({
  organizationId,
  organizationSlug,
  connectionId,
  role,
  onDisconnected,
  onOpenBoard,
  onSiteName,
}: {
  organizationId: string;
  organizationSlug: string;
  connectionId: string;
  role: string;
  onDisconnected: () => void;
  onOpenBoard: (board: JiraBoard) => void;
  /**
   * Reports the site's name up to the shell, which renders the trail above
   * this page and has no other way to learn it. Called with undefined while
   * the list is still arriving, so the crumb falls back rather than keeping
   * the previous site's name.
   */
  onSiteName: (name: string | undefined) => void;
}) {
  const { connections, loading, error, connect, disconnect, refresh } =
    useJira(organizationId);
  const { outcome, missingScopes, dismiss } = useJiraOutcome();
  const [disconnecting, setDisconnecting] = useState(false);
  const manageable = canManage(role);

  const connection =
    connections.find((candidate) => candidate.id === connectionId) ?? null;

  // In an effect rather than during render: this sets state in the parent,
  // and doing that while rendering a child is the React warning about
  // updating a component from inside another one.
  useEffect(() => {
    onSiteName(connection?.siteName);
  }, [connection?.siteName, onSiteName]);

  if (connection === null) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
        {loading ? (
          <LoadingLine />
        ) : error !== null ? (
          <div className="flex flex-col items-start gap-3">
            <ErrorBanner className="mt-0">{error}</ErrorBanner>
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
        ) : (
          <p className="text-muted-foreground text-sm">
            That site is not connected.
          </p>
        )}
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <div className="flex items-center gap-3">
          <span className="size-6 shrink-0">
            <JiraIcon />
          </span>
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">
            {connection.siteName}
          </h1>
          {!connection.healthy && (
            <Badge variant="destructive" className="gap-1">
              <TriangleAlert className="size-3" />
              Connection expired
            </Badge>
          )}
        </div>
        <a
          href={connection.siteUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted-foreground mt-1.5 inline-flex items-center gap-1 text-sm hover:underline"
        >
          {connection.siteUrl}
          <ExternalLink className="size-3" />
        </a>
      </header>

      {outcome !== null && (
        <OutcomeBanner
          outcome={outcome}
          missingScopes={missingScopes}
          onDismiss={dismiss}
        />
      )}

      {!connection.healthy &&
        (manageable ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <p className="text-sm">
              Reconnect this site to read its boards again.
            </p>
            <Button type="button" size="sm" onClick={() => connect()}>
              <RefreshCw />
              Reconnect
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Ask an owner or admin to reconnect this site.
          </p>
        ))}

      <BoardsCard
        organizationId={organizationId}
        organizationSlug={organizationSlug}
        connection={connection}
        onOpenBoard={onOpenBoard}
        key={connection.id}
      />

      {manageable && (
        <Card>
          <CardHeader>
            <CardTitle>Disconnect this site</CardTitle>
            <CardDescription>
              Removes our access, boards, and local proposal history. Comments
              already posted to Jira remain there. Atlassian keeps its grant
              until you revoke it in your account settings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/*
              Behind a question, because this is the most consequential thing
              there is to do with a site: it takes the boards and the grant
              with it, and the row it was reached from sits in a list of
              near-identical names.
            */}
            <ConfirmDialog
              trigger={
                <Button
                  variant="destructive"
                  className="gap-2"
                  disabled={disconnecting}
                >
                  {disconnecting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  Disconnect {connection.siteName}
                </Button>
              }
              title={`Disconnect ${connection.siteName}?`}
              description="Removes our access, every registered board, and local proposal history. Comments already posted to Jira remain. Atlassian keeps its own grant until you revoke it in your account settings."
              confirmLabel="Disconnect"
              busy={disconnecting}
              onConfirm={async () => {
                setDisconnecting(true);
                try {
                  const result = await disconnect(connection.id);
                  if (!result.ok) {
                    return result.error;
                  }
                  onDisconnected();
                  return;
                } finally {
                  setDisconnecting(false);
                }
              }}
            />
          </CardContent>
        </Card>
      )}
    </main>
  );
}
