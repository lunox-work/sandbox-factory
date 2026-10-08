/**
 * Home: where a workspace stands, and the most useful thing to do next.
 *
 * One page that changes with the workspace rather than a different page for
 * each case. What it shows is decided by `setupStage` from what is connected
 * (see `features/onboarding/setup.ts` for the cases and why):
 *
 * - **Nothing yet.** The three ways in — connect Jira, connect GitHub, or
 *   write a bounty by hand — each saying what it pays back and what it costs
 *   to try, over the six kinds of work a scan looks for, so connecting Jira
 *   is a promise with the details shown.
 * - **Jira.** The board, opening on its backlog scan: the tickets worth
 *   outsourcing, found from metadata for free, and one ticket at a time to
 *   size. With GitHub too, the same board sized beside the code.
 * - **GitHub.** The repository's x-ray and where a first bounty fits in it,
 *   with writing one as the way on and Jira as the way to have the work found.
 *
 * Above every one of them, the getting-started checklist, until it is done or
 * hidden. Nothing on this page makes a model call by itself: sizing is always
 * a button somebody pressed, for one ticket unless they asked for more.
 *
 * Connecting is still done through a workspace's own consent flow — the OAuth
 * round trip has to name one owner — and it is the workspace in the rail, on
 * screen beside the button, so there is no doubt whose it will be.
 */

import type { GithubRepoDto, MembershipDto } from "@sandbox-factory/shared";
import { PenLine, RefreshCw } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { ErrorBanner, LoadingLine } from "@/components/Message";
import { OutcomeNotice } from "@/components/OutcomeNotice";
import { Button } from "@/components/ui/button";

import { describeGithubOutcome } from "./Github";
import { HomeBoard } from "./HomeBoard";
import { OutcomeBanner } from "./Jira";
import { JiraIcon, ProviderIcon } from "./ProviderIcon";
import { CategoryShowcase } from "./features/onboarding/CategoryShowcase";
import { PathCards, type PathCard } from "./features/onboarding/PathCards";
import { RepoPicker } from "./features/onboarding/RepoPicker";
import type { BountyPrefill } from "./features/onboarding/prefill";
import { RepoXray } from "./features/onboarding/RepoXray";
import {
  SetupChecklist,
  type SetupActions,
} from "./features/onboarding/SetupChecklist";
import { setupStage, type SetupStage } from "./features/onboarding/setup";
import { useWorkspaceSetup } from "./features/onboarding/useWorkspaceSetup";
import { SECTION, reveal } from "./lib/reveal";
import { replaceLocation } from "./navigation/location";
import { pathForScreen, type ConnectionTab } from "./routes";
import { useGithubOutcome } from "./useGithub";
import { useJiraOutcome, type JiraBoard } from "./useJira";

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
  userId: string;
  /** The signed-in person's name, for the greeting. */
  name: string;
  /** The workspace in the rail: the one home is about. */
  organization: MembershipDto;
  /** Leaves home for a board's bounties. */
  onOpenBoard: (board: JiraBoard) => void;
  /** Opens the workspace's settings on one tab. */
  onOpenSettings: (organization: MembershipDto, tab: ConnectionTab) => void;
  onOpenRepository: (repo: GithubRepoDto) => void;
  /** The new-bounty page, optionally started on a repository and module. */
  onWriteBounty: (prefill?: BountyPrefill) => void;
  onOpenBounties: () => void;
}

export function Home(props: HomeProps) {
  // Keyed by the workspace: switching one in the rail is a different home,
  // and nothing of the previous one's — a board, a hidden checklist — may
  // linger.
  return <WorkspaceHome key={props.organization.id} {...props} />;
}

