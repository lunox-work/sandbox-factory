/**
 * Home: where each of the person's workspaces stands, and the way into it.
 *
 * One card per workspace, personal first as the rail lists them, each with
 * what the workspace list already said of it (`setup` on `/api/v1/me/orgs`,
 * counted from the platform's own rows): its bounties, repositories, boards
 * and members. Every count is a way in — the bounties to the list narrowed
 * to that workspace, the repositories and boards to the tab they are
 * connected on, the members to the members tab — so home is the page the
 * rest is reached from rather than one more thing to read.
 *
 * Home is offered once the workspace in the rail is set up — until then the
 * rail offers onboarding alone and home lands there (see `App`) — but the
 * others need not be: one still being set up says how far it has got and
 * offers to carry on.
 *
 * Nothing on this page makes a model call by itself: sizing is always a
 * button somebody pressed, for one ticket unless they asked for more.
 */

import type { MembershipDto, WorkspaceSetupDto } from "@sandbox-factory/shared";
import { ArrowRight, Box, ChevronRight, Users } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { rankAtLeast } from "sandbox-factory";

import { LoadingLine } from "@/components/Message";
import { Page, PageHeader } from "@/components/Page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { WorkspaceNotices, useConsentReturn } from "./WorkspaceNotices";
import {
  setupComplete,
  setupSteps,
  type SetupFacts,
} from "./features/onboarding/setup";
import { useWorkspaceSetup } from "./features/onboarding/useWorkspaceSetup";
import {
  orderWorkspaces,
  WorkspaceFace,
  type Viewer,
} from "./OrganizationSwitcher";
import { JiraIcon, ProviderIcon } from "./ProviderIcon";
import {
  bountiesUrl,
  isPlainLeftClick,
  ONBOARDING_PATH,
  pathForScreen,
  type ConnectionTab,
} from "./routes";

