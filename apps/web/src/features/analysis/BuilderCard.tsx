/**
 * One context builder, as a card in the repository page's grid: what it
 * does, where its run on the chosen snapshot stands, and the one action
 * that stands for that state. One per `CONTEXT_BUILDERS` entry, in that
 * order.
 *
 * The status is read off the run the page found for this builder and
 * snapshot; the card decides nothing about runs itself. The action is
 * "Build" until a run exists, "Building…" while it is in the queue or on
 * a worker, "View" once it has succeeded, and a disabled note once the
 * retries are spent. A member who cannot start runs gets "View" alone.
 */

import {
  BookOpenText,
  Database,
  GitFork,
  SquareFunction,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AnalysisRunDto } from "@sandbox-factory/shared";
import type { ContextBuilder } from "sandbox-factory";

import { builderNames, errorLabels } from "./labels";

/** What each builder does, in one line, and the icon that stands for it. */
export const BUILDER_DETAILS: Record<
  ContextBuilder,
  { description: string; icon: LucideIcon }
> = {
  graphify: {
    description: "Maps symbols, files and the imports between them.",
    icon: Waypoints,
  },
  dependency_cruiser: {
    description: "Cruises module dependencies, cycles and orphans.",
    icon: GitFork,
  },
  deepwiki: {
    description:
      "Writes a wiki of the repository with a model, through a DeepWiki-Open service.",
    icon: BookOpenText,
  },
  abstractions: {
    description:
      "Lists every module's exports and their signatures: what a stub looks like at any cut. Builds on Graphify's map.",
    icon: SquareFunction,
  },
  data_model: {
    description:
      "Reads the entities, fields and relations the schema and migrations declare, and the modules that touch them. Builds on Graphify's map.",
    icon: Database,
  },
};

export function BuilderCard({
  builder,
  run,
  manageable,
  pending,
  disabled,
  figures,
  onBuild,
  onView,
  className,
}: {
  builder: ContextBuilder;
  /** This builder's run on the chosen snapshot, when there is one. */
  run: AnalysisRunDto | undefined;
  manageable: boolean;
  /** A build was just asked for and the API has not answered yet. */
  pending: boolean;
  /** No snapshot to build on. */
  disabled: boolean;
  /** Two or three figures from the run's result, once they are known. */
  figures?: readonly { label: string; value: number }[] | undefined;
  onBuild: () => void;
  onView: () => void;
  /** Its place in the page's grid. */
  className?: string;
}) {
  const name = builderNames[builder];
  const { description, icon: Icon } = BUILDER_DETAILS[builder];
  const busy = pending || run?.status === "queued" || run?.status === "running";
  const exhausted = run?.status === "failed" && run.attempt >= run.maxAttempts;
  const action = !manageable ? (
    run?.status === "succeeded" ? (
      <Button variant="outline" size="sm" onClick={onView}>
        View
      </Button>
    ) : null
  ) : busy ? (
    <Button size="sm" disabled>
      Building…
    </Button>
  ) : run?.status === "succeeded" ? (
    <Button variant="outline" size="sm" onClick={onView}>
      View
    </Button>
  ) : exhausted ? (
    <Button size="sm" disabled>
      Retry limit reached
    </Button>
  ) : (
    <Button size="sm" disabled={disabled} onClick={onBuild}>
      Build
    </Button>
  );
  return (
    <section
      aria-label={`${name} builder`}
      className={cn("flex flex-col gap-3 rounded-[6px] border p-3", className)}
    >
      <div className="flex items-start gap-2.5">
        <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-sm font-medium">{name}</h3>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <StatusLine run={run} pending={pending} />
      </div>
      {figures !== undefined && figures.length > 0 && (
        <dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {figures.map((figure) => (
            <div key={figure.label} className="flex items-baseline gap-1">
              <dd className="font-semibold tabular-nums">
                {figure.value.toLocaleString()}
              </dd>
              <dt className="text-muted-foreground">{figure.label}</dt>
            </div>
          ))}
        </dl>
      )}
      {action !== null && <div className="mt-auto flex">{action}</div>}
    </section>
  );
}

/** Where the run stands, as a badge and a line under it. */
function StatusLine({
  run,
  pending,
}: {
  run: AnalysisRunDto | undefined;
  pending: boolean;
}) {
  if (run === undefined) {
    return (
      <Badge variant="outline" className="rounded-[4px]">
        {pending ? "Queued" : "Not built"}
      </Badge>
    );
  }
  switch (run.status) {
    case "queued":
      return (
        <Badge variant="secondary" className="rounded-[4px]">
          Queued
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary" className="rounded-[4px]">
          Running
        </Badge>
      );
    case "succeeded":
      return (
        <>
          <Badge className="rounded-[4px]">Built</Badge>
          {run.finishedAt !== null && (
            <p className="text-muted-foreground text-xs">
              {new Date(run.finishedAt).toLocaleString()}
            </p>
          )}
        </>
      );
    case "failed":
      return (
        <>
          <Badge variant="destructive" className="rounded-[4px]">
            Failed
          </Badge>
          {run.errorCode !== null && (
            <p className="text-destructive text-xs">
              {errorLabels[run.errorCode]}
            </p>
          )}
        </>
      );
  }
}
