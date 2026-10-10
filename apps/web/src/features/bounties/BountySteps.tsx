/**
 * A bounty's page is three steps, in order: its overview, the bounty (its
 * proposal) and its sandbox. Each is versioned, and each is built on a
 * version of the step before it. Nothing locks one step to another: the
 * overview can change under an approved proposal, and the proposal under a
 * published sandbox. A step built on an older version of the one before it
 * than that step is at now is behind, and says so on its tab and at the top
 * of its page, with the way back to the step it is behind.
 */

import type {
  BountyStagesDto,
  BountyVersionDto,
  ContextSourceDto,
} from "@sandbox-factory/shared";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { stageDrift, type StageDrift } from "sandbox-factory";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { dateTime } from "../../lib/format";
import { contextBehind } from "./BountyContext";

/** The steps, in the order each is built on the one before. */
export const STEPS = [
  { value: "overview", label: "Overview" },
  { value: "bounty", label: "Bounty" },
  { value: "sandbox", label: "Sandbox" },
] as const;
export type Step = (typeof STEPS)[number]["value"];

/** A version as a step's tab and lineage name it. */
const short = (version: number) => `v${version}`;

/** The version a step is at, as its tab shows it; null for none yet. */
function stepVersion(stages: BountyStagesDto, step: Step): string | null {
  if (step === "overview") return short(stages.overview.version);
  if (step === "bounty")
    return stages.bounty === null
      ? null
      : stages.bounty.version === 0
        ? "Draft"
        : short(stages.bounty.version);
  return stages.sandbox === null ? null : short(stages.sandbox.version);
}

/** What a step behind the one before it is behind, in a sentence. */
function driftText(step: "bounty" | "sandbox", drift: StageDrift): string {
  const [built, before] =
    step === "bounty" ? ["Sized from", "overview"] : ["Built on", "bounty"];
  const from =
    drift.uses === null
      ? `an earlier ${before}`
      : `${before} ${short(drift.uses)}`;
  return `${built} ${from}; the ${before} is now at ${short(drift.current)}.`;
}

/** What a source ahead of its sync means for the overview, in a sentence. */
function aheadText(sources: readonly ContextSourceDto[]): string {
  const names = sources.map((source) =>
    source === "jira" ? "Jira" : "GitHub",
  );
  return `${names.join(" and ")} ${names.length === 1 ? "has" : "have"} moved past ${names.length === 1 ? "its" : "their"} last sync.`;
}

/** What a step made with older context than the overview holds is, in a sentence. */
function contextText(step: "bounty" | "sandbox"): string {
  return `${step === "bounty" ? "Sized" : "Generated"} with older context than the overview holds.`;
}

/**
 * The step tabs, numbered and in order, each with the version it is at. An
 * approved version wears Lunox's gradient: an overview or a bounty
 * approved, a sandbox version published. A step behind the one before it,
 * or behind the overview's context, wears a warning instead, and its
 * tooltip says what it was made with. The overview wears one while a
 * source it syncs from has moved past its last sync.
 */
