/**
 * Under a repository being set up: how far its first build has got, a
 * line for where it is and a row per builder. The builders that can run
 * at once each fill a bar, side by side; one that waits names the
 * builders it waits for (`readsGraph`, `readsBuilders` in core).
 */

import type { AnalysisRunDto } from "@sandbox-factory/shared";
import { Check, Loader2, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import {
  CONTEXT_BUILDERS,
  readsBuilders,
  readsGraph,
  type ContextBuilder,
} from "sandbox-factory";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { builderNames } from "./labels";
import type { RepositoryBuild } from "./useRepositoryBuilds";

const shortSha = (sha: string) => sha.slice(0, 7);

type Runs = Partial<Record<ContextBuilder, AnalysisRunDto>>;

const ended = (run: AnalysisRunDto | undefined) =>
  run?.status === "succeeded" || run?.status === "failed";

/** The builders `builder` reads whose runs have not ended, in list order. */
export function waitingOn(builder: ContextBuilder, runs: Runs) {
  const inputs = readsBuilders(builder)
    ? CONTEXT_BUILDERS.filter((other) => !readsBuilders(other))
    : readsGraph(builder)
      ? (["graphify"] as const)
      : [];
  return inputs.filter((input) => !ended(runs[input]));
}

function headline(build: RepositoryBuild): string {
  switch (build.phase) {
    case "waiting":
      return "Waiting for the build before it…";
    case "reading":
      return "Reading its file list…";
    case "building":
      return build.held
        ? `Waiting for other analysis to finish before building ${shortSha(build.commitSha)}…`
        : `Building ${shortSha(build.commitSha)}…`;
    case "built":
      return `Built at ${shortSha(build.commitSha)}`;
    case "failed":
      return build.error;
  }
}

/**
 * A thin bar: filled to `percent`, or a sliding segment with none. A done
 * one is quieter, so the bars still filling stand out.
 */
function Bar({
  percent,
  done = false,
}: {
  percent: number | null;
  done?: boolean;
}) {
  return (
    <span
      className="bg-muted relative block h-1 overflow-hidden rounded-full"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          done ? "bg-muted-foreground/45" : "bg-foreground",
          percent === null
            ? "build-bar-sweep w-[30%] opacity-60"
            : "transition-[width] duration-500 ease-out",
        )}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </span>
  );
}

/** One builder's row: its name, then its bar and figure, or what it waits for. */
function BuilderLine({
  builder,
  runs,
}: {
  builder: ContextBuilder;
  runs: Runs;
}) {
  const run = runs[builder];
  const name = builderNames[builder];
  const waits = waitingOn(builder, runs);
  let progress: ReactNode;
  if (run?.status === "succeeded")
    progress = (
      <>
        <Bar percent={100} done />
        <Check aria-label="Built" className="text-foreground size-3" />
      </>
    );
  else if (run?.status === "failed")
    progress = <span className="col-span-2">Failed</span>;
  else if (run?.status === "running") {
    const fraction = run.progress?.fraction;
    const percent =
      fraction === undefined
        ? null
        : Math.floor((fraction.done / fraction.total) * 100);
    progress = (
      <>
        <Bar percent={percent} />
        <span className="text-foreground tabular-nums">
          {percent === null ? "" : `${percent}%`}
        </span>
      </>
    );
  } else
    progress = (
      <span className="col-span-2 truncate">
        {waits.length > 0
          ? `Waiting for ${waits.map((input) => builderNames[input]).join(", ")}`
          : "Queued"}
      </span>
    );
  return (
    <li
      aria-label={name}
      className="col-span-3 grid grid-cols-subgrid items-center"
    >
      <span className={cn(run?.status === "running" && "text-foreground")}>
        {name}
      </span>
      {progress}
    </li>
  );
}

export function RepositoryBuildProgress({
  build,
  onRetry,
}: {
  build: RepositoryBuild;
  onRetry: () => void;
}) {
  const runs =
    build.phase === "building" || build.phase === "built" ? build.runs : null;
  return (
    <div
      className="flex flex-col gap-1.5 pb-2 pl-7"
      data-testid="repository-build"
      role="status"
    >
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs",
          build.phase === "failed"
            ? "text-destructive"
            : "text-muted-foreground",
        )}
      >
        {build.phase === "built" ? (
          <Check className="text-foreground size-3 shrink-0" />
        ) : build.phase === "failed" ? null : (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        )}
        <span className="min-w-0">{headline(build)}</span>
        {build.phase === "failed" && (
          <Button
            variant="ghost"
            size="sm"
            className="text-foreground ml-auto h-6 shrink-0 gap-1 px-2 text-xs"
            onClick={onRetry}
          >
            <RotateCw className="size-3" />
            Try again
          </Button>
        )}
      </p>
      {runs !== null && (
        <ul
          aria-label="Builders"
          className="text-muted-foreground grid grid-cols-[6rem_minmax(0,1fr)_2.25rem] gap-x-3 gap-y-1.5 pl-[1.125rem] text-2xs"
        >
          {CONTEXT_BUILDERS.map((builder) => (
            <BuilderLine key={builder} builder={builder} runs={runs} />
          ))}
        </ul>
      )}
    </div>
  );
}
