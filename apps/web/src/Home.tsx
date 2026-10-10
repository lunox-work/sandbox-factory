/**
 * Home: where a workspace stands, and the work in front of it.
 *
 * What it shows is decided by `setupStage` from what is connected (see
 * `features/onboarding/setup.ts` for the cases and why):
 *
 * Home is offered once the workspace is set up — until then the rail offers
 * onboarding alone and home lands there (see `App`) — so it does not point
 * back to onboarding: what is left is the work.
 *
 * Nothing on this page makes a model call by itself: sizing is always a
 * button somebody pressed, for one ticket unless they asked for more.
 */

import { isWorkspaceSource, type MembershipDto } from "@sandbox-factory/shared";
import { PenLine } from "lucide-react";
import type { ReactNode } from "react";

import { LoadingLine } from "@/components/Message";
import { Page, PageHeader } from "@/components/Page";
import { Button } from "@/components/ui/button";

import { WorkspaceNotices, useConsentReturn } from "./WorkspaceNotices";
import type { BountyPrefill } from "./features/onboarding/prefill";
import { setupStage, type SetupStage } from "./features/onboarding/setup";
import { useWorkspaceSetup } from "./features/onboarding/useWorkspaceSetup";
import type { ConnectionTab } from "./routes";

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
  /** The workspace in the rail: the one home is about. */
  organization: MembershipDto;
  /** Opens the workspace's settings on one tab. */
  onOpenSettings: (organization: MembershipDto, tab: ConnectionTab) => void;
  /** The new-bounty page, optionally started on a repository and module. */
  onWriteBounty: (prefill?: BountyPrefill) => void;
}

export function Home(props: HomeProps) {
  // Keyed by the workspace: switching one in the rail is a different home,
  // and nothing of the previous one's — a board — may linger.
  return <WorkspaceHome key={props.organization.id} {...props} />;
}

function WorkspaceHome({
  name,
  organization,
  onOpenSettings,
  onWriteBounty,
}: HomeProps) {
  const setup = useWorkspaceSetup(organization);
  /*
    A consent round trip comes back here with its outcome in the address.
    Read once, at the top, whatever the stage: the stage may be about to
    change because of it — a first site connected turns this into a board.
  */
  const consent = useConsentReturn(organization.slug);
  const { facts } = setup;

  if (facts === null || consent.picking) {
    return (
      <Page>
        <LoadingLine />
      </Page>
    );
  }

  const stage = setupStage(facts);
  const canManage = facts.canManage;
  const firstRepo = setup.repos.repos.find(isWorkspaceSource);

  const who = firstName(name);
  const today = new Date();
  const intro = (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={today.toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        })}
        title={`${greeting(today)}${who === undefined ? "" : `, ${who}`}`}
        description={promise(stage, firstRepo?.fullName, canManage)}
        descriptionTestId="home-promise"
      />
      <WorkspaceNotices
        consent={consent}
        setup={setup}
        onOpenJiraSettings={() => onOpenSettings(organization, "jira")}
      />
    </div>
  );

  return (
    <Page className="flex flex-col gap-8">
      {intro}
      <div>
        {/* A bounty names no repository: its work may touch any of them. */}
        <Button size="sm" variant="outline" onClick={() => onWriteBounty()}>
          <PenLine />
          Write a bounty
        </Button>
      </div>
    </Page>
  );
}

/** The line under the greeting: what this page is for, at this stage. */
function promise(
  stage: SetupStage,
  repository: string | undefined,
  canManage: boolean,
): ReactNode {
  switch (stage) {
    case "barebone":
      return "Find the backlog work your team won't reach, and have it done outside — sized, priced and sandboxed. Looking costs nothing.";
    case "github":
      return repository === undefined
        ? "GitHub is connected. Pick the repository your work is in to map it."
        : `${repository} is mapped. Write a bounty about it, or connect Jira to have the work found for you.`;
    case "jira":
    case "both":
      return canManage
        ? "Your board's tickets worth outsourcing are bounties already. Open one and propose it to have it sized and priced."
        : "Your board's tickets worth outsourcing are bounties already. An owner or admin proposes the ones worth doing.";
  }
}