function WorkspaceHome({
  userId,
  name,
  organization,
  onOpenBoard,
  onOpenSettings,
  onOpenRepository,
  onWriteBounty,
  onOpenBounties,
}: HomeProps) {
  const setup = useWorkspaceSetup(organization);
  /*
    A consent round trip comes back here with its outcome in the address.
    Read once, at the top, whatever the stage: the stage may be about to
    change because of it — a first site connected turns this into a board.
  */
  const jiraOutcome = useJiraOutcome();
  // GitHub's flow lands here too when it cannot be tied to a workspace.
  const githubOutcome = useGithubOutcome();
  const { facts } = setup;
  /*
    GitHub sends the person back to pick an account when several could be
    linked. That picker is on the workspace's GitHub tab, so the flow is
    carried on there, outcome and all, rather than told to pick on a page
    with nothing to pick from.
  */
  const picking = githubOutcome.outcome === "pick";
  useEffect(() => {
    if (picking)
      replaceLocation(
        `${pathForScreen("org-settings", organization.slug, undefined, "github")}&github=pick`,
      );
  }, [picking, organization.slug]);

  if (facts === null || picking) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <LoadingLine />
      </main>
    );
  }

  const stage = setupStage(facts);
  const canManage = facts.canManage;
  const connectJira = canManage ? setup.jira.connect : undefined;
  const connectGithub =
    canManage && facts.github.available ? setup.github.connect : undefined;
  const needsRepository =
    facts.github.connected > 0 && facts.github.repositories === 0;
  const firstRepo = setup.repos.repos.find(
    (repo) => repo.role === "source" && repo.syncStatus !== "gone",
  );
  const writeBounty = () =>
    onWriteBounty(
      firstRepo === undefined ? undefined : { repoId: firstRepo.id },
    );

  const actions: SetupActions = {
    connectJira,
    connectGithub,
    pickRepository: () => reveal(SECTION.repoPicker),
    size:
      stage === "jira" || stage === "both"
        ? canManage
          ? {
              label: "Pick a ticket",
              onSelect: () => reveal(SECTION.backlogScan),
            }
          : undefined
        : facts.bounties > 0
          ? { label: "Open bounties", onSelect: onOpenBounties }
          : { label: "Write a bounty", onSelect: writeBounty },
  };

  const who = firstName(name);
  const today = new Date();
  const intro = (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-muted-foreground text-sm">
          {today.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {greeting(today)}
          {who === undefined ? "" : `, ${who}`}
        </h1>
        <p
          className="text-muted-foreground mt-2 max-w-prose text-sm"
          data-testid="home-promise"
        >
          {promise(stage, needsRepository, firstRepo?.fullName, canManage)}
        </p>
      </div>
      {jiraOutcome.outcome !== null && (
        <OutcomeBanner
          outcome={jiraOutcome.outcome}
          missingScopes={jiraOutcome.missingScopes}
          onDismiss={jiraOutcome.dismiss}
        />
      )}
      {githubOutcome.outcome !== null && (
        <OutcomeNotice
          {...describeGithubOutcome(githubOutcome.outcome, "home")}
          onDismiss={githubOutcome.dismiss}
          testId="github-outcome"
        />
      )}
      {setup.failed && (
        // One read failing must not take home with it: what did load is
        // still shown, and this says the rest may be missing.
        <div className="flex flex-col items-start gap-3">
          <ErrorBanner className="mt-0">
            Some of this workspace&rsquo;s connections could not be read.
          </ErrorBanner>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void setup.refresh()}
          >
            <RefreshCw />
            Try again
          </Button>
        </div>
      )}
      {facts.jira.broken > 0 && (
        <BrokenSites
          count={facts.jira.broken}
          onOpen={() => onOpenSettings(organization, "jira")}
        />
      )}
      {/*
        Not on a workspace with nothing connected: the three cards below are
        the steps there, each with its button, and a strip above them saying
        the same would only repeat them. It appears once there is progress
        to show.
      */}
      {stage !== "barebone" && (
        <SetupChecklist
          userId={userId}
          organizationId={organization.id}
          facts={facts}
          actions={actions}
        />
      )}
      {needsRepository && (
        <RepoPicker
          organizationId={organization.id}
          connections={setup.github.connections.filter(
            ({ healthy }) => healthy,
          )}
          canManage={canManage}
          register={async (connectionId, externalId) => {
            const result = await setup.repos.register(connectionId, externalId);
            return result.ok ? null : result.error;
          }}
        />
      )}
    </div>
  );

  if (stage === "jira" || stage === "both") {
    return (
      <HomeBoard
        userId={userId}
        organizationId={organization.id}
        organizationSlug={organization.slug}
        role={organization.role}
        intro={intro}
        onOpenBoard={onOpenBoard}
        repositoryAction={
          needsRepository
            ? canManage
              ? {
                  label: "pick a repository",
                  onSelect: () => reveal(SECTION.repoPicker),
                }
              : undefined
            : connectGithub !== undefined && facts.github.connected === 0
              ? { label: "connect GitHub", onSelect: connectGithub }
              : undefined
        }
        fallback={
          <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
            {intro}
            <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-8 text-center text-sm">
              Jira is connected, but the account that connected it can see no
              boards yet. Boards made since are picked up from the{" "}
              <button
                type="button"
                className="text-foreground underline underline-offset-2"
                onClick={() => onOpenSettings(organization, "jira")}
              >
                Jira settings
              </button>
              .
            </p>
          </main>
        }
      />
    );
  }

  const jiraPath: PathCard | null = facts.jira.available
    ? {
        key: "jira",
        icon: <JiraIcon />,
        title: "Find work in Jira",
        description:
          "Scan your backlog for the six kinds of work teams outsource, ticket by ticket, with the reason each was picked.",
        note: "Seconds, and free: it reads ticket metadata only, runs no AI and stores nothing.",
        action:
          connectJira === undefined
            ? undefined
            : { label: "Connect Jira", onSelect: connectJira },
      }
    : null;
  /*
    A workspace that has written bounties and sized none has its next step
    waiting already: sizing one of those, not writing another.
  */
  const writePath: PathCard =
    facts.bounties > 0 && facts.proposals === 0
      ? {
          key: "write",
          icon: <PenLine />,
          title: "Size a bounty you wrote",
          description:
            "Your bounties are written and waiting. Open one and size it: it is priced as a proposal, and a sandbox is made for it.",
          note: "About a minute, one model call.",
          action: { label: "Open bounties", onSelect: onOpenBounties },
        }
      : {
          key: "write",
          icon: <PenLine />,
          title: "Start from a task",
          description:
            stage === "github" && firstRepo !== undefined
              ? `Describe one piece of work in ${firstRepo.fullName}. It is sized and priced as a proposal, beside the code.`
              : "Describe one piece of work. It is sized and priced as a proposal, and a sandbox is made for it.",
          note: "No integration needed.",
          action: { label: "Write a bounty", onSelect: writeBounty },
        };

  if (stage === "github") {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
        {intro}
        {firstRepo !== undefined && (
          <RepoXray
            organizationId={organization.id}
            organizationSlug={organization.slug}
            repo={firstRepo}
            onOpenRepository={onOpenRepository}
            onWriteBounty={onWriteBounty}
          />
        )}
        <PathCards
          paths={[writePath, ...(jiraPath === null ? [] : [jiraPath])]}
        />
        {facts.jira.available && (
          <CategoryShowcase
            compact
            title="What a Jira scan would find"
            description="Connect Jira and the backlog is sorted into these six in seconds, ticket by ticket."
          />
        )}
      </main>
    );
  }

  const githubPath: PathCard | null = facts.github.available
    ? {
        key: "github",
        icon: <ProviderIcon provider="github" />,
        title: "Add your code",
        description:
          "Map a repository's stack, modules and tests, so bounties are sized beside the code and sandboxes are cut from it.",
        note: "Read-only: its file list and package manifests. Code is read only when you build a sandbox or context from it.",
        action:
          connectGithub === undefined
            ? undefined
            : { label: "Connect GitHub", onSelect: connectGithub },
      }
    : null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-10 sm:px-6 sm:py-14">
      {intro}
      <PathCards
        paths={[jiraPath, githubPath, writePath].filter(
          (path): path is PathCard => path !== null,
        )}
      />
      <CategoryShowcase
        description={
          facts.jira.available
            ? "A Jira scan sorts a backlog into these six. Each is work the team won't reach soon, but someone outside could finish against clear checks."
            : "Each is work the team won't reach soon, but someone outside could finish against clear checks."
        }
      />
    </main>
  );
}