/** Said by the clock on the person's own machine, which is their day. */
export function greeting(now: Date): string {
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
export function firstName(name: string): string | undefined {
  const first = name.trim().split(/\s+/)[0];
  return first === undefined || first === "" ? undefined : first;
}

export interface HomeProps {
  /** The signed-in person's name, for the greeting. */
  name: string;
  /** The workspace in the rail: where a consent round trip reports back. */
  organization: MembershipDto;
  /** Every workspace the person is in: one card each. */
  organizations: MembershipDto[];
  /** Whoever is looking: the face their personal workspace wears. */
  viewer: Viewer;
  /** Opens a workspace's settings on one tab. */
  onOpenSettings: (organization: MembershipDto, tab: ConnectionTab) => void;
  /** Opens a team's members tab. */
  onOpenMembers: (organization: MembershipDto) => void;
  /** Opens the bounties, narrowed to one workspace's. */
  onOpenBounties: (organization: MembershipDto) => void;
  /** Onboarding for a workspace not set up yet. */
  onOpenOnboarding: (organization: MembershipDto) => void;
}

export function Home(props: HomeProps) {
  // Keyed by the workspace in the rail: a consent's outcome is read for it,
  // and switching one in the rail must not carry the previous one's over.
  return <WorkspaceHome key={props.organization.id} {...props} />;
}

function WorkspaceHome(props: HomeProps) {
  const { name, organization, organizations, onOpenSettings } = props;
  const setup = useWorkspaceSetup(organization);
  /*
    A consent round trip comes back here with its outcome in the address.
    Read once, at the top, before anything else is drawn: the workspace
    list is read again because of it, and its card changes with it.
  */
  const consent = useConsentReturn(organization.slug);

  if (consent.picking) {
    return (
      <Page>
        <LoadingLine />
      </Page>
    );
  }

  const who = firstName(name);
  const today = new Date();

  return (
    <Page className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        <PageHeader
          kicker={today.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
          title={`${greeting(today)}${who === undefined ? "" : `, ${who}`}`}
          description="Where each of your workspaces stands: what is connected, and the work in front of it."
          descriptionTestId="home-promise"
        />
        <WorkspaceNotices
          consent={consent}
          setup={setup}
          onOpenJiraSettings={() => onOpenSettings(organization, "jira")}
        />
      </div>
      <ul
        className="flex flex-col gap-4"
        aria-label="Your workspaces"
        data-testid="workspace-overview"
      >
        {orderWorkspaces(organizations).map((entry) => (
          <li key={entry.id}>
            <WorkspaceCard {...props} organization={entry} />
          </li>
        ))}
      </ul>
    </Page>
  );
}

/**
 * A click handler for a link the shell routes: a plain left click goes
 * through the app, anything else — a middle click, a modifier — is left to
 * the browser, which opens the `href` as it would any link.
 */
function follow(open: () => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (isPlainLeftClick(event)) {
      event.preventDefault();
      open();
    }
  };
}

/** The settings page's members tab, which `pathForScreen` does not name. */
function membersPath(slug: string): string {
  return `${pathForScreen("org-settings", slug)}?tab=members`;
}

/** What the workspace list said of a workspace, as the setup rules read it. */
function factsOf(
  setup: WorkspaceSetupDto,
  organization: MembershipDto,
): SetupFacts {
  return { ...setup, canManage: rankAtLeast(organization.role, "admin") };
}

function WorkspaceCard({
  organization,
  viewer,
  onOpenSettings,
  onOpenMembers,
  onOpenBounties,
  onOpenOnboarding,
}: HomeProps) {
  const { setup } = organization;
  const facts = setup === undefined ? undefined : factsOf(setup, organization);
  const settled = facts === undefined || setupComplete(facts);
  const personal = organization.kind === "personal";
  return (
    <article
      aria-labelledby={`workspace-${organization.id}`}
      data-testid="workspace-card"
      className="bg-card relative overflow-hidden rounded-xl border shadow-sm"
    >
      {/* The brand's hairline along the top edge, as on the bounty page's cards. */}
      <span
        aria-hidden="true"
        className="bg-(image:--brand-gradient) absolute inset-x-0 top-0 h-0.5"
      />
      {/*
        The row is the way into the workspace itself; the counts under it
        are ways into its parts. One link for the row rather than the whole
        card, so a count can be a link of its own inside it.
      */}
      <a
        href={pathForScreen("org-settings", organization.slug)}
        onClick={follow(() => onOpenSettings(organization, "home"))}
        className="group/row hover:bg-accent/50 focus-visible:ring-ring/50 flex items-center gap-4 px-5 py-4 outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
      >
        <WorkspaceFace
          organization={organization}
          viewer={viewer}
          className="ring-border size-12 shrink-0 ring-1"
          squareRadius="rounded-xl"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <h2
              id={`workspace-${organization.id}`}
              className="text-heading truncate"
            >
              {organization.name}
            </h2>
            {personal && <Badge variant="secondary">Personal</Badge>}
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate font-mono text-xs">
            @{organization.slug}
          </span>
        </span>
        <Badge
          variant={organization.role === "owner" ? "default" : "secondary"}
        >
          <span className="capitalize">{organization.role}</span>
        </Badge>
        <ChevronRight
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 group-hover/row:translate-x-0.5 motion-reduce:transition-none"
        />
      </a>

      {setup !== undefined && (
        /*
          Two to a row on a phone, one row from `sm` up, with a hairline
          between neighbours either way: the counts are the card's own
          surface, parted by lines rather than boxed in it.
        */
        <ul
          className="grid grid-cols-2 border-t sm:flex"
          aria-label={`${organization.name} at a glance`}
        >
          <Stat
            icon={<Box aria-hidden="true" />}
            label="Bounties"
            count={setup.bounties}
            href={bountiesUrl(null, { workspace: organization.slug })}
            onOpen={() => onOpenBounties(organization)}
          />
          {setup.github.available && (
            <Stat
              icon={<ProviderIcon provider="github" />}
              label="Repositories"
              count={setup.github.repositories}
              href={pathForScreen(
                "org-settings",
                organization.slug,
                undefined,
                "github",
              )}
              onOpen={() => onOpenSettings(organization, "github")}
            />
          )}
          {setup.jira.available && (
            <Stat
              icon={<JiraIcon />}
              label="Boards"
              count={setup.jira.boards}
              // A site that needs reconnecting is said with its boards:
              // none can be read until it is, on the same tab.
              note={
                setup.jira.broken > 0
                  ? `${setup.jira.broken} site to reconnect`
                  : undefined
              }
              href={pathForScreen(
                "org-settings",
                organization.slug,
                undefined,
                "jira",
              )}
              onOpen={() => onOpenSettings(organization, "jira")}
            />
          )}
          {/* One member, and no tab to count them on: nothing to open. */}
          {!personal && (
            <Stat
              icon={<Users aria-hidden="true" />}
              label="Members"
              count={setup.members}
              href={membersPath(organization.slug)}
              onOpen={() => onOpenMembers(organization)}
            />
          )}
        </ul>
      )}

      {!settled && facts !== undefined && (
        <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
          <div className="flex items-center gap-3">
            <SetupSegments facts={facts} />
            <p className="text-muted-foreground text-sm">{progress(facts)}</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <a
              href={ONBOARDING_PATH}
              onClick={follow(() => onOpenOnboarding(organization))}
            >
              Continue setup
              <ChevronRight />
            </a>
          </Button>
        </div>
      )}
    </article>
  );
}

/** "1 of 3 steps done": how far a workspace not set up yet has got. */
function progress(facts: SetupFacts): string {
  const steps = setupSteps(facts);
  const done = steps.filter((step) => step.done).length;
  return `Setting up: ${done} of ${steps.length} steps done.`;
}

/**
 * The same, drawn: one segment a step, filled once done, half-toned for the
 * one at hand. The text beside it says the numbers, so this says nothing to
 * a screen reader.
 */
function SetupSegments({ facts }: { facts: SetupFacts }) {
  return (
    <span className="flex shrink-0 gap-1" aria-hidden="true">
      {setupSteps(facts).map((step) => (
        <span
          key={step.id}
          className={cn(
            "h-1.5 w-5 rounded-full",
            step.done
              ? "bg-primary"
              : step.current
                ? "bg-primary/30"
                : "bg-border",
          )}
        />
      ))}
    </span>
  );
}

/**
 * One count on a card, and the page it opens: the mark of what is counted
 * and its name, the number under them, and under that what is wrong with
 * it, when something is.
 */
function Stat({
  icon,
  label,
  count,
  note,
  href,
  onOpen,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  note?: string | undefined;
  href: string;
  onOpen: () => void;
}) {
  return (
    <li
      className={cn(
        "flex min-w-0 sm:flex-1",
        // A third or fifth count alone on the last phone row takes the row.
        "odd:last:col-span-2",
        // The hairlines: on a phone, between the two of a row and above
        // the rows after the first; in one row, between neighbours.
        "nth-[2n]:border-l nth-[n+3]:border-t",
        "sm:border-l sm:first:border-l-0 sm:nth-[n+3]:border-t-0",
      )}
    >
      {/*
        The mark in a tinted tile, as on the bounty list's rows, the name and
        the number beside it, and an arrow that comes forward under the
        pointer to say the count opens somewhere.
      */}
      <a
        href={href}
        onClick={follow(onOpen)}
        aria-label={`${count.toLocaleString("en-US")} ${label.toLowerCase()}${
          note === undefined ? "" : `, ${note}`
        }`}
        className="group/stat hover:bg-accent/50 focus-visible:ring-ring/50 flex w-full items-center gap-3 px-5 py-4 outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
      >
        {/* In the text's colour, not the label's grey: GitHub's mark follows it, and sank into the dark tile. */}
        <span className="bg-muted text-foreground group-hover/stat:bg-background flex size-9 shrink-0 items-center justify-center rounded-lg border border-transparent transition-colors duration-150 group-hover/stat:border-border [&_svg]:size-4 [&_svg]:shrink-0">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-muted-foreground truncate text-xs">
            {label}
          </span>
          <span
            className={cn(
              "text-xl leading-7 font-semibold tracking-tight tabular-nums",
              count === 0 && "text-muted-foreground",
            )}
          >
            {count.toLocaleString("en-US")}
          </span>
          {note !== undefined && (
            <span className="text-destructive text-xs">{note}</span>
          )}
        </span>
        <ArrowRight
          aria-hidden="true"
          className="text-muted-foreground size-3.5 shrink-0 -translate-x-1 opacity-0 transition-[opacity,translate] duration-150 group-hover/stat:translate-x-0 group-hover/stat:opacity-100 motion-reduce:transition-none"
        />
      </a>
    </li>
  );
}
