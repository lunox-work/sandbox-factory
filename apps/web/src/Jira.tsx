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
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Eye,
  Link2,
  Loader2,
  Plus,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  useJira,
  useJiraBoards,
  useJiraOutcome,
  type BacklogPreview,
  type JiraBoard,
  type JiraConnection,
  type JiraFetchError,
  type JiraIssueDetail,
  type JiraOutcome,
  type JiraRemoteBoard,
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
        detail: "We can now read the boards on that site.",
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
        detail:
          missingScopes.length === 0
            ? "Boards and sprints may not be readable."
            : `Reading boards needs ${missingScopes.join(" and ")}. These are granular scopes: on the Atlassian console they are under the "Granular scopes" tab rather than the classic list. Without them a board reads as "not found" rather than "not permitted".`,
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
  const border =
    tone === "ok"
      ? "border-emerald-500/40"
      : tone === "warn"
        ? "border-amber-500/40"
        : "border-destructive/40";

  return (
    <div
      className={`flex items-center gap-2 rounded-md border ${border} px-3 py-2 text-sm`}
      data-testid="jira-outcome"
    >
      <span className="font-medium">{title}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {detail}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="-mr-1 size-6 shrink-0"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

function ConnectionRow({
  connection,
  manageable,
  onDisconnect,
}: {
  connection: JiraConnection;
  manageable: boolean;
  onDisconnect: (id: string) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{connection.siteName}</span>
          {!connection.healthy && (
            <Badge variant="destructive" className="gap-1">
              <TriangleAlert className="size-3" />
              Reconnect
            </Badge>
          )}
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {connection.siteUrl}
        </p>
      </div>
      {manageable && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Disconnect ${connection.siteName}`}
          onClick={() => {
            onDisconnect(connection.id);
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </li>
  );
}

/** A Jira read that failed, in the words the person can act on. */
function BoardsError({ error }: { error: JiraFetchError }) {
  if (error.kind === "reconnect") {
    return (
      <p className="text-sm text-destructive">
        That site&rsquo;s connection has expired or been revoked. Reconnect it
        above to read its boards again.
      </p>
    );
  }
  if (error.kind === "scope") {
    return (
      <p className="text-sm text-destructive" data-testid="jira-scope-error">
        {error.message}
      </p>
    );
  }
  if (error.kind === "jira") {
    return (
      <p className="text-sm text-destructive">
        Jira refused that request. If the site was connected without the board
        permissions, reconnect it and grant them.
      </p>
    );
  }
  return <p className="text-sm text-destructive">{error.message}</p>;
}

/** How old a ticket is, which is the whole basis of the selection. */
function ageInDays(created: string | null): string {
  if (created === null) {
    return "";
  }
  const days = Math.floor(
    (Date.now() - new Date(created).getTime()) / 86_400_000,
  );
  if (!Number.isFinite(days) || days < 0) {
    return "";
  }
  return days < 365
    ? `${days}d`
    : `${Math.floor(days / 365)}y ${Math.floor((days % 365) / 30)}m`;
}

/** A labelled row in the detail view. Renders nothing when Jira sent no value. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "") {
    return null;
  }
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** Jira's seconds as the hours a person reads. */
function hours(seconds: number | null): string | null {
  if (seconds === null) {
    return null;
  }
  const value = seconds / 3600;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}h`;
}

/** An ISO timestamp as a plain date. Jira sends several shapes; all parse. */
function asDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

/**
 * One ticket in full.
 *
 * The description arrives as text already — `adfToText` flattens Atlassian
 * Document Format on the server, keeping headings, lists and checkboxes as
 * Markdown-ish lines. It is rendered pre-wrapped rather than parsed: the
 * structure survives, and a ticket cannot inject markup into this page.
 *
 * Fields Jira did not send render nothing at all, because a site can omit
 * almost any of them and a column of empty labels is worse than a short list.
 */
function IssueDetail({ issue }: { issue: JiraIssueDetail }) {
  return (
    <div className="flex flex-col gap-4" data-testid="issue-detail">
      <div>
        <h3 className="text-base font-semibold">{issue.summary}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{issue.status}</Badge>
          <span className="text-xs text-muted-foreground">
            {issue.issueType}
          </span>
          {issue.url !== null && (
            <a
              href={issue.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
            >
              Open in Jira
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>

      {issue.descriptionText !== "" && (
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Description
          </p>
          <pre className="max-h-64 overflow-y-auto font-sans text-sm whitespace-pre-wrap">
            {issue.descriptionText}
          </pre>
        </div>
      )}

      <div className="divide-y rounded-md border px-3">
        <Field label="Assignee">{issue.assignee ?? "Unassigned"}</Field>
        <Field label="Reporter">{issue.reporter}</Field>
        <Field label="Creator">
          {issue.creator === issue.reporter ? null : issue.creator}
        </Field>
        <Field label="Priority">{issue.priority}</Field>
        <Field label="Resolution">{issue.resolution}</Field>
        <Field label="Resolved">{asDate(issue.resolutionDate)}</Field>
        <Field label="Created">{asDate(issue.created)}</Field>
        <Field label="Updated">{asDate(issue.updated)}</Field>
        <Field label="Due">{asDate(issue.dueDate)}</Field>
        <Field label="Project">{issue.projectKey}</Field>
        <Field label="Parent">{issue.parentKey}</Field>
        <Field label="Components">
          {issue.components.length === 0 ? null : issue.components.join(", ")}
        </Field>
        <Field label="Fix versions">
          {issue.fixVersions.length === 0 ? null : issue.fixVersions.join(", ")}
        </Field>
        <Field label="Estimate">{hours(issue.originalEstimateSeconds)}</Field>
        <Field label="Remaining">{hours(issue.remainingEstimateSeconds)}</Field>
        <Field label="Environment">{issue.environment}</Field>
        <Field label="Votes">
          {issue.votes === null || issue.votes === 0 ? null : issue.votes}
        </Field>
        <Field label="Watchers">
          {issue.watchers === null || issue.watchers === 0
            ? null
            : issue.watchers}
        </Field>
        <Field label="Labels">
          {issue.labels.length === 0 ? null : (
            <span className="flex flex-wrap gap-1">
              {issue.labels.map((label) => (
                <Badge key={label} variant="outline" className="font-normal">
                  {label}
                </Badge>
              ))}
            </span>
          )}
        </Field>
      </div>
    </div>
  );
}

/** The ticket list: what a run would price, oldest first. */
function PreviewList({
  preview,
  onOpenIssue,
  openingKey,
}: {
  preview: BacklogPreview;
  onOpenIssue: (issueKey: string) => void;
  openingKey: string | null;
}) {
  if (preview.issues.length === 0) {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        No tickets match these settings. The backlog may be empty, or every
        ticket in it is assigned.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="backlog-preview">
      <ul className="max-h-96 divide-y overflow-y-auto rounded-md border">
        {preview.issues.map((issue) => (
          <li key={issue.id}>
            {/* The whole row opens the ticket: a link-sized target inside a
                dialog is a needless miss, and there is nothing else to click. */}
            <button
              type="button"
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50"
              onClick={() => {
                onOpenIssue(issue.key);
              }}
            >
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                {issue.key}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">
                {issue.summary}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {ageInDays(issue.created)}
              </span>
              {openingKey === issue.key ? (
                <Loader2 className="size-4 shrink-0 animate-spin" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              )}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Oldest first. Nothing here has been priced, and nothing was stored.
      </p>
    </div>
  );
}

/**
 * The preview, and the ticket you clicked on.
 *
 * One dialog with two views rather than two stacked dialogs: stacking two
 * overlays on a dark theme reads as mud, and Escape stops meaning one clear
 * thing. Going into a ticket swaps the content and offers a way back to the
 * list, which is the only navigation there is to get wrong.
 */
function PreviewDialog({
  open,
  onOpenChange,
  boardName,
  preview,
  loading,
  issue,
  openingKey,
  onOpenIssue,
  onBack,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  boardName: string;
  preview: BacklogPreview | null;
  loading: boolean;
  issue: JiraIssueDetail | null;
  openingKey: string | null;
  onOpenIssue: (issueKey: string) => void;
  onBack: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {issue !== null && (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 size-7"
                aria-label="Back to the ticket list"
                onClick={onBack}
              >
                <ChevronLeft className="size-4" />
              </Button>
            )}
            {issue === null ? "Backlog preview" : issue.key}
          </DialogTitle>
          <DialogDescription>
            {issue === null
              ? `The tickets a run would price on ${boardName}, oldest first. Read live from Jira — nothing is stored.`
              : `On ${boardName}. Read live from Jira; nothing here is stored.`}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Reading the backlog from Jira…
          </p>
        ) : issue !== null ? (
          <IssueDetail issue={issue} />
        ) : preview !== null ? (
          <PreviewList
            preview={preview}
            onOpenIssue={onOpenIssue}
            openingKey={openingKey}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** One registered board, with the control that previews it. */
function BoardRow({
  board,
  onPreview,
  previewing,
}: {
  board: JiraBoard;
  onPreview: (board: JiraBoard) => void;
  previewing: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <span className="truncate font-medium">{board.name}</span>
        <p className="truncate text-sm text-muted-foreground">
          {board.boardType}
          {board.projectKey === null ? "" : ` · ${board.projectKey}`}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 gap-2"
        disabled={previewing}
        onClick={() => {
          onPreview(board);
        }}
      >
        {previewing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Eye className="size-4" />
        )}
        Preview
      </Button>
    </li>
  );
}

/**
 * Registered boards, and adding one.
 *
 * The site's own boards are fetched only when the user asks to add one: each
 * call reaches Jira, and a page that listed every board of every connected
 * site on load would spend a round trip per site to show a list nobody asked
 * for.
 */
/**
 * Choosing a board to register, from one site.
 *
 * A dialog rather than a list grown inline under the button: the site's
 * boards are a choice to make and dismiss, not part of the page's own
 * content, and on a site with many boards the inline list pushed everything
 * below it off the screen with no way to put it back.
 *
 * Open state is owned by the caller, because the fetch that fills it starts
 * before the dialog appears — the boards are already being read while the
 * spinner shows.
 */
function BoardPickerDialog({
  open,
  onOpenChange,
  siteName,
  boards,
  loading,
  registeredExternalIds,
  busyBoardId,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteName: string;
  boards: JiraRemoteBoard[];
  loading: boolean;
  registeredExternalIds: Set<string>;
  busyBoardId: string | null;
  onPick: (externalId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a board</DialogTitle>
          <DialogDescription>
            Boards on {siteName}. Adding one records a pointer to it — no
            tickets are read until you preview or run it.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Reading boards from Jira…
          </p>
        ) : boards.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No boards on this site are visible to the connected account.
          </p>
        ) : (
          <ul
            // A bordered card with rules between rows, rather than bare list
            // items: the rows are the choice being made, and an unbounded
            // list reads as continuous with the dialog's own text.
            className="max-h-80 divide-y overflow-y-auto rounded-md border"
            data-testid="board-picker"
          >
            {boards.map((board) => {
              const externalId = String(board.id);
              const already = registeredExternalIds.has(externalId);
              return (
                <li
                  key={board.id}
                  className="flex items-center justify-between gap-3 px-3 py-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {board.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {board.type}
                      {board.projectKey === null
                        ? ""
                        : ` · ${board.projectKey}`}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant={already ? "ghost" : "outline"}
                    className="shrink-0"
                    disabled={already || busyBoardId === externalId}
                    onClick={() => {
                      onPick(externalId);
                    }}
                  >
                    {busyBoardId === externalId && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    {already ? "Added" : "Add"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BoardsCard({
  organizationId,
  connections,
  manageable,
}: {
  organizationId: string;
  connections: JiraConnection[];
  manageable: boolean;
}) {
  const { boards, loading, error, listRemote, register, preview, issue } =
    useJiraBoards(organizationId);

  /**
   * The open picker: which site it is reading, and what it found.
   *
   * The connection id is held here rather than read back from the list when a
   * board is picked. Registering needs the site the board was *listed* from,
   * and taking it from anywhere else would attach the board to whichever site
   * happened to be first.
   */
  const [picker, setPicker] = useState<{
    connectionId: string;
    siteName: string;
    boards: JiraRemoteBoard[];
    loading: boolean;
  } | null>(null);
  const [registering, setRegistering] = useState<string | null>(null);
  const [busyBoard, setBusyBoard] = useState<string | null>(null);
  /**
   * The open preview: which board, its tickets, and the one being read.
   *
   * `issue` non-null is what switches the dialog to the detail view, so
   * going back is clearing it rather than a separate mode flag that could
   * disagree with what is loaded.
   */
  const [viewer, setViewer] = useState<{
    boardName: string;
    boardId: string;
    preview: BacklogPreview | null;
    loading: boolean;
    issue: JiraIssueDetail | null;
  } | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  const onAdd = useCallback(
    (connection: JiraConnection) => {
      // Opened before the fetch resolves, so the dialog carries its own
      // spinner instead of the page appearing to do nothing.
      setPicker({
        connectionId: connection.id,
        siteName: connection.siteName,
        boards: [],
        loading: true,
      });
      void listRemote(connection.id).then((found) => {
        setPicker((current) =>
          current === null || current.connectionId !== connection.id
            ? current
            : { ...current, boards: found, loading: false },
        );
      });
    },
    [listRemote],
  );

  const onPick = useCallback(
    (externalId: string) => {
      if (picker === null) {
        return;
      }
      setRegistering(externalId);
      void register(picker.connectionId, externalId).then(() => {
        setRegistering(null);
        // Closed on success: the board is now in the list behind the dialog,
        // and leaving it open invites adding the same board twice.
        setPicker(null);
      });
    },
    [picker, register],
  );

  const onPreview = useCallback(
    (board: JiraBoard) => {
      setBusyBoard(board.id);
      // The dialog opens once there is something to show. A preview can fail
      // outright — a revoked grant, a missing scope — and opening first would
      // mean flashing an empty dialog before closing it again to show the
      // error the card renders.
      void preview(board.id).then((result) => {
        setBusyBoard(null);
        if (result !== null) {
          setViewer({
            boardName: board.name,
            boardId: board.id,
            preview: result,
            loading: false,
            issue: null,
          });
        }
      });
    },
    [preview],
  );

  const onOpenIssue = useCallback(
    (issueKey: string) => {
      if (viewer === null) {
        return;
      }
      setOpeningKey(issueKey);
      void issue(viewer.boardId, issueKey).then((detail) => {
        setOpeningKey(null);
        if (detail !== null) {
          setViewer((current) =>
            current === null ? current : { ...current, issue: detail },
          );
        }
      });
    },
    [issue, viewer],
  );

  const onBack = useCallback(() => {
    setViewer((current) =>
      current === null ? current : { ...current, issue: null },
    );
  }, []);

  const registered = new Set(boards.map((board) => board.externalId));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Boards</CardTitle>
        <CardDescription>
          A board&rsquo;s oldest unassigned backlog tickets are the ones a run
          prices. Preview them here first — it reads Jira live and stores
          nothing.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== null && <BoardsError error={error} />}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </p>
        ) : boards.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No boards yet.
            {connections.length === 0 && " Connect a site first."}
          </p>
        ) : (
          <ul className="divide-y">
            {boards.map((board) => (
              <BoardRow
                key={board.id}
                board={board}
                onPreview={onPreview}
                previewing={busyBoard === board.id}
              />
            ))}
          </ul>
        )}

        {manageable && connections.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {connections.map((connection) => (
              <Button
                key={connection.id}
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={!connection.healthy}
                onClick={() => {
                  onAdd(connection);
                }}
              >
                <Plus className="size-4" />
                Add a board from {connection.siteName}
              </Button>
            ))}
          </div>
        )}
      </CardContent>

      <PreviewDialog
        open={viewer !== null}
        onOpenChange={(next) => {
          if (!next) {
            setViewer(null);
          }
        }}
        boardName={viewer?.boardName ?? ""}
        preview={viewer?.preview ?? null}
        loading={viewer?.loading ?? false}
        issue={viewer?.issue ?? null}
        openingKey={openingKey}
        onOpenIssue={onOpenIssue}
        onBack={onBack}
      />

      <BoardPickerDialog
        open={picker !== null}
        onOpenChange={(next) => {
          if (!next) {
            setPicker(null);
          }
        }}
        siteName={picker?.siteName ?? ""}
        boards={picker?.boards ?? []}
        loading={picker?.loading ?? false}
        registeredExternalIds={registered}
        busyBoardId={registering}
        onPick={onPick}
      />
    </Card>
  );
}

export function Jira({
  organizationId,
  organizationName,
  role,
}: {
  organizationId: string;
  organizationName: string;
  role: string;
}) {
  const { connections, loading, error, connect, disconnect } =
    useJira(organizationId);
  const { outcome, missingScopes, dismiss } = useJiraOutcome();
  const manageable = canManage(role);

  const onDisconnect = useCallback(
    (id: string) => {
      void disconnect(id);
    },
    [disconnect],
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Jira</h1>
        <p className="text-sm text-muted-foreground">
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
          <CardTitle className="text-base">Connected sites</CardTitle>
          <CardDescription>
            Connecting lets us read the boards, backlogs and ticket text on a
            site. We never store ticket contents — they are read when a run
            needs them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </p>
          ) : error !== null ? (
            <p className="text-sm text-destructive">{error}</p>
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
                  manageable={manageable}
                  onDisconnect={onDisconnect}
                />
              ))}
            </ul>
          )}

          {manageable ? (
            <Button className="mt-4 gap-2" onClick={connect}>
              <Link2 className="size-4" />
              {connections.length === 0
                ? "Connect a Jira site"
                : "Connect another site"}
            </Button>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              Only an owner or admin can connect a site.
            </p>
          )}
        </CardContent>
      </Card>

      <BoardsCard
        organizationId={organizationId}
        connections={connections}
        manageable={manageable}
      />
    </div>
  );
}
