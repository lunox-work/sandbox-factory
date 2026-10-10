/**
 * The scenarios, read from the price they make: inside "Why this price",
 * each factor the spec scores opens onto the scenarios behind it.
 *
 * Three depths, each a step further in. A factor previews what it counted
 * when the pointer rests on it; clicked, it unfolds the scenarios it
 * counted, in place; a scenario clicked opens on its own, with its steps
 * and what it adds to the price, and the rest a step either side. The open
 * questions and the assumptions open as a dialog, where the questions can
 * be answered.
 *
 * A previewing card is a pointer's convenience only: everything it shows is
 * also behind the click on the same row.
 */

import type { BountySpecDto } from "@sandbox-factory/shared";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Lightbulb,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import {
  checksOf,
  RUBRIC_POINTS,
  SCENARIO_KIND_DEFINITIONS,
  SCENARIO_WEIGHT_DEFINITIONS,
  type Scenario,
  type ScenarioWeight,
} from "sandbox-factory";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { plural } from "./lib/format";
import {
  DIFF_TONE,
  KIND_TONE,
  ORIGIN_LABEL,
  pointsFor,
  Steps,
  WeightBadge,
  type ShownSpec,
  type SpecChanges,
  type SpecDiff,
  type WeightPoints,
} from "./ProposalSpec";
import { AnswerForm } from "./SpecChanges";

/** The spec the rubric scored, for its factors to open onto. */
export interface RubricScenarios {
  readonly shown: ShownSpec;
  /** The ways to change the spec; absent for a reader who may not. */
  readonly changes?: SpecChanges | undefined;
}

const KIND_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  SCENARIO_KIND_DEFINITIONS.map(({ id, label }) => [id, label]),
);

const WEIGHT: Readonly<
  Record<string, (typeof SCENARIO_WEIGHT_DEFINITIONS)[number]>
> = Object.fromEntries(
  SCENARIO_WEIGHT_DEFINITIONS.map((each) => [each.id, each]),
);

/**
 * One scenario as the rubric reads it: one of the revision's own, or one
 * the diff on show adds or takes away.
 */
export interface Entry {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly weight: ScenarioWeight | undefined;
  readonly weightReason: string | undefined;
  readonly origin: Scenario["origin"] | undefined;
  /** Its steps; undefined for one trimmed since sizing, which keeps none. */
  readonly steps: Scenario["steps"] | undefined;
  readonly change: "added" | "removed" | undefined;
  /** Whether it counts in this revision's score. */
  readonly scored: boolean;
}

/**
 * Every scenario on show, in the order the spec groups them: by kind, each
 * kind's own first, then what the diff adds to it and what it took out.
 */
export function entriesOf(
  spec: BountySpecDto,
  diff: SpecDiff | undefined,
): Entry[] {
  return SCENARIO_KIND_DEFINITIONS.flatMap(({ id: kind }) => [
    ...spec.draft.scenarios
      .filter((scenario) => scenario.kind === kind)
      .map((scenario): Entry => ({
        id: scenario.id,
        kind,
        title: scenario.title,
        weight: scenario.weight,
        weightReason: scenario.weightReason,
        origin: scenario.origin,
        steps: scenario.steps,
        change: diff?.added.has(scenario.id)
          ? "added"
          : diff?.removed.has(scenario.id)
            ? "removed"
            : undefined,
        scored: true,
      })),
    ...(diff?.gained ?? [])
      .filter((scenario) => scenario.kind === kind)
      .map((scenario): Entry => ({
        id: scenario.id,
        kind,
        title: scenario.title,
        weight: scenario.weight,
        weightReason: scenario.weightReason,
        origin: scenario.origin,
        steps: scenario.steps,
        change: "added",
        scored: false,
      })),
    ...(diff?.lost ?? [])
      .filter((scenario) => scenario.kind === kind)
      .map((scenario): Entry => ({
        id: scenario.id,
        kind,
        title: scenario.title,
        weight: scenario.weight,
        weightReason: undefined,
        origin: undefined,
        steps: undefined,
        change: "removed",
        scored: false,
      })),
  ]);
}

/** Whether the rubric counted it as moderate, having no weight it knows. */
function unweighed(entry: Entry, weightPoints: WeightPoints): boolean {
  return (
    entry.weight === undefined ||
    pointsFor(entry.weight, weightPoints) === undefined
  );
}

