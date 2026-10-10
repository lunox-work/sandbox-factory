/**
 * The ticket in focus on a backlog scan, as the bounty it would become, and
 * the one button that makes it one.
 */

import { ApiError } from "@sandbox-factory/client";
import type { JiraBacklogPreviewDto } from "@sandbox-factory/shared";
import { ArrowUpRight, FolderGit2, Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { CategoryIcon } from "../../CategoryIcon";
import { ProviderIcon } from "../../ProviderIcon";
import { terminalRun, useObservation } from "../../data/observe";
import { clients } from "../../data/query";
import { wholeMoney } from "../../lib/format";
import { pushLocation } from "../../navigation/location";
import { BOUNTIES_PATH } from "../../routes";

type PreviewIssue = JiraBacklogPreviewDto["issues"][number];

/**
 * One of the workspace's repositories, any of which a bounty on this board
 * may touch: sized beside, and cut from those its sizing says it does.
 */
export interface ScanRepository {
  fullName: string;
}

/**
 * How a workspace with no repository gets one, said inside a sentence:
 * "connect GitHub", "pick a repository". Absent where there is no way, or
 * the person may not take it.
 */
export interface RepositoryAction {
  label: string;
  onSelect: () => void;
}

/**
 * The ticket in focus, as the bounty it would become.
 *
 * What is known before sizing is laid out — the ticket, why it was picked,
 * the range the rate card prices in, where its sandbox would come from — and
 * the button sizes it.
 *
 * Where the server offers GitHub, a ticket is sized beside the code, so a
 * workspace with no repository yet is told to add one when it presses the
 * button, rather than sized from the ticket alone without being asked.
 */
export function TeaserBounty({
  organizationId,
  organizationSlug,
  boardId,
  issue,
  canManage,
  sizingAvailable,
  boardBusy,
  repositories,
  repositoryAction,
  githubRequired = false,
  range,
  onSized,
  onSizing,
  ref,
}: {
  organizationId: string;
  /** The workspace's handle, which the sized bounty's page is addressed by. */
  organizationSlug: string;
  boardId: string;
  issue: PreviewIssue;
  canManage: boolean;
  sizingAvailable: boolean;
  /** The whole board is being sized: a single ticket would be refused. */
  boardBusy: boolean;
  /** The workspace's repositories; none when it has connected none. */
  repositories: readonly ScanRepository[];
  repositoryAction?: RepositoryAction | undefined;
  /** Sizing needs a repository, and the workspace must add one first. */
  githubRequired?: boolean | undefined;
  /** The rate card to quote a range from; undefined while it loads. */
  range: { currency: string; sMinor: number; lMinor: number } | undefined;
  onSized: () => Promise<void>;
  /** Told the ticket's id while it is being sized, and null once it is not. */
  onSizing?: ((issueId: string | null) => void) | undefined;
  ref?: Ref<HTMLElement> | undefined;
}) {
  // The one repository there is, named; several are counted.
  const only = repositories.length === 1 ? repositories[0] : undefined;
  const reading =
    only !== undefined
      ? `, reading ${only.fullName}`
      : repositories.length > 1
        ? `, reading ${repositories.length} repositories`
        : "";
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const following = useObservation({
    owner: organizationId,
    resource: "run",
    id: runId,
    read: (id, signal) => clients.runs.run(organizationId, id, signal),
    terminal: (run) =>
      terminalRun(run) || run.outcomes[0]?.proposalId !== undefined,
    interval: 1000,
    startDelay: 1000,
  });
  const finished = useRef<string | null>(null);

  useEffect(() => {
    const run = following.data;
    if (runId === null || run === undefined || finished.current === run.id)
      return;
    const proposalId = run.outcomes[0]?.proposalId;
    if (proposalId === undefined && !terminalRun(run)) return;
    finished.current = run.id;
    setRunId(null);
    if (proposalId !== undefined)
      void openProposal(organizationSlug, proposalId, onSized);
    else setMessage(`Could not size ${issue.key}. Try again in a moment.`);
  }, [following.data, runId, issue.key, onSized, organizationSlug]);

  async function size() {
    setMessage(null);
    setStarting(true);
    try {
      const body = await clients.jira.proposeIssue(
        organizationId,
        boardId,
        issue.id,
        crypto.randomUUID(),
      );
      if (body.proposalId !== undefined)
        await openProposal(organizationSlug, body.proposalId, onSized);
      else if (body.run !== undefined) setRunId(body.run.id);
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? error.message
          : "Could not reach the server.",
      );
    } finally {
      setStarting(false);
    }
  }

  const busy = starting || runId !== null;
  useEffect(() => {
    if (!busy) return;
    onSizing?.(issue.id);
    return () => onSizing?.(null);
  }, [busy, issue.id, onSizing]);
  const match = issue.categories?.[0];
  // Nothing to size beside: the button asks for GitHub instead of sizing.
  const needsCode = githubRequired && repositories.length === 0;
  const [asking, setAsking] = useState(false);

  return (
    <aside
      ref={ref}
      aria-label={`Bounty preview for ${issue.key}`}
      data-testid="teaser-bounty"
      // Its category's colour glows in from the corner, as the row it was
      // picked from is marked in it.
      data-category={match?.id}
      className={`bg-card flex flex-col gap-4 rounded-lg border p-4 lg:sticky lg:top-4 ${match === undefined ? "" : "category-glow"}`}
    >
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
          <span className="font-mono">{issue.key}</span>
          {issue.url !== null && (
            <a
              href={issue.url}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground inline-flex items-center gap-0.5 rounded-sm"
            >
              Jira
              <ArrowUpRight className="size-3" />
            </a>
          )}
        </span>
        <p className="text-sm leading-snug font-medium">{issue.summary}</p>
        {match !== undefined && (
          <span className="text-muted-foreground mt-1.5 flex flex-col items-start gap-1.5 text-xs">
            <span className="category-pill">
              <CategoryIcon category={match.id} className="size-3 shrink-0" />
              {match.label}
            </span>
            <span className="leading-snug">{match.reason}</span>
          </span>
        )}
      </div>

      <dl
        className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-3 border-t pt-4 text-xs"
        data-testid="teaser-facts"
      >
        <dt className="text-muted-foreground">Bounty</dt>
        <dd>
          {range === undefined ? (
            <span className="skeleton inline-block h-3 w-24 rounded align-middle" />
          ) : (
            <>
              <span className="font-medium tabular-nums">
                {wholeMoney(range.sMinor, range.currency)}–
                {wholeMoney(range.lMinor, range.currency)}
              </span>
              <span className="text-muted-foreground">
                {" "}
                typical, sizes S to L on your rate card
              </span>
            </>
          )}
        </dd>
        <dt className="text-muted-foreground">Sandbox</dt>
        <dd>
          {only !== undefined ? (
            <span className="flex min-w-0 items-center gap-1">
              <FolderGit2 className="text-muted-foreground size-3 shrink-0" />
              <span className="truncate">
                Sliced from <span className="font-medium">{only.fullName}</span>
                , if its work touches it
              </span>
            </span>
          ) : repositories.length > 1 ? (
            <span className="flex min-w-0 items-center gap-1">
              <FolderGit2 className="text-muted-foreground size-3 shrink-0" />
              <span className="truncate">
                Sliced from the repositories its work touches, of{" "}
                {repositories.length}
              </span>
            </span>
          ) : needsCode ? (
            // Sizing waits for the code, so there is no "from the ticket".
            <span className="text-muted-foreground">
              Sliced from your code, once{" "}
              {repositoryAction === undefined ? (
                "a repository is added"
              ) : (
                <button
                  type="button"
                  onClick={repositoryAction.onSelect}
                  className="text-foreground rounded-sm font-medium underline underline-offset-2"
                >
                  you {repositoryAction.label}
                </button>
              )}
            </span>
          ) : repositoryAction !== undefined ? (
            <span className="text-muted-foreground">
              Generated from the ticket, or{" "}
              <button
                type="button"
                onClick={repositoryAction.onSelect}
                className="text-foreground rounded-sm font-medium underline underline-offset-2"
              >
                {repositoryAction.label}
              </button>{" "}
              to slice it from your code
            </span>
          ) : (
            <span className="text-muted-foreground">
              Generated from the ticket
            </span>
          )}
        </dd>
      </dl>

      <div className="flex flex-col gap-1.5 border-t pt-4">
        {!canManage ? (
          <p className="text-muted-foreground text-xs">
            An owner or admin of this workspace can size this ticket.
          </p>
        ) : (
          <>
            <Button
              className="w-full gap-2"
              disabled={busy || !sizingAvailable || boardBusy}
              onClick={() => (needsCode ? setAsking(true) : void size())}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {busy ? `Sizing ${issue.key}…` : `Size ${issue.key}`}
            </Button>
            <p className="text-muted-foreground text-center text-xs">
              {!sizingAvailable
                ? "Sizing is not configured on this server."
                : needsCode
                  ? "Needs GitHub connected first"
                  : boardBusy
                    ? "The whole board is being sized now."
                    : busy
                      ? "About a minute. It opens here when it is ready."
                      : `About a minute · one model call${reading}`}
            </p>
          </>
        )}
        {message !== null && (
          <p className="text-destructive text-xs" role="alert">
            {message}
          </p>
        )}
      </div>
      <ConnectGithubDialog
        issueKey={issue.key}
        open={asking}
        onOpenChange={setAsking}
        action={repositoryAction}
      />
    </aside>
  );
}

