/**
 * Under a repository being set up: how far its first build has got, a
 * line for where it is and a mark per builder. The builders a snapshot
 * waits on come first; the wiki, which is not waited on, last, saying so.
 */

import type { AnalysisRunDto } from "@sandbox-factory/shared";
import { Check, Circle, Loader2, Minus, RotateCw } from "lucide-react";
import { REQUIRED_BUILDERS, type ContextBuilder } from "sandbox-factory";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { builderNames } from "./labels";
import type { RepositoryBuild } from "./useRepositoryBuilds";

const shortSha = (sha: string) => sha.slice(0, 7);

function BuilderMark({ run }: { run: AnalysisRunDto | undefined }) {
  const status = run?.status;
  if (status === "succeeded")
    return <Check aria-label="Built" className="text-foreground size-3" />;
  if (status === "failed")
    return <Minus aria-label="Failed" className="size-3" />;
  if (status === "running")
    return <Loader2 aria-label="Building" className="size-3 animate-spin" />;
  return <Circle aria-label="Queued" className="size-2.5" />;
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

export function RepositoryBuildProgress({
  build,
  onRetry,
}: {
  build: RepositoryBuild;
  onRetry: () => void;
}) {
  const runs =
    build.phase === "building" || build.phase === "built" ? build.runs : null;
  const shown: ContextBuilder[] = [...REQUIRED_BUILDERS, "deepwiki"];
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
        <ul className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-2xs">
          {shown.map((builder) => (
            <li key={builder} className="flex items-center gap-1">
              <span className="flex size-3 items-center justify-center">
                <BuilderMark run={runs[builder]} />
              </span>
              {builderNames[builder]}
              {builder === "deepwiki" && build.phase === "building" && (
                <span className="text-muted-foreground/70">
                  (not waited on)
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
