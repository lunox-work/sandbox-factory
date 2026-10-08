import type { BountyRunDto } from "@sandbox-factory/shared";
import { Circle, CircleCheck, CircleX, Loader2 } from "lucide-react";
import { money } from "../../lib/format";
import { CategoryLine } from "./Categories";
import { capitalize } from "./presentation";
import { type EnrichedProposal } from "./types";

import { Badge } from "@/components/ui/badge";

const SIZING_CONCURRENCY = 3;

/**
 * A run in flight, bounty by bounty.
 *
 * A board sized as a whole runs in the background, so its page is often
 * opened mid-run. This is what the run is doing: the bounties it picked, the
 * ones it has finished — with the size and amount as they land — the ones
 * being sized now, and the ones still waiting. The page polls every second
 * while a run is active, so rows turn over as the model answers.
 *
 * Which bounties are "sizing now" is inferred, not reported: the executor
 * takes the plan in order, a few at a time, so the first few without a
 * result are the ones in the model's hands.
 */
export function SizingStream({
  run,
  proposals,
  onOpen,
}: {
  run: BountyRunDto;
  proposals: EnrichedProposal[];
  onOpen: (proposalId: string) => void;
}) {
  const done = new Map(run.outcomes.map((o) => [o.externalIssueId, o]));
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const total = run.planned.length;
  let inFlight = 0;

  return (
    <section
      aria-label="Sizing in progress"
      className="overflow-hidden rounded-lg border"
      data-testid="sizing-active"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
        <Loader2 className="text-muted-foreground size-4 animate-spin" />
        {total === 0 ? (
          <span>Picking tickets from the board…</span>
        ) : (
          <span>
            Sizing {total} {total === 1 ? "bounty" : "bounties"}
            <span className="text-muted-foreground"> · {done.size} done</span>
          </span>
        )}
      </div>
      {total > 0 && (
        <>
          <div
            className="bg-muted h-0.5"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done.size}
          >
            <div
              className="h-full bg-(image:--brand-gradient) transition-[width] duration-500 ease-out"
              style={{ width: `${(done.size / total) * 100}%` }}
            />
          </div>
          {/*
            Scrolls within itself: a run sizes every bounty that fits a
            category, and a plan of hundreds must not push the proposals
            it is producing off the page.
          */}
          <ul className="max-h-96 divide-y overflow-y-auto text-sm">
            {run.planned.map((bounty) => {
              const outcome = done.get(bounty.externalIssueId);
              const proposal =
                outcome?.proposalId === undefined
                  ? undefined
                  : byId.get(outcome.proposalId);
              const sizing =
                outcome === undefined && inFlight++ < SIZING_CONCURRENCY;
              return (
                <li
                  key={bounty.externalIssueId}
                  className="flex items-center gap-3 px-3 py-2"
                  data-state={
                    outcome !== undefined
                      ? "done"
                      : sizing
                        ? "sizing"
                        : "queued"
                  }
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {outcome === undefined ? (
                      sizing ? (
                        <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
                      ) : (
                        <Circle className="text-muted-foreground/50 size-3" />
                      )
                    ) : outcome.status === "failed" ? (
                      <CircleX className="size-4 text-red-600 dark:text-red-400" />
                    ) : (
                      <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                    )}
                  </span>
                  <span className="w-20 shrink-0 font-mono text-xs">
                    {bounty.issueKey}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={`truncate ${outcome === undefined && !sizing ? "text-muted-foreground" : ""}`}
                    >
                      {bounty.summary}
                    </span>
                    <CategoryLine categories={bounty.categories} />
                  </span>
                  {proposal !== undefined ? (
                    <button
                      type="button"
                      className="flex shrink-0 items-center gap-2 animate-in fade-in"
                      onClick={() => onOpen(proposal.id)}
                    >
                      <Badge variant="outline" className="font-mono">
                        {proposal.complexity}
                      </Badge>
                      <span className="w-20 text-right tabular-nums">
                        {money(proposal.amountMinor, proposal.currency)}
                      </span>
                    </button>
                  ) : outcome !== undefined ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {capitalize(outcome.status)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** The sizing model's confidence as a mark and a colour: up, level, or down. */
