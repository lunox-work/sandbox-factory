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
 * Connecting is done in an organization's own settings, not here: the OAuth
 * flow has to name one organization, and a button that silently picked one
 * would attach a client's site to the wrong owner. So the empty state's
 * "Connect Jira" opens the organization chosen in the switcher at the head of
 * the rail, which is on screen beside it and says whose it will be.
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

import { ArrowRight, Link2, TriangleAlert } from "lucide-react";
import type { MembershipDto } from "@sandbox-factory/shared";

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
import { useConnections, type ConnectionGroup } from "./useConnections";
import { useJiraOutcome } from "./useJira";
import { ConnectionRow, OutcomeBanner } from "./Jira";
import { isPlainLeftClick, pathForScreen } from "./routes";

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
}: {
  group: ConnectionGroup;
  onOpen: (organization: MembershipDto) => void;
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
          <CardTitle className="flex items-center gap-2">
            <span className="truncate">{groupLabel(organization)}</span>
            {organization.kind === "personal" && (
              <Badge variant="secondary">Your account</Badge>
            )}
          </CardTitle>
          <CardDescription className="truncate">
            {organization.slug}
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0 gap-1" asChild>
          <a
            href={pathForScreen(
              "org-settings",
              organization.slug,
              undefined,
              undefined,
              "jira",
            )}
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                onOpen(organization);
              }
            }}
          >
            Manage
            <ArrowRight className="size-4" />
          </a>
        </Button>
      </CardHeader>
      <CardContent>
        {failed ? (
          // One organization failing must not empty the others; it says so
          // here and the rest of the page still works.
          <ErrorBanner className="mt-0">
            Could not load these connections.
          </ErrorBanner>
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
                    // A site has no page of its own: its boards are listed
                    // in the Jira tab of the organization that owns it. The
                    // organization travels with the row, since a connection
                    // does not carry its owner.
                    href={pathForScreen(
                      "org-settings",
                      organization.slug,
                      undefined,
                      undefined,
                      "jira",
                    )}
                    onOpen={() => onOpen(organization)}
                  />
                ))}
              </ul>
            )}
            {broken > 0 && (
              <a
                href={pathForScreen(
                  "org-settings",
                  organization.slug,
                  undefined,
                  undefined,
                  "jira",
                )}
                onClick={(event) => {
                  if (isPlainLeftClick(event)) {
                    event.preventDefault();
                    onOpen(organization);
                  }
                }}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 mt-3 flex items-center gap-2 rounded text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
              >
                <TriangleAlert className="text-destructive size-3.5 shrink-0" />
                {broken === 1
                  ? "1 site needs reconnecting"
                  : `${broken} sites need reconnecting`}
              </a>
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
  activeOrganization,
  onOpen,
}: {
  organizations: MembershipDto[];
  organizationsLoading: boolean;
  /** The organization chosen in the switcher; where "Connect Jira" goes. */
  activeOrganization: MembershipDto | null;
  /**
   * Opens the organization's settings on its Jira tab: the list, and the way
   * to add.
   */
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

  // Organizations with nothing to show are left out; see the note at the top.
  const visible = groups.filter(hasSomethingToShow);
  // Only once the answer is known, so a failed read is not called a fresh
  // start.
  const onboarding = !loading && error === null && visible.length === 0;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {onboarding ? "Onboarding" : "Connections"}
        </h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Jira sites you and your workspaces can read boards from.
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
        <LoadingLine />
      ) : error !== null ? (
        <ErrorBanner className="mt-0">{error}</ErrorBanner>
      ) : visible.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No sites connected yet</CardTitle>
            <CardDescription>
              {groups.length === 0
                ? "You are not in a workspace yet, so there is nowhere to connect a site."
                : "Connecting happens in a workspace\u2019s own settings, because a site belongs to one owner."}
            </CardDescription>
          </CardHeader>
          {groups.length > 0 && activeOrganization !== null && (
            <CardContent>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => onOpen(activeOrganization)}
              >
                <JiraIcon />
                Connect Jira
              </Button>
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
            <Group key={group.organization.id} group={group} onOpen={onOpen} />
          ))}
        </>
      )}
    </main>
  );
}
