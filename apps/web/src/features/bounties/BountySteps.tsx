/**
 * A bounty's page is three steps, in order: its scope, its price (held by
 * its proposal) and its sandbox. Each is versioned, and each is built on a
 * version of the step before it. A step is changed only once the steps
 * before it stand approved; unapproving one does not undo what was built
 * on it, so the scope can change under an approved price, and the price
 * under a published sandbox. A step built on an older version of the one before it
 * than that step is at now is behind, and says so on its tab and at the top
 * of its page, with the way back to the step it is behind.
 */

import type {
  BountyDto,
  BountyStagesDto,
  ScopeVersionDto,
  ContextSourceDto,
} from "@sandbox-factory/shared";
import { ChevronDown, ChevronRight, Lock, TriangleAlert } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import {
  stageDrift,
  stepHeldBy,
  stepHeldReason,
  type StageDrift,
} from "sandbox-factory";

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
  { value: "scope", label: "Scope" },
  { value: "price", label: "Price" },
  { value: "sandbox", label: "Sandbox" },
] as const;
export type Step = (typeof STEPS)[number]["value"];

/**
 * Why a step cannot be changed yet, as its actions and its tab say it, while
 * a step before it is not approved; null when it can be.
 */
export function heldReason(
  step: "price" | "sandbox",
  bounty: Pick<BountyDto, "version" | "approval" | "proposal">,
): string | null {
  const heldBy = stepHeldBy(step, bounty, bounty.proposal);
  return heldBy === null ? null : stepHeldReason(step, heldBy);
}

/** A version as a step's tab and lineage name it. */
const short = (version: number) => `v${version}`;

/** The version a step is at, as its tab shows it; null for none yet. */
function stepVersion(stages: BountyStagesDto, step: Step): string | null {
  if (step === "scope") return short(stages.scope.version);
  if (step === "price")
    return stages.price === null
      ? null
      : stages.price.version === 0
        ? "Pending"
        : short(stages.price.version);
  return stages.sandbox === null ? null : short(stages.sandbox.version);
}

/** What a step behind the one before it is behind, in a sentence. */
function driftText(step: "price" | "sandbox", drift: StageDrift): string {
  const [built, before] =
    step === "price" ? ["Sized from", "scope"] : ["Built on", "price"];
  const from =
    drift.uses === null
      ? `an earlier ${before}`
      : `${before} ${short(drift.uses)}`;
  return `${built} ${from}; the ${before} is now at ${short(drift.current)}.`;
}

/** What a source ahead of its sync means for the scope, in a sentence. */
function aheadText(sources: readonly ContextSourceDto[]): string {
  const names = sources.map((source) =>
    source === "jira" ? "Jira" : "GitHub",
  );
  return `${names.join(" and ")} ${names.length === 1 ? "has" : "have"} moved past ${names.length === 1 ? "its" : "their"} last sync.`;
}

/** What a step made with older context than the scope holds is, in a sentence. */
function contextText(step: "price" | "sandbox"): string {
  return `${step === "price" ? "Sized" : "Generated"} with older context than the scope holds.`;
}

/**
 * The step tabs, numbered and in order, each with the version it is at. An
 * approved version wears Lunox's gradient: a scope or a price
 * approved, a sandbox version published. A step behind the one before it,
 * or behind the scope's context, wears a warning instead, and its
 * tooltip says what it was made with. The scope wears one while a
 * source it syncs from has moved past its last sync.
 */
