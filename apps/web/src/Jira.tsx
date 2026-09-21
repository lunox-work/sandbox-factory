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

import { Link2, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { useCallback } from "react";

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
  useJiraOutcome,
  type JiraConnection,
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

function OutcomeBanner({
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
    <Card className={border} data-testid="jira-outcome">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{detail}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </CardContent>
    </Card>
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
    </div>
  );
}
