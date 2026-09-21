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
  Eye,
  Link2,
  Loader2,
  Plus,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";

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
  useJira,
  useJiraBoards,
  useJiraOutcome,
  type BacklogPreview,
  type JiraBoard,
  type JiraConnection,
  type JiraFetchError,
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

/**
 * The tickets a run would price.
 *
 * Ordered oldest first, and the age column says so: that ordering is the
 * product's claim about which work is worth a bounty, and seeing it is the
 * point of previewing before spending a model call.
 */
function PreviewTable({ preview }: { preview: BacklogPreview }) {
  if (preview.issues.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No tickets match these settings. The backlog may be empty, or every
        ticket in it is assigned.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="backlog-preview">
      <ul className="divide-y rounded-md border">
        {preview.issues.map((issue) => (
          <li key={issue.id} className="flex items-baseline gap-3 px-3 py-2">
            <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">
              {issue.key}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {issue.url === null ? (
                issue.summary
              ) : (
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {issue.summary}
                </a>
              )}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {ageInDays(issue.created)}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Oldest first. Nothing here has been priced, and nothing was stored.
      </p>
    </div>
  );
}

/** One registered board, with the control that previews it. */
function BoardRow({
  board,
  onPreview,
  previewing,
  preview,
}: {
  board: JiraBoard;
  onPreview: (boardId: string) => void;
  previewing: boolean;
  preview: BacklogPreview | null;
}) {
  return (
    <li className="flex flex-col gap-3 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <span className="truncate font-medium">{board.name}</span>
          <p className="truncate text-sm text-muted-foreground">
            {board.boardType}
            {board.projectKey === null ? "" : ` · ${board.projectKey}`} · oldest{" "}
            {board.selection.maxTickets ?? 10}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-2"
          disabled={previewing}
          onClick={() => {
            onPreview(board.id);
          }}
        >
          {previewing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Eye className="size-4" />
          )}
          Preview
        </Button>
      </div>
      {preview !== null && <PreviewTable preview={preview} />}
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
function BoardsCard({
  organizationId,
  connections,
  manageable,
}: {
  organizationId: string;
  connections: JiraConnection[];
  manageable: boolean;
}) {
  const { boards, loading, error, listRemote, register, preview } =
    useJiraBoards(organizationId);

  const [adding, setAdding] = useState(false);
  /**
   * The boards of one site, and which site they came from.
   *
   * Kept together deliberately: registering a board needs the connection it
   * belongs to, and reading that from the connection list instead would
   * attach the board to whichever site happened to be first.
   */
  const [remote, setRemote] = useState<{
    connectionId: string;
    boards: JiraRemoteBoard[];
  } | null>(null);
  const [busyBoard, setBusyBoard] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, BacklogPreview>>({});

  const onAdd = useCallback(
    (connectionId: string) => {
      setAdding(true);
      void listRemote(connectionId).then((found) => {
        setRemote({ connectionId, boards: found });
        setAdding(false);
      });
    },
    [listRemote],
  );

  const onPreview = useCallback(
    (boardId: string) => {
      setBusyBoard(boardId);
      void preview(boardId).then((result) => {
        setBusyBoard(null);
        if (result !== null) {
          setPreviews((current) => ({ ...current, [boardId]: result }));
        }
      });
    },
    [preview],
  );

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
                preview={previews[board.id] ?? null}
              />
            ))}
          </ul>
        )}

        {manageable && connections.length > 0 && (
          <div className="flex flex-col gap-2">
            {connections.map((connection) => (
              <Button
                key={connection.id}
                variant="outline"
                size="sm"
                className="self-start gap-2"
                disabled={adding || !connection.healthy}
                onClick={() => {
                  onAdd(connection.id);
                }}
              >
                <Plus className="size-4" />
                Add a board from {connection.siteName}
              </Button>
            ))}

            {remote !== null && remote.boards.length > 0 && (
              <ul className="divide-y rounded-md border">
                {remote.boards.map((board) => (
                  <li
                    key={board.id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm">
                      {board.name}
                      <span className="text-muted-foreground">
                        {" "}
                        · {board.type}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={registered.has(String(board.id))}
                      onClick={() => {
                        void register(remote.connectionId, String(board.id));
                      }}
                    >
                      {registered.has(String(board.id)) ? "Added" : "Add"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
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