/** The outcomes it checks; none known for one that kept no steps. */
const checksIn = ({ steps }: Entry) =>
  steps === undefined ? 0 : checksOf({ steps });

const extraChecks = (entry: Entry) => Math.max(0, checksIn(entry) - 1);

/** The factors a scenario list opens from, by the rubric's factor id. */
export function entriesFor(
  factorId: string,
  entries: readonly Entry[],
  weightPoints: WeightPoints,
): Entry[] | null {
  if (factorId.startsWith("weight-")) {
    const weight = factorId.slice("weight-".length);
    // The ones the factor counts, as its preview does: "2 × 4" unfolds two.
    return entries.filter((entry) => entry.scored && entry.weight === weight);
  }
  if (factorId === "unweighed")
    return entries.filter(
      (entry) => entry.scored && unweighed(entry, weightPoints),
    );
  if (factorId === "test-cases") return [...entries];
  if (factorId === "extra-checks")
    return entries.filter((entry) => extraChecks(entry) > 0);
  return null;
}

/** What a scenario adds to the price, line by line. */
export function contributionOf(
  entry: Entry,
  weightPoints: WeightPoints,
): { label: string; points: number }[] {
  const weight =
    entry.weight === undefined
      ? undefined
      : pointsFor(entry.weight, weightPoints);
  const extra = extraChecks(entry);
  return [
    weight === undefined || entry.weight === undefined
      ? {
          label: "Unweighed, counted as moderate",
          points: weightPoints.moderate,
        }
      : {
          label: `${WEIGHT[entry.weight]?.label ?? entry.weight} scenario`,
          points: weight,
        },
    { label: "Its acceptance test", points: RUBRIC_POINTS.testCase },
    ...(extra > 0
      ? [
          {
            label: `${plural(extra, "check")} past the first`,
            points: extra * RUBRIC_POINTS.extraCheck,
          },
        ]
      : []),
  ];
}

/** A scenario's kind, as a dot in its colour. */
export function KindDot({ kind }: { kind: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        KIND_TONE[kind] ?? "bg-muted-foreground/50",
      )}
    />
  );
}

/** What a row says at its right edge in the list a factor opens. */
function noteFor(factorId: string, entry: Entry): string | undefined {
  if (factorId === "test-cases" && entry.steps !== undefined)
    return plural(checksIn(entry), "check");
  if (factorId === "extra-checks") return `+${extraChecks(entry)}`;
  return undefined;
}

/**
 * Unfolds in place, its height growing from nothing, and folds away the
 * same way; mounted only while it shows, or is folding away.
 */