export function StepTriggers({
  stages,
  approved,
  locks = { price: null, sandbox: null },
  ahead = [],
}: {
  stages: BountyStagesDto;
  /** Which steps stand at an approved version. */
  approved: Readonly<Record<Step, boolean>>;
  /** Why each later step cannot be changed yet; null when it can. */
  locks?: Readonly<Record<"price" | "sandbox", string | null>>;
  /** The sources that have moved past their last sync. */
  ahead?: readonly ContextSourceDto[];
}) {
  const drift = stageDrift(stages);
  const held = stages.scope.context;
  return STEPS.map(({ value, label }, index) => {
    const version = stepVersion(stages, value);
    const versionBehind = value === "scope" ? null : drift[value];
    const contextStale =
      value === "scope" ? false : contextBehind(held, stages[value]?.context);
    const warnings = [
      versionBehind === null
        ? null
        : driftText(value as "price" | "sandbox", versionBehind),
      contextStale ? contextText(value as "price" | "sandbox") : null,
      value === "scope" && ahead.length > 0 ? aheadText(ahead) : null,
    ].filter((text): text is string => text !== null);
    const behind = warnings.length === 0 ? null : warnings.join(" ");
    const locked = value === "scope" ? null : locks[value];
    // What the tab's tooltip says: what it is behind, then what holds it.
    const tip =
      [behind, locked].filter((text) => text !== null).join(" ") || null;
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
          <VersionChip
            version={version}
            behind={behind !== null}
            approved={signed}
          />
        )}
        <TabSign kind="warning" shown={behind !== null} />
        <TabSign kind="lock" shown={locked !== null} />
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
              : value === "scope"
                ? "(source ahead)"
                : "(behind)",
          ]
            .filter((part) => part !== null)
            .join(" ")}
          data-behind={behind === null ? undefined : true}
          data-held={locked === null ? undefined : true}
        >
          {/*
            The tooltip hangs on what the tab holds, never on the tab: its
            trigger writes its own `data-state`, which would hide the tab's
            `active` from the underline and the tab's own styles. It is
            there with or without a tip, so what the tab holds is not
            remade, and its signs and chip can move, as a tip comes or goes.
          */}
          <Tooltip>
            <TooltipTrigger asChild>{content}</TooltipTrigger>
            {tip !== null && <TooltipContent>{tip}</TooltipContent>}
          </Tooltip>
        </TabsTrigger>
      </Fragment>
    );
  });
}

/**
 * Which way something last turned while it was shown: "in" when it came
 * on, such as a version approved, "out" when it went off; none until it
 * turns, so what was already on at arrival is not played again.
 */
function useTurnMotion(on: boolean): "in" | "out" | undefined {
  const [seen, setSeen] = useState(on);
  const [motion, setMotion] = useState<"in" | "out">();
  if (seen !== on) {
    setSeen(on);
    setMotion(on ? "in" : "out");
  }
  return motion;
}

/**
 * A step tab's warning or lock. It is kept in place while not shown, so it
 * comes and goes rather than blinks: the warning grows in with a shake,
 * the lock with its shackle dropping shut, and the lock opens before it
 * goes.
 */
/**
 * The lock and the warning drawn solid, as Lucide's outlines filled: the
 * lock's body, and the triangle with its mark cut out of it in the page's
 * colour.
 */
const LOCK_FILLED = "[&_rect]:fill-current";
const WARNING_FILLED =
  "[&_path:first-child]:fill-current [&_path:not(:first-child)]:stroke-background";

function TabSign({
  kind,
  shown,
}: {
  kind: "warning" | "lock";
  shown: boolean;
}) {
  const motion = useTurnMotion(shown);
  const Icon = kind === "lock" ? Lock : TriangleAlert;
  return (
    <span
      aria-hidden
      className="tab-sign"
      data-kind={kind}
      data-shown={shown ? true : undefined}
      data-motion={motion}
    >
      <Icon
        className={cn(
          "size-3.5 text-amber-600 dark:text-amber-400",
          kind === "lock" ? LOCK_FILLED : WARNING_FILLED,
        )}
      />
    </span>
  );
}

/**
 * A step tab's version, filled with the brand's ramp as the version's tile
 * is once it stands approved, and amber while it is behind.
 */
function VersionChip({
  version,
  behind,
  approved,
}: {
  version: string;
  behind: boolean;
  approved: boolean;
}) {
  const filled = approved && !behind;
  const motion = useTurnMotion(filled);
  return (
    <span
      data-approved={filled ? true : undefined}
      data-motion={motion}
      className={cn(
        "approval-fill relative isolate inline-block overflow-hidden rounded-[4px] px-1.5 py-px font-mono text-2xs leading-4 font-medium",
        behind
          ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
          : filled
            ? "bg-muted text-white shadow-sm shadow-blue-500/20"
            : "bg-muted text-muted-foreground",
      )}
    >
      {version}
    </span>
  );
}

/**
 * At the top of a step's page while a step before it is not approved: why
 * nothing on it can be changed yet, with the way to the step that holds
 * it. Nothing while it can be.
 */
