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
 *
 * Only working connections are listed. A connection goes unhealthy when
 * Atlassian refuses the credential — a revoked grant, or a refresh token
 * rotated past — and it cannot read a board until someone reconnects it, so
 * it is not what this page is for. It is counted rather than dropped: a
 * connection that vanished silently would look like one nobody had made, and
 * the remedy is a click away on the organization's own page.
 *
 * An organization with nothing to show is left out entirely. This is a list of
 * connections, not of organizations — a card reading "no sites connected yet"
 * is a row about an absence, and several of them bury the sites that do
 * exist. The organizations page is where the full list belongs. A group that
 * failed to load, or that holds only connections needing reconnection, is
 * still shown: both are something to act on rather than nothing.
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
import { ConnectionRow, OutcomeBanner } from "./Jira";
import type { JiraConnection } from "./useJira";

/** Whether a group has anything worth a card. */
function hasSomethingToShow(group: ConnectionGroup): boolean {
  return group.failed || group.connections.length > 0;
}

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

function Group({
  group,
  onOpen,
  onOpenSite,
}: {
  group: ConnectionGroup;
  onOpen: (organization: MembershipDto) => void;
  onOpenSite?:
    | ((organization: MembershipDto, connection: JiraConnection) => void)
    | undefined;
}) {
  const { organization, connections, failed } = group;

  // Split rather than filtered: the broken ones are not listed, but they are
  // still reported, so a revoked grant cannot disappear unnoticed.
  const healthy = connections.filter((connection) => connection.healthy);
  const broken = connections.length - healthy.length;

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
        ) : healthy.length === 0 && broken === 0 ? (
          <p className="text-muted-foreground text-sm">
            No sites connected yet.
          </p>
        ) : (
          <>
            {healthy.length > 0 && (
              <ul className="divide-y">
                {healthy.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    // The organization travels with the site: a URL names
                    // both, and a connection does not carry its owner.
                    onOpen={() => onOpenSite?.(organization, connection)}
                  />
                ))}
              </ul>
            )}
            {broken > 0 && (
              <button
                type="button"
                onClick={() => onOpen(organization)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 mt-3 flex items-center gap-2 rounded text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
              >
                <TriangleAlert className="text-destructive size-3.5 shrink-0" />
                {broken === 1
                  ? "1 site needs reconnecting"
                  : `${broken} sites need reconnecting`}
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function Home({
  organizations,
  organizationsLoading,
  onOpen,
  onOpenSite,
}: {
  organizations: MembershipDto[];
  organizationsLoading: boolean;
  /** Opens the organization's own Jira page: the list, and the way to add. */
  onOpen: (organization: MembershipDto) => void;
  /**
   * Opens one connected site. Optional so this page can be rendered in a test
   * without the shell's navigation, as `onOpen` already is elsewhere.
   */
  onOpenSite?:
    | ((organization: MembershipDto, connection: JiraConnection) => void)
    | undefined;
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

  // Organizations with nothing to show are left out; see the note at the top.
  const visible = groups.filter(hasSomethingToShow);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
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
      ) : visible.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No sites connected yet</CardTitle>
            <CardDescription>
              {groups.length === 0
                ? "You are not in an organization yet, so there is nowhere to connect a site."
                : "Connecting happens on an organization\u2019s own page, because a site belongs to one owner."}
            </CardDescription>
          </CardHeader>
          {groups.length > 0 && (
            <CardContent className="flex flex-wrap gap-2">
              {order(groups).map((group) => (
                <Button
                  key={group.organization.id}
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => onOpen(group.organization)}
                >
                  <Link2 className="size-4" />
                  {groupLabel(group.organization)}
                </Button>
              ))}
            </CardContent>
          )}
        </Card>
      ) : (
        <>
          {total === 0 && (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Link2 className="size-4" />
              Nothing readable yet — the sites below need reconnecting.
            </p>
          )}
          {order(visible).map((group) => (
            <Group
              key={group.organization.id}
              group={group}
              onOpen={onOpen}
              onOpenSite={onOpenSite}
            />
          ))}
        </>
      )}
    </main>
  );
}
