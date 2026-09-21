/**
 * The home screen: every Jira connection the person can reach, grouped by who
 * owns it.
 *
 * Grouped rather than one flat list because the owner is the thing that
 * decides what a connection can be used for, and because a person's own
 * account and a client's team are genuinely different contexts. Their personal
 * organization comes first, under their own name — it is the one they always
 * have.
 *
 * Connecting is done on an organization's own Jira page, not here: the OAuth
 * flow has to name one organization, and a button that silently picked one
 * would attach a client's site to the wrong owner.
 */

import { ArrowRight, Link2, Loader2, TriangleAlert } from "lucide-react";
import type { MembershipDto } from "@sandbox-factory/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { useConnections, type ConnectionGroup } from "./useConnections";
import { useJiraOutcome } from "./useJira";
import { OutcomeBanner } from "./Jira";
import type { JiraConnection } from "./useJira";

/**
 * Personal first, then teams by name.
 *
 * The personal organization is the one every person has, so it is the stable
 * anchor of the list; teams come and go beneath it.
 */
function order(groups: ConnectionGroup[]): ConnectionGroup[] {
  return [...groups].sort((a, b) => {
    const personal =
      Number(b.organization.kind === "personal") -
      Number(a.organization.kind === "personal");
    return personal !== 0
      ? personal
      : a.organization.name.localeCompare(b.organization.name);
  });
}

/** What a group is called: someone's own account, or the team's name. */
function groupLabel(organization: MembershipDto): string {
  return organization.kind === "personal" ? "Personal" : organization.name;
}

function ConnectionLine({ connection }: { connection: JiraConnection }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {connection.siteName}
          </span>
          {!connection.healthy && (
            <Badge variant="destructive" className="gap-1">
              <TriangleAlert className="size-3" />
              Reconnect
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground truncate text-sm">
          {connection.siteUrl}
        </p>
      </div>
    </li>
  );
}

function Group({
  group,
  onOpen,
}: {
  group: ConnectionGroup;
  onOpen: (organization: MembershipDto) => void;
}) {
  const { organization, connections, failed } = group;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="truncate">{groupLabel(organization)}</span>
            {organization.kind === "personal" && (
              <Badge variant="secondary">Your account</Badge>
            )}
          </CardTitle>
          <CardDescription className="truncate">
            {organization.slug}
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1"
          onClick={() => onOpen(organization)}
        >
          Manage
          <ArrowRight className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        {failed ? (
          // One organization failing must not empty the others; it says so
          // here and the rest of the page still works.
          <p className="text-destructive text-sm">
            Could not load these connections.
          </p>
        ) : connections.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No sites connected yet.
          </p>
        ) : (
          <ul className="divide-y">
            {connections.map((connection) => (
              <ConnectionLine key={connection.id} connection={connection} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function Home({
  organizations,
  organizationsLoading,
  onOpen,
}: {
  organizations: MembershipDto[];
  organizationsLoading: boolean;
  onOpen: (organization: MembershipDto) => void;
}) {
  const { groups, loading, error, total } = useConnections(
    organizations,
    organizationsLoading,
  );
  /*
   * The callback lands here too: `returnTo` carries the path the flow started
   * from, and someone who began on an organization's page is sent back to it —
   * but a flow started here returns here, and must still report what happened.
   */
  const { outcome, missingScopes, dismiss } = useJiraOutcome();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-muted-foreground text-sm">
          Jira sites you and your organizations can read boards from.
        </p>
      </header>

      {outcome !== null && (
        <OutcomeBanner
          outcome={outcome}
          missingScopes={missingScopes}
          onDismiss={dismiss}
        />
      )}

      {loading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </p>
      ) : error !== null ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : groups.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nothing here yet</CardTitle>
            <CardDescription>
              You are not in an organization yet, so there is nowhere to connect
              a site.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          {total === 0 && (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Link2 className="size-4" />
              No sites connected yet. Open one below to connect the first.
            </p>
          )}
          {order(groups).map((group) => (
            <Group key={group.organization.id} group={group} onOpen={onOpen} />
          ))}
        </>
      )}
    </main>
  );
}