export function Reveal({
  open,
  id,
  children,
}: {
  open: boolean;
  id?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <div
      id={id}
      inert={!open}
      aria-hidden={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">{mounted && children}</div>
    </div>
  );
}

/**
 * The scenarios a factor counted, unfolded under it: a row each, which
 * opens that scenario. Each row arrives a beat after the one above it.
 */
export function FactorScenarios({
  factorId,
  entries,
  onOpen,
}: {
  factorId: string;
  entries: readonly Entry[];
  onOpen: (id: string) => void;
}) {
  if (entries.length === 0)
    return (
      <p className="text-muted-foreground py-1.5 pl-2 text-xs">
        No scenario carries this weight.
      </p>
    );
  return (
    <ul
      className="border-border/70 my-1 ml-1 flex flex-col border-l py-0.5 pl-2"
      data-testid={`rubric-drill-${factorId}`}
    >
      {entries.map((entry, index) => {
        const note = noteFor(factorId, entry);
        return (
          <li
            key={`${entry.change ?? ""}${entry.id}`}
            className="animate-in fade-in-0 slide-in-from-top-1 fill-mode-both duration-200 motion-reduce:animate-none"
            style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
          >
            <button
              type="button"
              onClick={() => onOpen(entry.id)}
              className={cn(
                "group/entry hover:bg-muted/60 focus-visible:ring-ring/50 relative flex w-full cursor-pointer items-baseline gap-2 rounded-md py-1 pr-2 pl-5 text-left text-xs transition-colors outline-none focus-visible:ring-[3px]",
                entry.change !== undefined && DIFF_TONE[entry.change],
              )}
            >
              {entry.change !== undefined && (
                <span className="absolute top-1 left-0.5 flex h-lh w-3 items-center justify-center font-mono select-none">
                  {entry.change === "added" ? "+" : "−"}
                </span>
              )}
              <span className="flex h-lh items-center">
                <KindDot kind={entry.kind} />
              </span>
              <span className="min-w-0 flex-1">
                {entry.change !== undefined && (
                  <span className="sr-only">
                    {entry.change === "added" ? "Added" : "Removed"}:{" "}
                  </span>
                )}
                {entry.title}
              </span>
              {note !== undefined && (
                <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                  {note}
                </span>
              )}
              <ChevronRight
                aria-hidden="true"
                className="text-muted-foreground size-3 shrink-0 self-center opacity-0 transition-[opacity,translate] group-hover/entry:translate-x-0.5 group-hover/entry:opacity-100 group-focus-visible/entry:opacity-100 motion-reduce:transition-none"
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** At most this many scenarios are named in a preview. */
const PREVIEW_ROWS = 5;

/** A preview's titles, each after its kind's dot, and how many more. */
function PreviewTitles({
  entries,
  note,
}: {
  entries: readonly Entry[];
  note?: (entry: Entry) => string | undefined;
}) {
  const more = entries.length - PREVIEW_ROWS;
  return (
    <ul className="flex flex-col gap-1">
      {entries.slice(0, PREVIEW_ROWS).map((entry) => (
        <li
          key={`${entry.change ?? ""}${entry.id}`}
          className={cn(
            "flex items-baseline gap-2",
            entry.change === "removed" && "text-muted-foreground line-through",
          )}
        >
          <span className="flex h-lh items-center">
            <KindDot kind={entry.kind} />
          </span>
          <span className="min-w-0 flex-1 truncate">{entry.title}</span>
          {note?.(entry) !== undefined && (
            <span className="text-muted-foreground font-mono tabular-nums">
              {note(entry)}
            </span>
          )}
        </li>
      ))}
      {more > 0 && (
        <li className="text-muted-foreground pl-3.5">and {more} more</li>
      )}
    </ul>
  );
}

/** What a preview says it opens. */
function PreviewHint({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground mt-2.5 border-t pt-2 text-2xs">
      {children}
    </p>
  );
}

/**
 * What a scenario factor counted, for the card that previews it: the rule,
 * then the scenarios it was applied to.
 */
export function FactorPreview({
  factorId,
  entries,
  questions,
}: {
  factorId: string;
  /** The factor's own scenarios, as `entriesFor` picks them. */
  entries: readonly Entry[] | null;
  questions: readonly string[];
}) {
  if (factorId === "open-questions") {
    return (
      <>
        <p className="mb-2 font-medium">
          {questions.length === 0
            ? "The bounty left nothing open."
            : "What the contributor would have to guess"}
        </p>
        {questions.length > 0 && (
          <ol className="marker:text-muted-foreground flex list-decimal flex-col gap-1 pl-4">
            {questions.slice(0, 3).map((question, index) => (
              <li key={index} className="line-clamp-2">
                {question}
              </li>
            ))}
          </ol>
        )}
        {questions.length > 3 && (
          <p className="text-muted-foreground mt-1 pl-4">
            and {questions.length - 3} more
          </p>
        )}
        {questions.length > 0 && <PreviewHint>Click to read them</PreviewHint>}
      </>
    );
  }
  if (entries === null) return null;
  if (factorId === "test-cases") {
    // The tests by kind, as one bar: what has to be proven, at a glance.
    const kinds = SCENARIO_KIND_DEFINITIONS.flatMap(({ id, label }) => {
      const count = entries.filter(
        (entry) => entry.scored && entry.kind === id,
      ).length;
      return count === 0 ? [] : [{ id, label, count }];
    });
    return (
      <>
        <p className="mb-2 font-medium">One acceptance test per scenario</p>
        <div className="bg-muted mb-2 flex h-1.5 gap-px overflow-hidden rounded-full">
          {kinds.map(({ id, count }) => (
            <span
              key={id}
              className={cn("h-full", KIND_TONE[id] ?? "bg-muted-foreground")}
              style={{ flexGrow: count }}
            />
          ))}
        </div>
        <ul className="flex flex-col gap-0.5">
          {kinds.map(({ id, label, count }) => (
            <li key={id} className="flex items-center gap-2">
              <KindDot kind={id} />
              <span className="flex-1">{label}</span>
              <span className="tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
        <PreviewHint>Click to list every test</PreviewHint>
      </>
    );
  }
  if (factorId === "extra-checks") {
    const ranked = [...entries].sort((a, b) => extraChecks(b) - extraChecks(a));
    return (
      <>
        <p className="mb-2 font-medium">
          {entries.length === 0
            ? "Every test checks one outcome."
            : "Tests that check more than one outcome"}
        </p>
        {entries.length > 0 && (
          <>
            <PreviewTitles
              entries={ranked}
              note={(entry) => `+${extraChecks(entry)}`}
            />
            <PreviewHint>Click to list them</PreviewHint>
          </>
        )}
      </>
    );
  }
  const weight = WEIGHT[factorId.slice("weight-".length)];
  return (
    <>
      <p className="mb-0.5 font-medium">
        {factorId === "unweighed"
          ? "Drafted before scenarios carried weights"
          : `${weight?.label ?? "Weighed"} scenarios`}
      </p>
      <p className="text-muted-foreground mb-2">
        {factorId === "unweighed"
          ? "Each counts as moderate: a scenario is never free."
          : weight === undefined
            ? null
            : `${weight.covers.charAt(0).toUpperCase()}${weight.covers.slice(1)}.`}
      </p>
      {entries.length === 0 ? (
        <p className="text-muted-foreground">None in this spec.</p>
      ) : (
        <>
          <PreviewTitles entries={entries} />
          <PreviewHint>Click to list them</PreviewHint>
        </>
      )}
    </>
  );
}

/**
 * The dialog's way out, in its own header row rather than over it, so it
 * sits level with whatever that row holds.
 */
function CloseButton({ className }: { className?: string }) {
  return (
    <DialogClose
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 grid size-8 shrink-0 cursor-pointer place-items-center rounded-md transition-colors outline-none focus-visible:ring-[3px]",
        className,
      )}
    >
      <X className="size-4" />
      <span className="sr-only">Close</span>
    </DialogClose>
  );
}

/** Where the scenario dialog is: the whole list, or one scenario. */
export type ScenarioTarget = { readonly at: string | null };

/**
 * The spec as a dialog: every scenario by kind, or one of them with its
 * steps and what it adds to the price, a step from the ones either side.
 * Moving between them slides the way the move went.
 */
export function ScenarioDialog({
  target,
  onTarget,
  entries,
  spec,
  weightPoints,
  scoredPoints,
  changes,
}: {
  /** Null while closed. */
  target: ScenarioTarget | null;
  onTarget: (target: ScenarioTarget | null) => void;
  entries: readonly Entry[];
  spec: BountySpecDto;
  weightPoints: WeightPoints;
  /** What the scenarios and their tests add up to, in this revision. */
  scoredPoints: number;
  changes: SpecChanges | undefined;
}) {
  // Which way the last move went, for the slide it arrives with.
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const at = target?.at ?? null;
  const index = at === null ? -1 : entries.findIndex(({ id }) => id === at);
  const entry = entries[index];
  const go = (next: string | null, way: "forward" | "back") => {
    setDirection(way);
    onTarget({ at: next });
  };
  const step = (by: 1 | -1) => {
    const next = entries[(index + by + entries.length) % entries.length];
    if (next !== undefined) go(next.id, by === 1 ? "forward" : "back");
  };
  const working = changes?.control.state.phase === "working";

  let body: ReactNode;
  if (entry === undefined) {
    body = (
      <ScenarioIndex
        entries={entries}
        spec={spec}
        weightPoints={weightPoints}
        scoredPoints={scoredPoints}
        onOpen={(id) => go(id, "forward")}
      />
    );
  } else {
    body = (
      <ScenarioDetail
        entry={entry}
        position={{ index, of: entries.length }}
        background={spec.draft.background}
        weightPoints={weightPoints}
        onBack={() => go(null, "back")}
        onStep={entries.length > 1 ? step : undefined}
        {...(changes !== undefined && entry.scored
          ? {
              removing: working,
              onRemove: () => {
                onTarget(null);
                changes.control.request(
                  { mode: "trim", removeScenarioIds: [entry.id] },
                  `Removing “${entry.title}”…`,
                );
              },
            }
          : {})}
      />
    );
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onTarget(null);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(42rem,calc(100dvh-4rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl sm:p-0"
        data-testid="scenario-dialog"
        onKeyDown={(event) => {
          if (entry === undefined || entries.length < 2) return;
          // Not while typing, nor from a control that reads the arrows, nor
          // from a dialog opened over it: its keys bubble here through the
          // portal, and switching scenario would unmount the dialog.
          if (
            !(event.target instanceof Node) ||
            !event.currentTarget.contains(event.target) ||
            (event.target instanceof HTMLElement &&
              event.target.closest("input,textarea,[role=menu]") !== null)
          )
            return;
          if (event.key === "ArrowRight") step(1);
          else if (event.key === "ArrowLeft") step(-1);
        }}
      >
        {/* Keyed by where it is, so each arrives with its own slide. */}
        <div
          key={at ?? ""}
          className={cn(
            "animate-in fade-in-0 flex min-h-0 flex-1 flex-col duration-200 ease-out motion-reduce:animate-none",
            direction === "forward"
              ? "slide-in-from-right-6"
              : "slide-in-from-left-6",
          )}
        >
          {body}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's opening view: every scenario, by kind, each opening itself. */
function ScenarioIndex({
  entries,
  spec,
  weightPoints,
  scoredPoints,
  onOpen,
}: {
  entries: readonly Entry[];
  spec: BountySpecDto;
  weightPoints: WeightPoints;
  scoredPoints: number;
  onOpen: (id: string) => void;
}) {
  const scored = entries.filter(({ scored }) => scored).length;
  const groups = SCENARIO_KIND_DEFINITIONS.flatMap(({ id, label }) => {
    const rows = entries.filter(({ kind }) => kind === id);
    return rows.length === 0 ? [] : [{ id, label, rows }];
  });
  return (
    <>
      <div className="flex items-start gap-3 border-b py-4 pr-3 pl-5 sm:pl-6">
        <div className="min-w-0 flex-1 pt-1">
          <DialogTitle className="text-base leading-snug">
            {spec.draft.feature}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs tabular-nums">
            {plural(scored, "scenario")} · {plural(scoredPoints, "point")} from
            scenarios and their tests · revision {spec.revision}
          </DialogDescription>
        </div>
        <CloseButton />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {spec.draft.background.length > 0 && (
          <details className="group border-b px-5 py-3 sm:px-6">
            <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium transition-colors [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
              What every scenario starts from
            </summary>
            <div className="mt-2.5">
              <Steps
                steps={spec.draft.background.map((text, index) => ({
                  keyword: index === 0 ? "Given" : "And",
                  text,
                }))}
              />
            </div>
          </details>
        )}
        {groups.map((group) => (
          <section key={group.id} aria-label={group.label}>
            <h3 className="eyebrow bg-muted/30 flex items-center gap-2 px-5 py-1.5 sm:px-6">
              <KindDot kind={group.id} />
              {group.label}
              <span className="ml-auto font-normal tracking-normal tabular-nums">
                {group.rows.length}
              </span>
            </h3>
            <ul>
              {group.rows.map((entry) => (
                <li key={`${entry.change ?? ""}${entry.id}`}>
                  <button
                    type="button"
                    onClick={() => onOpen(entry.id)}
                    className={cn(
                      "group/row hover:bg-muted/50 focus-visible:ring-ring/50 relative flex w-full cursor-pointer items-start gap-2 px-5 py-2 text-left text-sm leading-relaxed transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-inset sm:px-6",
                      entry.change !== undefined && DIFF_TONE[entry.change],
                    )}
                  >
                    {entry.change !== undefined && (
                      <span className="absolute top-2 left-1.5 flex h-lh w-3 items-center justify-center font-mono select-none sm:left-2.5">
                        {entry.change === "added" ? "+" : "−"}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      {entry.change !== undefined && (
                        <span className="sr-only">
                          {entry.change === "added" ? "Added" : "Removed"}:{" "}
                        </span>
                      )}
                      {entry.title}
                    </span>
                    {entry.weight !== undefined && (
                      <span className="flex h-lh items-center">
                        <WeightBadge
                          weight={entry.weight}
                          points={pointsFor(entry.weight, weightPoints)}
                        />
                      </span>
                    )}
                    <span className="flex h-lh items-center">
                      <ChevronRight
                        aria-hidden="true"
                        className="text-muted-foreground size-3.5 transition-transform group-hover/row:translate-x-0.5 motion-reduce:transition-none"
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

/** One scenario: its steps, and the points it brings to the price. */
function ScenarioDetail({
  entry,
  position,
  background,
  weightPoints,
  onBack,
  onStep,
  removing = false,
  onRemove,
}: {
  entry: Entry;
  position: { index: number; of: number };
  background: readonly string[];
  weightPoints: WeightPoints;
  onBack: () => void;
  /** Steps to the scenario either side; absent when there is no other. */
  onStep: ((by: 1 | -1) => void) | undefined;
  removing?: boolean;
  onRemove?: () => void;
}) {
  const lines = contributionOf(entry, weightPoints);
  const adds = lines.reduce((sum, { points }) => sum + points, 0);
  const nav =
    "text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 grid size-7 cursor-pointer place-items-center rounded-md transition-colors outline-none focus-visible:ring-[3px]";
  return (
    <>
      <div className="flex items-center gap-1 border-b py-2 pr-3 pl-3 sm:pl-4">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px]"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          All scenarios
        </button>
        {onStep !== undefined && (
          <span className="ml-auto flex items-center gap-0.5">
            <span className="text-muted-foreground mr-1.5 text-xs tabular-nums">
              {position.index + 1} of {position.of}
            </span>
            <button
              type="button"
              aria-label="Previous scenario"
              className={nav}
              onClick={() => onStep(-1)}
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Next scenario"
              className={nav}
              onClick={() => onStep(1)}
            >
              <ChevronRight className="size-4" />
            </button>
          </span>
        )}
        <span
          aria-hidden="true"
          className={cn(
            "bg-border mx-1.5 h-4 w-px",
            onStep === undefined && "ml-auto",
          )}
        />
        <CloseButton />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5 sm:px-6">
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5">
            <KindDot kind={entry.kind} />
            {KIND_LABEL[entry.kind] ?? entry.kind}
          </span>
          {entry.origin !== undefined && entry.origin !== "draft" && (
            <Badge
              variant="outline"
              className="border-primary/25 bg-primary/10 text-primary rounded-full px-2"
            >
              {ORIGIN_LABEL[entry.origin]}
            </Badge>
          )}
          {entry.change !== undefined && (
            <span
              className={cn(
                "rounded-full px-2 font-medium",
                DIFF_TONE[entry.change],
              )}
            >
              {entry.change === "added"
                ? entry.scored
                  ? "Added since sizing"
                  : "Added in the next revision"
                : entry.scored
                  ? "Removed in the next revision"
                  : "Removed since sizing"}
            </span>
          )}
        </p>
        <DialogTitle className="mt-1.5 text-base leading-snug">
          {entry.title}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {KIND_LABEL[entry.kind] ?? entry.kind} scenario, {position.index + 1}{" "}
          of {position.of}
        </DialogDescription>

        {entry.weight !== undefined && (
          <div className="mt-3 flex flex-col items-start gap-1.5">
            <WeightBadge
              weight={entry.weight}
              points={pointsFor(entry.weight, weightPoints)}
            />
            {entry.weightReason !== undefined && (
              <p className="text-muted-foreground text-xs leading-relaxed">
                {entry.weightReason}
              </p>
            )}
          </div>
        )}

        {/* What it brings to the price, as the rubric's own lines. */}
        <div
          className="bg-muted/30 mt-4 rounded-lg border px-3 py-2.5 text-xs"
          data-testid="scenario-adds"
        >
          {entry.scored ? (
            <>
              <ul className="flex flex-col gap-1">
                {lines.map(({ label, points }) => (
                  <li key={label} className="flex justify-between gap-4">
                    <span>{label}</span>
                    <span className="font-mono tabular-nums">+{points}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 flex justify-between gap-4 border-t pt-1.5 font-semibold">
                <span>Adds to the price</span>
                <span className="tabular-nums">{plural(adds, "point")}</span>
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">
              Not in this revision&rsquo;s score.
              {entry.steps === undefined &&
                " Only its title and weight were kept."}
            </p>
          )}
        </div>

        {background.length > 0 && entry.steps !== undefined && (
          <details className="group mt-4 text-xs">
            <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 font-medium transition-colors [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
              Starts from the background ({plural(background.length, "step")})
            </summary>
            <div className="mt-2 opacity-80">
              <Steps
                steps={background.map((text, index) => ({
                  keyword: index === 0 ? "Given" : "And",
                  text,
                }))}
              />
            </div>
          </details>
        )}

        {entry.steps !== undefined && (
          <div className="bg-background/60 mt-3 rounded-lg border px-3 py-2.5">
            <Steps steps={entry.steps} />
          </div>
        )}

        {onRemove !== undefined && (
          <div className="mt-5 flex justify-end">
            <ConfirmDialog
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={removing}
                  className="text-muted-foreground"
                >
                  Remove scenario
                </Button>
              }
              title="Remove this scenario?"
              description={
                <>
                  “{entry.title}” is taken out of the spec as a new revision.
                  Points added since sizing come off the size; a scenario from
                  the first draft never takes it below the model&rsquo;s size.
                </>
              }
              confirmLabel="Remove scenario"
              busy={removing}
              onConfirm={onRemove}
            />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The open questions or the assumptions, as a dialog, numbered. The
 * questions can be answered from it: the form slides in over the list.
 */
export function NotesDialog({
  open,
  onOpenChange,
  heading,
  description,
  notes,
  icon: Icon,
  tone,
  answer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  heading: string;
  description: string;
  notes: readonly string[];
  icon: LucideIcon;
  /** The icon's colour. */
  tone: string;
  /** Opens on the answers, as the menu's "Answer open questions" does. */
  answer?:
    | {
        readonly first: boolean;
        readonly disabled: boolean;
        readonly onSubmit: (
          answers: { question: string; answer: string }[],
        ) => void;
      }
    | undefined;
}) {
  const [answering, setAnswering] = useState(false);
  // Each opening starts where it was asked to.
  const first = answer?.first ?? false;
  useLayoutEffect(() => {
    if (open) setAnswering(first);
  }, [open, first]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(40rem,calc(100dvh-4rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg sm:p-0"
      >
        <div className="flex items-start gap-2.5 border-b py-4 pr-3 pl-5 sm:pl-6">
          <Icon
            aria-hidden="true"
            className={cn("mt-1.5 size-4 shrink-0", tone)}
          />
          <div className="min-w-0 flex-1 pt-1">
            <DialogTitle className="text-base leading-tight">
              {heading}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              {description}
            </DialogDescription>
          </div>
          <CloseButton />
        </div>
        <div
          key={answering ? "answer" : "read"}
          className={cn(
            "animate-in fade-in-0 min-h-0 flex-1 overflow-y-auto px-5 py-4 duration-200 motion-reduce:animate-none sm:px-6",
            answering ? "slide-in-from-right-6" : "slide-in-from-left-6",
          )}
        >
          {answering && answer !== undefined ? (
            <AnswerForm
              questions={notes}
              disabled={answer.disabled}
              onCancel={() =>
                first ? onOpenChange(false) : setAnswering(false)
              }
              onSubmit={(answers) => {
                onOpenChange(false);
                answer.onSubmit(answers);
              }}
            />
          ) : (
            <>
              <ol className="marker:text-muted-foreground list-decimal space-y-2 pl-5 text-sm leading-relaxed marker:text-xs marker:tabular-nums">
                {notes.map((note, index) => (
                  <li key={index} className="pl-1">
                    {note}
                  </li>
                ))}
              </ol>
              {answer !== undefined && (
                <div className="mt-5 flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    disabled={answer.disabled}
                    onClick={() => setAnswering(true)}
                  >
                    Answer them
                    <ChevronRight />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const QUESTIONS = { icon: CircleHelp, tone: "text-amber-500" } as const;
export const ASSUMPTIONS = { icon: Lightbulb, tone: "text-sky-500" } as const;