/** The line under the greeting: what this page is for, at this stage. */
function promise(
  stage: SetupStage,
  needsRepository: boolean,
  repository: string | undefined,
  canManage: boolean,
): ReactNode {
  switch (stage) {
    case "barebone":
      return "Find the backlog work your team won't reach, and have it done outside — sized, priced and sandboxed. Start with whichever tool you have; looking costs nothing.";
    case "github":
      return needsRepository || repository === undefined
        ? "GitHub is connected. Pick the repository your work is in to map it."
        : `${repository} is mapped. Write a bounty about it, or connect Jira to have the work found for you.`;
    case "jira":
    case "both":
      return canManage
        ? "What on this board is worth outsourcing, found from ticket metadata. Pick a ticket to size it into a bounty."
        : "What on this board is worth outsourcing, found from ticket metadata. An owner or admin sizes the ones worth doing.";
  }
}

/** Sites whose grant lapsed: not shown as connected, but not dropped either. */
function BrokenSites({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
      <span className="text-destructive">
        {count === 1
          ? "1 Jira site needs reconnecting."
          : `${count} Jira sites need reconnecting.`}
      </span>
      <button
        type="button"
        className="text-foreground underline underline-offset-2"
        onClick={onOpen}
      >
        Open Jira settings
      </button>
    </p>
  );
}