export function StepTriggers({
  stages,
  approved,
  ahead = [],
}: {
  stages: BountyStagesDto;
  /** Which steps stand at an approved version. */
  approved: Readonly<Record<Step, boolean>>;
  /** The sources that have moved past their last sync. */
  ahead?: readonly ContextSourceDto[];
}) {
  const drift = stageDrift(stages);
  const held = stages.overview.context;
  return STEPS.map(({ value, label }, index) => {
    const version = stepVersion(stages, value);
    const versionBehind = value === "overview" ? null : drift[value];
    const contextStale =
      value === "overview"
        ? false
        : contextBehind(held, stages[value]?.context);
    const warnings = [
      versionBehind === null
        ? null
        : driftText(value as "bounty" | "sandbox", versionBehind),
      contextStale ? contextText(value as "bounty" | "sandbox") : null,
      value === "overview" && ahead.length > 0 ? aheadText(ahead) : null,
    ].filter((text): text is string => text !== null);
    const behind = warnings.length === 0 ? null : warnings.join(" ");
    const signed = approved[value];
    const content = (
      <span className="flex h-full items-center gap-2">
        <span
          aria-hidden
          className="border-border text-muted-foreground group-data-[state=active]/step:border-foreground group-data-[state=active]/step:bg-foreground group-data-[state=active]/step:text-background flex size-5 items-center justify-center rounded-full border text-2xs font-semibold tabular-nums transition-colors"
        >
          {index + 1}
        </span>
        {label}
        {version !== null && (
          <span
            data-approved={signed && behind === null ? true : undefined}
            className={cn(
              "rounded-[4px] px-1.5 py-px font-mono text-2xs leading-4 font-medium",
              behind !== null
                ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
                : signed
                  ? "bg-(image:--brand-gradient) text-white shadow-sm shadow-blue-500/20"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {version}
          </span>
        )}
        {behind !== null && (
          <TriangleAlert
            aria-hidden
            className="size-3.5 text-amber-600 dark:text-amber-400"
          />
        )}
      </span>
    );
    return (
      <Fragment key={value}>
        {index > 0 && (
          <ChevronRight
            aria-hidden
            className="text-muted-foreground/60 size-4 shrink-0 self-center"
          />
        )}
        <TabsTrigger
          value={value}
          className="group/step"
          // Named for the step and its version: the number is drawn, and the
          // warning's words are its tooltip's.
          aria-label={[
            label,
            version,
            behind === null
              ? null
              : value === "overview"
                ? "(source ahead)"
                : "(behind)",
          ]
            .filter((part) => part !== null)
            .join(" ")}
          data-behind={behind === null ? undefined : true}
        >
          {/*
            The tooltip hangs on what the tab holds, never on the tab: its
            trigger writes its own `data-state`, which would hide the tab's
            `active` from the underline and the tab's own styles.
          */}
          {behind === null ? (
            content
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>{content}</TooltipTrigger>
              <TooltipContent>{behind}</TooltipContent>
            </Tooltip>
          )}
        </TabsTrigger>
      </Fragment>
    );
  });
}

/**
 * A warning at the top of a step's page once the step before has moved
 * ahead of what it was built on, with what to do. While it has not, the
 * step's own version line names what it stands on, and this is nothing.
 * The version named opens the step it belongs to.
 */
export function StepLineage({
  step,
  stages,
  remedy,
  onOpen,
}: {
  step: "bounty" | "sandbox";
  stages: BountyStagesDto;
  /** What brings the step up to date, said after the warning. */
  remedy: string;
  /** Opens the step before. */
  onOpen: (step: Step) => void;
}) {
  const drift = stageDrift(stages)[step];
  if (drift === null) return null;
  const before: Step = step === "bounty" ? "overview" : "bounty";
  const name = before === "overview" ? "Overview" : "Bounty";
  const link = (children: ReactNode) => (
    <button
      type="button"
      className="focus-visible:ring-ring/50 cursor-pointer rounded-sm font-medium underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
      onClick={() => onOpen(before)}
    >
      {children}
    </button>
  );
  const built = step === "bounty" ? "Sized from" : "Built on";
  return (
    <div
      role="status"
      data-testid={`${step}-lineage`}
      className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200"
    >
      <TriangleAlert
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <p>
        <span className="font-medium">{name} has moved ahead.</span> {built}{" "}
        {link(
          drift.uses === null
            ? `an earlier ${name.toLowerCase()}`
            : `${name} ${short(drift.uses)}`,
        )}
        ; the {name.toLowerCase()} is now at {short(drift.current)}. {remedy}
      </p>
    </div>
  );
}

/**
 * The overview's version over its text, as a proposal and a sandbox have
 * theirs: the version, chosen from the others when there are several, and
 * under it when it was written. An earlier one is read, not changed.
 */
export function OverviewVersion({
  versions,
  current,
  viewing,
  approvedAt,
  onView,
}: {
  /** Newest first; empty while they are read. */
  versions: readonly BountyVersionDto[];
  current: number;
  viewing: number;
  /** When the version being read was approved, while it stands approved. */
  approvedAt: string | null;
  onView: (version: number) => void;
}) {
  const shown = versions.find(({ version }) => version === viewing);
  const name = <span className="font-semibold">Version {viewing}</span>;
  return (
    <span
      className="flex min-h-9 flex-col justify-center text-xs"
      data-testid="overview-version"
    >
      {versions.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="focus-visible:ring-ring/50 -mx-1 flex w-fit cursor-pointer items-center gap-1 rounded-sm px-1 hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
              aria-label={`Version ${viewing}, choose another`}
            >
              {name}
              <ChevronDown className="text-muted-foreground size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            {versions.map(({ version, createdAt }) => (
              <DropdownMenuItem
                key={version}
                onSelect={() => onView(version)}
                className="justify-between gap-4"
              >
                <span>Version {version}</span>
                <span className="text-muted-foreground text-xs">
                  {version === current ? "Latest" : dateTime(createdAt)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        name
      )}
      <span className="text-muted-foreground flex flex-wrap gap-x-1">
        {approvedAt !== null ? (
          <span>
            Approved <time dateTime={approvedAt}>{dateTime(approvedAt)}</time>
          </span>
        ) : (
          shown !== undefined && (
            <span>
              {shown.version === 1 ? "Written" : "Edited"}{" "}
              <time dateTime={shown.createdAt}>
                {dateTime(shown.createdAt)}
              </time>
            </span>
          )
        )}
        {viewing === current ? (
          <span>
            {shown === undefined && approvedAt === null ? "Latest" : "· Latest"}
          </span>
        ) : (
          <>
            <span>· Read only</span>
            <button
              type="button"
              className="focus-visible:ring-ring/50 text-foreground cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
              onClick={() => onView(current)}
            >
              Back to latest
            </button>
          </>
        )}
      </span>
    </span>
  );
}
