/**
 * What home and onboarding both say above their own content: how a consent
 * round trip went, a read that failed, and Jira sites that need connecting
 * again.
 *
 * Both, because a consent comes back to the page it started from — its
 * `returnTo` is that page's address — and Jira and GitHub can be connected
 * from either.
 */

import { RefreshCw } from "lucide-react";
import { useEffect } from "react";

import { ErrorBanner } from "@/components/Message";
import { OutcomeNotice } from "@/components/OutcomeNotice";
import { Button } from "@/components/ui/button";

import { describeGithubOutcome } from "./Github";
import { OutcomeBanner } from "./Jira";
import type { WorkspaceSetup } from "./features/onboarding/useWorkspaceSetup";
import { replaceLocation } from "./navigation/location";
import { pathForScreen } from "./routes";
import { useGithubOutcome } from "./useGithub";
import { useJiraOutcome } from "./useJira";

/**
 * The outcome of a consent round trip, read from the address once.
 *
 * Called at the top of the page, whatever it is about to show: the outcome
 * may be about to change it — a first site connected turns home into a
 * board.
 *
 * GitHub sends the person back to pick an account when several could be
 * linked. That picker is on the workspace's GitHub tab, so the flow is
 * carried on there, outcome and all, rather than told to pick on a page with
 * nothing to pick from. `picking` is true until it has moved.
 */
export function useConsentReturn(organizationSlug: string) {
  const jira = useJiraOutcome();
  // GitHub's flow lands here too when it cannot be tied to a workspace.
  const github = useGithubOutcome();
  const picking = github.outcome === "pick";
  useEffect(() => {
    if (picking)
      replaceLocation(
        `${pathForScreen("org-settings", organizationSlug, undefined, "github")}&github=pick`,
      );
  }, [picking, organizationSlug]);
  return { jira, github, picking };
}

export type ConsentReturn = ReturnType<typeof useConsentReturn>;

export function WorkspaceNotices({
  consent,
  setup,
  onOpenJiraSettings,
}: {
  consent: ConsentReturn;
  setup: WorkspaceSetup;
  onOpenJiraSettings: () => void;
}) {
  const { jira, github } = consent;
  const broken = setup.facts?.jira.broken ?? 0;
  return (
    <>
      {jira.outcome !== null && (
        <OutcomeBanner
          outcome={jira.outcome}
          missingScopes={jira.missingScopes}
          onDismiss={jira.dismiss}
        />
      )}
      {github.outcome !== null && (
        <OutcomeNotice
          {...describeGithubOutcome(github.outcome, "home")}
          onDismiss={github.dismiss}
          testId="github-outcome"
        />
      )}
      {setup.failed && (
        // One read failing must not take the page with it: what did load is
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
      {broken > 0 && <BrokenSites count={broken} onOpen={onOpenJiraSettings} />}
    </>
  );
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
