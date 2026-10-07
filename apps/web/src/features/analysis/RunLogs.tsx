/**
 * The repository's run logs, in a dialog drawn as the sandbox page's
 * workbench is: every run down the sidebar, newest first, and the open
 * one's log beside it as its terminal panel prints output, ending in how
 * the run exited. Owners and admins only, as the API is.
 *
 * A worker writes a run's log when the run finishes, so a run still queued
 * or running has none yet; its log is read once it has.
 */

import { ApiError } from "@sandbox-factory/client";
import type { AnalysisRunDto } from "@sandbox-factory/shared";
import { useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  Loader2,
  ScrollText,
} from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { clients, queryKeys, useUserId } from "../../data/query";
import { sizeLabel } from "../sandbox/file-tree";
import { errorLabels, runDuration, runLabel, statusLabels } from "./labels";
import { Panes, Watermark, WorkbenchDialog } from "./WorkbenchDialog";

export function RunLogs({
  owner,
  repository,
  runs,
  commitOf,
  openOn,
  onClose,
  onOpenRaw,
  notice,
}: {
  owner: string;
  repository: string;
  /** Every run on the repository, newest first. */
  runs: readonly AnalysisRunDto[];
  /** The commit a run read, short. */
  commitOf: (run: AnalysisRunDto) => string;
  /** The run whose log the dialog opens on; null while it is closed. */
  openOn: string | null;
  onClose: () => void;
  /** Opens a run's log through its signed URL in a new tab. */
  onOpenRaw: (runId: string) => void;
  /** A failure from inside the dialog; see `WorkbenchDialog`. */
  notice?: { text: string; onDismiss: () => void } | null | undefined;
}) {
  return (
    <WorkbenchDialog
      notice={notice}
      title="Logs"
      detail={repository}
      description="Each analysis run's log, newest run first."
      open={openOn !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Logs
        owner={owner}
        runs={runs}
        commitOf={commitOf}
        initial={openOn}
        onOpenRaw={onOpenRaw}
      />
    </WorkbenchDialog>
  );
}

function Logs({
  owner,
  runs,
  commitOf,
  initial,
  onOpenRaw,
}: {
  owner: string;
  runs: readonly AnalysisRunDto[];
  commitOf: (run: AnalysisRunDto) => string;
  initial: string | null;
  onOpenRaw: (runId: string) => void;
}) {
  const [selected, setSelected] = useState(initial);
  const run = runs.find(({ id }) => id === selected);
  return (
    <Panes
      sidebarTitle="Runs"
      sidebar={
        <nav aria-label="Runs" className="min-h-0 flex-1 overflow-auto pb-4">
          {runs.length === 0 ? (
            <p className="px-5 text-xs text-(--wb-muted)">No runs yet.</p>
          ) : (
            <ul>
              {runs.map((each) => {
                const current = each.id === selected;
                return (
                  <li key={each.id}>
                    <button
                      type="button"
                      aria-current={current ? "true" : undefined}
                      onClick={() => setSelected(each.id)}
                      className={cn(
                        "flex w-full items-start gap-2 py-1.5 pr-3 pl-4 text-left hover:bg-(--wb-hover) focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)",
                        current &&
                          "bg-(--wb-selected) text-(--wb-strong) hover:bg-(--wb-selected)",
                      )}
                    >
                      <StatusIcon run={each} className="mt-px" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{runLabel(each)}</span>
                        <span className="truncate text-xs text-(--wb-muted)">
                          <span className="font-(family-name:--wb-font-code)">
                            {commitOf(each)}
                          </span>
                          {" · "}
                          {new Date(each.createdAt).toLocaleString()}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      }
    >
      {run === undefined ? (
        <Watermark icon={ScrollText}>Choose a run to read its log.</Watermark>
      ) : (
        <Log
          key={run.id}
          owner={owner}
          run={run}
          commit={commitOf(run)}
          onOpenRaw={onOpenRaw}
        />
      )}
    </Panes>
  );
}

/** A run's status as the workbench's status bar draws a build's. */
function StatusIcon({
  run,
  className,
}: {
  run: AnalysisRunDto;
  className?: string;
}) {
  const label = statusLabels[run.status];
  const shared = cn("size-3.5 shrink-0", className);
  switch (run.status) {
    case "succeeded":
      return (
        <CircleCheck
          aria-label={label}
          className={cn(shared, "text-[#73c991]")}
        />
      );
    case "failed":
      return (
        <CircleX aria-label={label} className={cn(shared, "text-[#f48771]")} />
      );
    case "running":
      return (
        <Loader2 aria-label={label} className={cn(shared, "animate-spin")} />
      );
    case "queued":
      return (
        <CircleDashed
          aria-label={label}
          className={cn(shared, "text-(--wb-muted)")}
        />
      );
  }
}

function Log({
  owner,
  run,
  commit,
  onOpenRaw,
}: {
  owner: string;
  run: AnalysisRunDto;
  /** The commit it read, short. */
  commit: string;
  onOpenRaw: (runId: string) => void;
}) {
  const userId = useUserId();
  const finished = run.status === "succeeded" || run.status === "failed";
  const log = useQuery({
    // Each attempt writes a log of its own.
    queryKey: queryKeys.resource(
      userId,
      owner,
      "analysis-log",
      run.id,
      run.attempt,
    ),
    queryFn: ({ signal }) => clients.analysis.logContent(owner, run.id, signal),
    enabled: finished,
    staleTime: Infinity,
    // No retry of its own: a failed read says so, and "Try again" is the
    // deliberate retry, as everywhere else.
    retry: false,
  });
  const missing = log.error instanceof ApiError && log.error.isNotFound;

  // What the terminal prints after the header: the log, or why there is none.
  let output: React.ReactNode;
  if (!finished)
    output = (
      <Line tone="muted">
        This run is {run.status === "queued" ? "queued" : "running"}; its log is
        written when it finishes.
      </Line>
    );
  else if (log.isPending) output = <Line tone="muted">Reading the log…</Line>;
  else if (missing)
    output = <Line tone="muted">No log was kept for this run.</Line>;
  else if (log.isError)
    output = (
      <Line tone="error">
        The log could not be read.{" "}
        <InlineAction onClick={() => void log.refetch()}>
          Try again
        </InlineAction>
      </Line>
    );
  else if (log.data.text === null)
    output = (
      <Line tone="muted">
        {log.data.omitted === "too_large"
          ? `This log is ${sizeLabel(log.data.sizeBytes)}, too large to show here.`
          : "This log is not text, so it is not shown here."}{" "}
        <InlineAction onClick={() => onOpenRaw(run.id)}>
          Open in a new tab
        </InlineAction>
      </Line>
    );
  else if (log.data.text.trim() === "")
    output = <Line tone="muted">The log is empty.</Line>;
  else
    output = log.data.text
      .replace(/\n+$/, "")
      .split("\n")
      .map((text, index) => (
        <Line key={index} tone={toneOf(text)}>
          {text}
        </Line>
      ));

  const duration = runDuration(run);
  return (
    <section
      aria-label={`${runLabel(run)} log`}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--wb-chrome)"
    >
      {/* The panel's tab strip, as the editor's terminal has it. */}
      <div className="flex h-[35px] shrink-0 items-center gap-3 border-b border-(--wb-border) pr-2 pl-3">
        <span className="flex h-full items-center border-b border-(--wb-foreground) text-[11px] tracking-wide text-(--wb-strong) uppercase">
          Terminal
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-(--wb-muted)">
          {/* `attempt` counts the retries made, `maxAttempts` the retries
              allowed: the first try is one more than either. */}
          {runLabel(run)} · attempt {run.attempt + 1} of {run.maxAttempts + 1}
        </span>
        {finished && !missing && (
          <button
            type="button"
            title="Open in a new tab"
            aria-label="Open the log in a new tab"
            onClick={() => onOpenRaw(run.id)}
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-(--wb-muted) hover:bg-(--wb-hover) hover:text-(--wb-foreground) focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)"
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
      <div
        role="log"
        className="min-h-0 flex-1 overflow-auto px-4 py-3 font-(family-name:--wb-font-code) text-[12.5px] leading-[1.6]"
      >
        <Line tone="muted">
          <span aria-hidden="true">$ </span>
          {runLabel(run)} · {commit}
        </Line>
        {output}
        {run.status === "succeeded" && (
          <Line tone="success" className="mt-3">
            ✓ Succeeded{duration === null ? "" : ` in ${duration}`}
          </Line>
        )}
        {run.status === "failed" && (
          <Line tone="error" className="mt-3">
            ✗ Failed
            {run.errorCode === null
              ? ""
              : `: ${errorLabels[run.errorCode]} (${run.errorCode})`}
          </Line>
        )}
        {!finished && (
          <Line className="mt-3">
            <span
              aria-hidden="true"
              className="inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em] animate-pulse bg-(--wb-foreground)"
            />
          </Line>
        )}
      </div>
    </section>
  );
}

type Tone = "plain" | "muted" | "warning" | "error" | "success";

/** How a line of a log reads: an error or a warning, by its words. */
function toneOf(line: string): Tone {
  if (/\b(error|errors|failed|failure|stopped|fatal)\b/i.test(line))
    return "error";
  if (/\b(warn|warning|skipped|retrying)\b/i.test(line)) return "warning";
  return "plain";
}

const TONES: Record<Tone, string> = {
  plain: "text-(--wb-code)",
  muted: "text-(--wb-muted)",
  warning: "text-[#cca700]",
  error: "text-[#f48771]",
  success: "text-[#73c991]",
};

/** One line of output, wrapped rather than scrolled, as a terminal does. */
function Line({
  tone = "plain",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-h-[1.6em] break-words whitespace-pre-wrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** An action printed in the output, as a terminal's links are. */
function InlineAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[#4daafc] underline underline-offset-2 hover:text-[#7cc0ff] focus-visible:outline-1 focus-visible:outline-(--wb-accent)"
    >
      {children}
    </button>
  );
}