export function StepHeld({
  step,
  bounty,
  onOpen,
}: {
  step: "price" | "sandbox";
  bounty: Pick<BountyDto, "version" | "approval" | "proposal">;
  /** Opens the step that holds it. */
  onOpen: (step: Step) => void;
}) {
  const heldBy = stepHeldBy(step, bounty, bounty.proposal);
  if (heldBy === null) return null;
  return (
    <div
      role="status"
      data-testid={`${step}-held`}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200"
    >
      <Lock
        aria-hidden
        className={cn(
          "size-4 shrink-0 text-amber-600 dark:text-amber-400",
          LOCK_FILLED,
        )}
      />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Locked.</span>{" "}
        {stepHeldReason(step, heldBy)}
      </p>
      <button
        type="button"
        className="focus-visible:ring-ring/50 cursor-pointer rounded-sm text-sm font-medium underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
        onClick={() => onOpen(heldBy)}
      >
        Open {heldBy === "scope" ? "Scope" : "Price"}
      </button>
    </div>
  );
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
  step: "price" | "sandbox";
  stages: BountyStagesDto;
  /** What brings the step up to date, said after the warning. */
  remedy: string;
  /** Opens the step before. */
  onOpen: (step: Step) => void;
}) {
  const drift = stageDrift(stages)[step];
  if (drift === null) return null;
  const before: Step = step === "price" ? "scope" : "price";
  const name = before === "scope" ? "Scope" : "Price";
  const link = (children: ReactNode) => (
    <button
      type="button"
      className="focus-visible:ring-ring/50 cursor-pointer rounded-sm font-medium underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
      onClick={() => onOpen(before)}
    >
      {children}
    </button>
  );
  const built = step === "price" ? "Sized from" : "Built on";
  return (
    <div
      role="status"
      data-testid={`${step}-lineage`}
      className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200"
    >
      <TriangleAlert
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400",
          WARNING_FILLED,
        )}
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
 * A step's version, the one card on its tab: the version's number on a
 * tile, what is known of it, and the decision on it, level with each other;
 * under them, the context it holds or was made with. The rest of the tab
 * reads on the page itself, in ruled sections. The brand's line runs
 * along its top until the version stands approved; then it outlines the
 * whole card, turning round it, and the tile wears it too. Approving draws
 * that outline out of the line, fills the tile and lights the card once
 * the outline closes; unapproving draws it back in, on every step's tab
 * alike. A step with no version yet has a dash
 * on its tile and the way to make one for its decision.
 */
export function StepVersionCard({
  step,
  tile,
  approved = false,
  action,
  error = null,
  context,
  children,
}: {
  step: Step;
  /** The version as its tile names it, such as "v2"; a dash for none. */
  tile: string;
  approved?: boolean;
  /** The decision on it, or the way to make the first. */
  action?: ReactNode;
  error?: string | null;
  /** The context it holds or was made with, across the card's foot. */
  context?: ReactNode;
  /** What is known of the version, beside its tile. */
  children: ReactNode;
}) {
  const motion = useTurnMotion(approved);
  return (
    <section
      aria-label="Version"
      data-testid={`${step}-version-card`}
      data-approved={approved ? true : undefined}
      data-motion={motion}
      className={cn(
        "version-card bg-card relative overflow-hidden rounded-lg border bg-clip-padding",
        approved
          ? "border-transparent shadow-md shadow-blue-500/15"
          : "shadow-xs",
      )}
    >
      <span aria-hidden className="version-ring" />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            data-approved={approved ? true : undefined}
            data-motion={motion}
            className={cn(
              "approval-fill bg-muted relative isolate flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg font-mono text-xs font-semibold",
              approved
                ? "text-white shadow-sm shadow-blue-500/20"
                : "text-muted-foreground",
            )}
          >
            {tile}
          </span>
          {children}
        </div>
        {action}
      </div>
      {error !== null && (
        <p role="alert" className="text-destructive -mt-1 px-4 pb-3 text-xs">
          {error}
        </p>
      )}
      {context !== undefined && context !== null && (
        <div className="bg-muted/40 border-t px-4 py-2.5">{context}</div>
      )}
    </section>
  );
}

/**
 * The line beside a version's tile when there is no version yet: what the
 * step is waiting on, over why, at the height a version's own line has.
 */
export function NoVersion({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <span className="flex min-h-9 min-w-0 flex-col justify-center text-xs">
      <span className="text-subheading">{title}</span>
      {children !== undefined && (
        <span className="text-muted-foreground">{children}</span>
      )}
    </span>
  );
}

/**
 * The scope's version over its text, as a price and a sandbox have
 * theirs: the version, chosen from the others when there are several, and
 * under it when it was written. An earlier one is read, not changed.
 */
export function ScopeVersion({
  versions,
  current,
  viewing,
  approvedAt,
  onView,
}: {
  /** Newest first; empty while they are read. */
  versions: readonly ScopeVersionDto[];
  current: number;
  viewing: number;
  /** When the version being read was approved, while it stands approved. */
  approvedAt: string | null;
  onView: (version: number) => void;
}) {
  const shown = versions.find(({ version }) => version === viewing);
  const name = <span className="text-subheading">Version {viewing}</span>;
  return (
    <span
      className="flex min-h-9 flex-col justify-center text-xs"
      data-testid="scope-version"
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
