/**
 * The ticket in focus on a backlog scan, as the bounty it would become, and
 * the one button that makes it one.
 */

import { ApiError } from "@sandbox-factory/client";
import type { JiraBacklogPreviewDto } from "@sandbox-factory/shared";
import { ArrowUpRight, FolderGit2, Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";

import { Button } from "@/components/ui/button";

import { CategoryIcon } from "../../CategoryIcon";
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
 * What sizing writes is laid out with what is known now filled in — the
 * ticket, why it was picked, the range the rate card prices in, where its
 * sandbox would come from — and what only a model can say left as
 * placeholders: the size and the acceptance scenarios. The button fills them.
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

  return (
    <aside
      ref={ref}
      aria-label={`Bounty preview for ${issue.key}`}
      data-testid="teaser-bounty"
      className="bg-card flex flex-col gap-4 rounded-lg border p-4 lg:sticky lg:top-4"
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
          <span className="text-muted-foreground mt-1 flex items-start gap-1.5 text-xs">
            <CategoryIcon
              category={match.id}
              className="mt-px size-3 shrink-0"
            />
            <span>
              <span className="text-foreground/80 font-medium">
                {match.label}
              </span>{" "}
              · {match.reason}
            </span>
          </span>
        )}
      </div>

      <dl
        className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-3 border-t pt-4 text-xs"
        data-testid="teaser-facts"
      >
        <dt className="text-muted-foreground">Size</dt>
        <dd className="flex flex-wrap gap-1" aria-label="Not sized yet">
          {["XS", "S", "M", "L", "XL"].map((size) => (
            <span
              key={size}
              aria-hidden="true"
              className="text-muted-foreground/70 rounded-[4px] border border-dashed px-1.5 py-px font-mono text-[11px]"
            >
              {size}
            </span>
          ))}
        </dd>
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
        <dt className="text-muted-foreground">Spec</dt>
        <dd className="flex flex-col gap-1.5">
          <span aria-hidden="true" className="flex flex-col gap-1">
            <span className="bg-muted block h-1.5 w-11/12 rounded-full" />
            <span className="bg-muted block h-1.5 w-8/12 rounded-full" />
          </span>
          <span className="text-muted-foreground">
            Acceptance scenarios a reviewer can weigh
          </span>
        </dd>
        <dt className="text-muted-foreground">Sandbox</dt>
        <dd>
          {only !== undefined ? (
            <span className="flex min-w-0 items-center gap-1">
              <FolderGit2 className="text-muted-foreground size-3 shrink-0" />
              <span className="truncate">
                Cut from <span className="font-medium">{only.fullName}</span>,
                if its work touches it
              </span>
            </span>
          ) : repositories.length > 1 ? (
            <span className="flex min-w-0 items-center gap-1">
              <FolderGit2 className="text-muted-foreground size-3 shrink-0" />
              <span className="truncate">
                Cut from the repositories its work touches, of{" "}
                {repositories.length}
              </span>
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
              to cut it from your code
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
              onClick={() => void size()}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {busy ? `Sizing ${issue.key}…` : `Size ${issue.key}`}
            </Button>
            <p className="text-muted-foreground text-center text-xs">
              {!sizingAvailable
                ? "Sizing is not configured on this server."
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
    </aside>
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
