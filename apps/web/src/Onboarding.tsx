/**
 * Onboarding: getting the workspace in the rail set up, on a page of its own.
 *
 * Home says where setup stands and points here; this is where it is done,
 * and where a connected board's backlog scan is, under getting started. What it shows is decided by `setupStage` from what is
 * connected (see `features/onboarding/setup.ts` for the cases and why):
 *
 * - **Nothing yet.** The three ways in — connect Jira, connect GitHub, or
 *   write a bounty by hand — each its mark, what it reads and one button.
 * - **GitHub.** The repository's x-ray and where a first bounty fits in it,
 *   with writing one as the way on and Jira as the way to have the work found.
 * - **Jira.** The board's backlog scan: the tickets worth outsourcing,
 *   found from metadata for free, under a bar to pick the board and act on
 *   all of it, with one ticket at a time to size.
 *
 * Above each, the getting-started checklist, ticked off as steps are done and
 * always shown — it is what this page is for — and beside the heading the
 * six kinds of work a scan looks for, in a dialog, so connecting Jira is a
 * promise with the details a click away.
 * Nothing on this page makes a model call by itself, and nothing on it sizes
 * before GitHub is connected, where the server offers it.
 *
 * Until every step is done this is the only page the rail offers; once they
 * are, it gives way to home and the bounties (see `App`).
 *
 * Connecting is still done through a workspace's own consent flow — the OAuth
 * round trip has to name one owner — and it is the workspace in the rail, on
 * screen beside the button, so there is no doubt whose it will be. The round
 * trip comes back here, so its outcome is said here too.
 */

import {
  isWorkspaceSource,
  type GithubRepoDto,
  type MembershipDto,
} from "@sandbox-factory/shared";
import { SquarePen } from "lucide-react";
import { useState, type ReactNode } from "react";

import { LoadingLine } from "@/components/Message";
import { Page, PageHeader } from "@/components/Page";

import { RepositoryDialog } from "./Github";
import { JiraIcon, ProviderIcon } from "./ProviderIcon";
import { WorkspaceNotices, useConsentReturn } from "./WorkspaceNotices";
import { BoardScan, NoBoards } from "./features/onboarding/BoardScan";
import { CategoryShowcase } from "./features/onboarding/CategoryShowcase";
import { PathCards, type PathCard } from "./features/onboarding/PathCards";
import { RepoPicker } from "./features/onboarding/RepoPicker";
import type { BountyPrefill } from "./features/onboarding/prefill";
import { RepoXray } from "./features/onboarding/RepoXray";
import {
  SetupChecklist,
  type SetupActions,
} from "./features/onboarding/SetupChecklist";
import {
  setupComplete,
  setupStage,
  type SetupStage,
} from "./features/onboarding/setup";
import { useWorkspaceSetup } from "./features/onboarding/useWorkspaceSetup";
import { SECTION, reveal } from "./lib/reveal";
import type { ConnectionTab } from "./routes";

export interface OnboardingProps {
  /** The signed-in person: whose remembered board the scan opens on. */
  userId: string;
  /** The workspace in the rail: the one being set up. */
  organization: MembershipDto;
  /** Opens the workspace's settings on one tab. */
  onOpenSettings: (organization: MembershipDto, tab: ConnectionTab) => void;
  onOpenRepository: (repo: GithubRepoDto) => void;
  /** The new-bounty page, optionally started on a repository and module. */
  onWriteBounty: (prefill?: BountyPrefill) => void;
  onOpenBounties: () => void;
}

export function Onboarding(props: OnboardingProps) {
  // Keyed by the workspace: switching one in the rail is a different setup,
  // and nothing of the previous one's may linger.
  return <WorkspaceOnboarding key={props.organization.id} {...props} />;
}

