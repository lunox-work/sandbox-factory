/**
 * One context builder, as a row of the repository page's list: what it
 * does, the figures its build counted, and where its run on the chosen
 * snapshot stands. One per `CONTEXT_BUILDERS` entry, in that order.
 *
 * Every row lays out on the same three columns, so names, figures and
 * statuses line up down the list whatever each one holds. The status is
 * read off the run the page found; the row decides nothing about runs.
 * Runs are started for every builder at once, from the block's "Build
 * all"; a row says when its run is one an older version of the builder
 * made, whose files the current one would write differently, and so one
 * "Build all" would build again. What a build wrote opens with the rest
 * from the block's "View".
 */

import {
  BookOpenText,
  Database,
  GitFork,
  SquareFunction,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

import type { AnalysisRunDto } from "@sandbox-factory/shared";
import { toolVersionOf, type ContextBuilder } from "sandbox-factory";

import { StatusDot } from "./Blocks";
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
    description: "Writes a wiki of the repository with a model.",
    icon: BookOpenText,
  },
  abstractions: {
    description:
      "Lists every module's exports and their signatures. Builds on Graphify's map.",
    icon: SquareFunction,
  },
  data_model: {
    description:
      "Reads the schema's entities and relations. Builds on Graphify's map.",
    icon: Database,
  },
};

/**
 * The list's three columns, shared by every row: the builder, its figures
 * (three to a row at most), and its status. One column below `sm`.
 */
const BUILDER_COLUMNS =
  "sm:grid sm:grid-cols-[minmax(0,1fr)_18rem_7.5rem] sm:items-center sm:gap-x-6";

/** A finished run an older version of its builder made. */
function isOutdated(builder: ContextBuilder, run: AnalysisRunDto | undefined) {
  return (
    run !== undefined &&
    (run.status === "succeeded" || isExhausted(run)) &&
    run.toolVersion !== toolVersionOf(builder)
  );
}

function isExhausted(run: AnalysisRunDto | undefined) {
  return run?.status === "failed" && run.attempt >= run.maxAttempts;
}

/**
 * Whether "Build all" would start this builder: it has no run, a failed one
 * with retries left, or one an older version of it made. Runs are kept per
 * builder version, so a build asked for then is a new run; the old one's
 * files stay on view until it succeeds.
 */
export function needsBuild(
  builder: ContextBuilder,
  run: AnalysisRunDto | undefined,
) {
  return (
    run === undefined ||
    (run.status === "failed" && !isExhausted(run)) ||
    isOutdated(builder, run)
  );
}

export function BuilderRow({
  builder,
  run,
  pending,
  figures,
  onViewLog,
}: {
  builder: ContextBuilder;
  /** This builder's run on the chosen snapshot, when there is one. */
  run: AnalysisRunDto | undefined;
  /** "Build all" was just asked for and the API has not answered yet. */
  pending: boolean;
  /** Up to three figures from the build's summary, once they are known. */
  figures?: readonly { label: string; value: number }[] | undefined;
  /** Opens this builder's run log; owners and admins only. */
  onViewLog?: (() => void) | undefined;
}) {
  const name = builderNames[builder];
  const { description, icon: Icon } = BUILDER_DETAILS[builder];
  const failed = run?.status === "failed";
  const exhausted = isExhausted(run);
  return (
    <section
      aria-label={`${name} builder`}
      className={`flex flex-col gap-3 px-4 py-3 ${BUILDER_COLUMNS}`}
    >
      <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5 gap-y-0.5">
        <Icon className="text-muted-foreground mt-0.5 size-4" />
        <h3 className="text-sm font-medium">{name}</h3>
        <p className="text-muted-foreground col-start-2 text-xs">
          {description}
        </p>
        {failed && run.errorCode !== null && (
          <p className="text-destructive col-start-2 text-xs">
            {errorLabels[run.errorCode]}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-3 gap-3 max-sm:pl-[1.625rem]">
        {figures?.map((figure) => (
          <div key={figure.label} className="flex min-w-0 flex-col">
            <dd className="text-sm font-medium tabular-nums">
              {figure.value.toLocaleString()}
            </dd>
            <dt className="text-muted-foreground truncate text-xs">
              {figure.label}
            </dt>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-between gap-2 max-sm:pl-[1.625rem] sm:flex-col sm:items-end sm:justify-center sm:gap-1">
        <Status run={run} pending={pending} />
        {run !== undefined && isOutdated(builder, run) ? (
          <span
            className="text-muted-foreground text-xs"
            title={`Built by ${run.toolVersion}; the builder is now ${toolVersionOf(builder)}.`}
          >
            Outdated
          </span>
        ) : run?.status === "succeeded" && run.finishedAt !== null ? (
          <time
            dateTime={run.finishedAt}
            title={new Date(run.finishedAt).toLocaleString()}
            className="text-muted-foreground text-xs"
          >
            {shortDate(run.finishedAt)}
          </time>
        ) : exhausted ? (
          // The same snapshot and builder would answer with this run again:
          // a newer snapshot is what can be built.
          <span className="text-muted-foreground text-right text-xs">
            Retry limit reached. Pull a newer snapshot to build again.
            {onViewLog !== undefined && (
              <>
                {" "}
                <button
                  type="button"
                  className="text-primary rounded-sm font-medium hover:underline"
                  onClick={onViewLog}
                >
                  View log
                </button>
              </>
            )}
          </span>
        ) : null}
      </div>
    </section>
  );
}

/** Where the run stands, in a word and a dot. */
function Status({
  run,
  pending,
}: {
  run: AnalysisRunDto | undefined;
  pending: boolean;
}) {
  if (run === undefined)
    return pending ? (
      <StatusDot status="queued" />
    ) : (
      <StatusDot status={null} label="Not built" />
    );
  return (
    <StatusDot
      status={run.status}
      label={run.status === "succeeded" ? "Built" : undefined}
    />
  );
}

/** A finish time as a short date: `Oct 6, 5:31 PM`. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
