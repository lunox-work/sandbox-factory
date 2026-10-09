/**
 * An agent's run as it works: what it is doing, how long it has taken, and
 * its last few steps as the worker writes them ("Read src/mailer.ts",
 * "Tried a slice: 14 files"), the newest arriving under the ones before.
 *
 * The steps are read from the run's progress, polled while it runs. A run
 * that has taken none yet, or one whose progress cannot be read, shows the
 * line alone, which is what every run showed before steps were written.
 */

import type { AnalysisProgressDto } from "@sandbox-factory/shared";
import { Check } from "lucide-react";

import { useObservation } from "@/data/observe";
import { clients } from "@/data/query";
import { cn } from "@/lib/utils";

import type { OrbState } from "./Orb";
import { ThinkingLine } from "./Thinking";

/** How often a run in flight is read again for its steps. */
export const ACTIVITY_POLL_MS = 2_000;

/** How many of the newest steps are shown. */
const SHOWN = 5;

/**
 * One analysis run, read again while it is queued or running. Null until
 * there is a run to read.
 */
export function useRunActivity(owner: string, runId: string | null) {
  const query = useObservation({
    owner,
    resource: "analysis-run",
    id: runId,
    read: (id, signal) => clients.analysis.run(owner, id, signal),
    terminal: (run) => run.status !== "queued" && run.status !== "running",
    interval: ACTIVITY_POLL_MS,
  });
  return query.data ?? null;
}

export function RunActivity({
  children,
  state,
  progress,
  since,
  expected,
  className,
}: {
  /** What the run is doing, in one line. */
  children: React.ReactNode;
  /** What the orb does; see `ThinkingLine`. */
  state?: OrbState;
  progress: AnalysisProgressDto | null | undefined;
  /** When it started, for the clock; absent, no clock. */
  since?: string | null | undefined;
  expected?: string | undefined;
  className?: string;
}) {
  const steps = progress?.steps.slice(-SHOWN) ?? [];
  const earlier = (progress?.count ?? 0) - steps.length;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <ThinkingLine state={state} since={since} expected={expected}>
        {children}
      </ThinkingLine>
      {steps.length > 0 && (
        <ol
          className="border-muted ml-2.5 flex flex-col gap-1 border-l pl-4 text-xs"
          aria-label="What it has done so far"
          data-testid="run-activity"
        >
          {earlier > 0 && (
            <li className="text-muted-foreground/70">
              {earlier} earlier {earlier === 1 ? "step" : "steps"}
            </li>
          )}
          {steps.map((step, index) => {
            const newest = index === steps.length - 1;
            return (
              <li
                // Keyed by its place in the whole run, so a step that has
                // been seen keeps its element and only a new one animates.
                key={(progress?.count ?? 0) - steps.length + index}
                className={cn(
                  "flex min-w-0 items-center gap-1.5",
                  newest
                    ? "activity-step-enter text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "size-3 shrink-0",
                    newest ? "text-primary" : "text-muted-foreground/60",
                  )}
                />
                <span className="min-w-0 truncate" title={step.text}>
                  {step.text}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