function WorkspaceOnboarding({
  userId,
  organization,
  onOpenSettings,
  onOpenRepository,
  onWriteBounty,
  onOpenBounties,
}: OnboardingProps) {
  const setup = useWorkspaceSetup(organization);
  const consent = useConsentReturn(organization.slug);
  const { facts } = setup;
  // The account whose repositories dialog is open. Held here rather than in
  // the picker, which is gone the moment the first repository registers.
  const [managing, setManaging] = useState<string | null>(null);

  if (facts === null || consent.picking) {
    return (
      <Page>
        <LoadingLine />
      </Page>
    );
  }

  const stage = setupStage(facts);
  const canManage = facts.canManage;
  const connectJira = canManage ? setup.jira.connect : undefined;
  const connectGithub =
    canManage && facts.github.available ? setup.github.connect : undefined;
  const needsRepository =
    facts.github.connected > 0 && facts.github.repositories === 0;
  const firstRepo = setup.repos.repos.find(isWorkspaceSource);
  const managed = canManage
    ? setup.github.connections.find(
        ({ id, healthy }) => id === managing && healthy,
      )
    : undefined;
  const withJira = stage === "jira" || stage === "both";
  // A bounty names no repository: its work may touch any of them.
  const writeBounty = () => onWriteBounty();

  const actions: SetupActions = {
    connectJira,
    connectGithub,
    pickRepository: () => reveal(SECTION.repoPicker),
    size: withJira
      ? canManage
        ? // The scan to pick from is the board below.
          {
            label: "Pick a ticket",
            onSelect: () => reveal(SECTION.backlogScan),
          }
        : undefined
      : facts.bounties > 0
        ? { label: "Open bounties", onSelect: onOpenBounties }
        : { label: "Write a bounty", onSelect: writeBounty },
  };

  const jiraPath: PathCard | null = facts.jira.available
    ? {
        key: "jira",
        icon: <JiraIcon />,
        title: "Find work in Jira",
        note: "Read-only",
        action:
          connectJira === undefined
            ? undefined
            : { label: "Connect", name: "Connect Jira", onSelect: connectJira },
      }
    : null;
  const githubPath: PathCard | null = facts.github.available
    ? {
        key: "github",
        icon: <ProviderIcon provider="github" />,
        title: "Add your code",
        note: "Read-only",
        action:
          connectGithub === undefined
            ? undefined
            : {
                label: "Connect",
                name: "Connect GitHub",
                onSelect: connectGithub,
              },
      }
    : null;
  /*
    A workspace that has written bounties and sized none has its next step
    waiting already: sizing one of those, not writing another — once there
    is code to size it beside, where the server offers GitHub.
  */
  const writePath: PathCard =
    facts.bounties > 0 &&
    facts.proposals === 0 &&
    (facts.github.repositories > 0 || !facts.github.available)
      ? {
          key: "write",
          icon: <SquarePen strokeWidth={1.5} />,
          title: "Size a bounty you wrote",
          note: "Written and waiting",
          action: { label: "Open bounties", onSelect: onOpenBounties },
          dashed: true,
        }
      : {
          key: "write",
          icon: <SquarePen strokeWidth={1.5} />,
          title: "Start from a task",
          action: {
            label: "Manual",
            name: "Manual: write a bounty",
            onSelect: writeBounty,
          },
          dashed: true,
        };

  const showcaseDescription = withJira
    ? // The scan these six come from is the board below.
      "Your board's backlog is sorted into these six below, ticket by ticket, from metadata alone. Each is work the team won't reach soon, but someone outside could finish against clear checks."
    : "Here're list of items that product and engineering manager typically outsource";

  return (
    <Page className="flex flex-col gap-10">
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Onboarding"
          description={promise(
            stage,
            needsRepository,
            firstRepo?.fullName,
            setupComplete(facts),
          )}
          descriptionTestId="onboarding-promise"
          // The six kinds of work at the far end of the heading: reference
          // for every stage, opened when wanted rather than standing in the
          // way of the steps.
          actions={<CategoryShowcase description={showcaseDescription} />}
        />
        <WorkspaceNotices
          consent={consent}
          setup={setup}
          onOpenJiraSettings={() => onOpenSettings(organization, "jira")}
        />
        {/* At every stage, never hidden: where setup stands is what this
            page is for, before the first step as much as after the last. */}
        <SetupChecklist facts={facts} actions={actions} />
        {needsRepository && (
          <RepoPicker
            connections={setup.github.connections.filter(
              ({ healthy }) => healthy,
            )}
            canManage={canManage}
            onManage={setManaging}
          />
        )}
        {managed !== undefined && (
          <RepositoryDialog
            organizationId={organization.id}
            connection={managed}
            registered={setup.repos.repos.filter(
              (repo) => repo.connectionId === managed.id,
            )}
            registeredLoading={setup.repos.loading}
            onRegister={(externalId) =>
              setup.repos.register(managed.id, externalId)
            }
            onRemove={(repoId) => setup.repos.remove(repoId)}
            onUnhealthy={() => {
              setManaging(null);
              void setup.github.refresh();
            }}
            onClose={() => setManaging(null)}
          />
        )}
      </div>

      {stage === "barebone" ? (
        <>
          <PathCards
            paths={[jiraPath, githubPath, writePath].filter(
              (path): path is PathCard => path !== null,
            )}
          />
        </>
      ) : stage === "github" ? (
        <>
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
        </>
      ) : (
        <BoardScan
          userId={userId}
          organizationId={organization.id}
          organizationSlug={organization.slug}
          canManage={canManage}
          githubAvailable={facts.github.available}
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
            <NoBoards
              onOpenSettings={() => onOpenSettings(organization, "jira")}
            />
          }
        />
      )}
    </Page>
  );
}

/** The line under the heading: where setup stands, at this stage. */
function promise(
  stage: SetupStage,
  needsRepository: boolean,
  repository: string | undefined,
  complete: boolean,
): ReactNode {
  switch (stage) {
    case "barebone":
      return "Integrate your projects and start tapping into the Lunox network";
    case "github":
      return needsRepository || repository === undefined
        ? "GitHub is connected. Pick the repository your work is in to map it."
        : `${repository} is mapped. Write a bounty about it, or connect Jira to have the work found for you.`;
    case "jira":
    case "both":
      return (
        <>
          {complete && "This workspace is set up. "}
          Your board&rsquo;s tickets worth outsourcing are{" "}
          <button
            type="button"
            className="text-foreground underline underline-offset-2"
            onClick={() => reveal(SECTION.backlogScan)}
          >
            under getting started
          </button>
          .
        </>
      );
  }
}