/**
 * Said when a ticket is sized in a workspace with no code to size it
 * beside: what is missing, why it matters, and the way to add it.
 */
function ConnectGithubDialog({
  issueKey,
  open,
  onOpenChange,
  action,
}: {
  issueKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "connect GitHub" or "pick a repository"; absent for a member. */
  action: RepositoryAction | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="pr-8">
          <span className="mb-1 grid size-10 place-items-center rounded-lg border [&_svg]:size-5">
            <ProviderIcon provider="github" />
          </span>
          <DialogTitle>Connect GitHub to size {issueKey}</DialogTitle>
          <DialogDescription>
            A ticket is sized beside the code its work touches: the size, the
            price and the acceptance scenarios are read against your repository,
            and its sandbox is sliced from it. Add a repository, then size{" "}
            {issueKey}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          {action === undefined ? (
            <p className="text-muted-foreground self-center text-xs">
              An owner or admin of this workspace can connect it.
            </p>
          ) : (
            <Button
              onClick={() => {
                onOpenChange(false);
                action.onSelect();
              }}
            >
              {action.label.charAt(0).toUpperCase() + action.label.slice(1)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Opens the bounty a proposal was made for, on the tab its proposal is in:
 * what is cached is read again first, then the bounties page is named the
 * workspace and the proposal, which it opens as its bounty's page.
 */
async function openProposal(
  workspace: string,
  proposalId: string,
  refresh: () => Promise<void>,
): Promise<void> {
  await refresh();
  pushLocation(
    `${BOUNTIES_PATH}?${new URLSearchParams({ workspace, proposal: proposalId }).toString()}`,
  );
}
