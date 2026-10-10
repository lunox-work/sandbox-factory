/**
 * Why a proposal costs what it does: the pricing rubric's working, in the
 * Price tab under the amount.
 *
 * Three dimensions, each a sum of named factors, each factor showing what was
 * counted and what it scored; the total, and the band it falls in on a
 * ladder of every size with its price on the proposal's own card; and, folded
 * away, every rule the rubric applies and why. A reviewer who disagrees with
 * a price can disagree with one line of it.
 *
 * Given the spec it scored, the block is also where its scenarios are read:
 * each factor the spec scores previews what it counted on hover, unfolds
 * the scenarios behind it on a click, and each of those opens on its own
 * (`RubricScenarios.tsx`). The spec's changes are made from the Scenarios
 * dimension, and an earlier revision on show is scored as it would be.
 *
 * Who set the size is said first, since the rubric only sets it once the
 * code is measured: until then the model's size stands, and after a
 * reviewer's resize the rubric's is offered back.
 */

import type {
  BountyProposalDto,
  RubricAssessmentDto,
  SpecDraftDto,
} from "@sandbox-factory/shared";
import {
  Calculator,
  ChevronRight,
  CornerDownRight,
  RefreshCw,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  assessRubric,
  describeRubric,
  priceFor,
  RUBRIC_BANDS,
  RUBRIC_DIMENSIONS,
  rubricBand,
  rubricRules,
  rubricSize,
  type RubricAssessment,
} from "sandbox-factory";

import { LoadingLine } from "@/components/Message";
import { ThinkingLine } from "@/components/Thinking";
import { SectionHeading } from "@/components/ReadSection";
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { money, plural } from "./lib/format";
import {
  ASSUMPTIONS,
  entriesFor,
  entriesOf,
  FactorPreview,
  FactorScenarios,
  KindDot,
  NotesDialog,
  QUESTIONS,
  Reveal,
  ScenarioDialog,
  type Entry,
  type RubricScenarios,
  type ScenarioTarget,
} from "./RubricScenarios";
import {
  expandLabel,
  ExpandMenu,
  InstructionForm,
  RespecStatus,
} from "./SpecChanges";

export type { RubricScenarios } from "./RubricScenarios";

type RubricProposal = Pick<
  BountyProposalDto,
  "rubric" | "sizedBy" | "complexity" | "modelComplexity" | "rateCard"
>;

type Dimension = RubricAssessmentDto["dimensions"][number];
type Factor = Dimension["factors"][number];

const signed = (points: number) => (points > 0 ? `+${points}` : `${points}`);

/** Why the code has no score yet, by its status. */
const UNMEASURED: Record<string, string> = {
  pending: "Being measured from the repository's code graph.",
  unavailable: "Not measured: the bounty has no repository to measure.",
  failed: "Could not be measured. Re-analyze to try again.",
};

/** Who set the size, and what the rubric says beside it. */
function sourceLine(proposal: RubricProposal, rubric: RubricAssessmentDto) {
  if (proposal.sizedBy === "rubric") return "The rubric set this size.";
  if (rubric.size === null) {
    // "The model's unsized stands" read as a typo: an unsized answer is said
    // as one.
    const model =
      proposal.modelComplexity === "unsized"
        ? "The model left it unsized"
        : `The model's ${proposal.modelComplexity} stands`;
    return rubric.code.status === "pending"
      ? `${model} until the code is measured.`
      : `${model}: the rubric needs the code to size.`;
  }
  const who = proposal.sizedBy === "reviewer" ? "A reviewer" : "The model";
  return rubric.size === proposal.complexity
    ? `${who} set this size, and the rubric agrees.`
    : `${who} set this size; the rubric says ${rubric.size}.`;
}

/**
 * The rubric as an earlier revision of the spec would score: its scenarios
 * and tests scored again, beside the code as it was measured, since only
 * the spec differs between revisions.
 */
function rescore(
  rubric: RubricAssessmentDto,
  draft: SpecDraftDto,
): RubricAssessmentDto {
  const fresh = assessRubric({
    spec: draft,
    code: { status: "pending" },
    weightPoints: rubric.weightPoints,
  });
  const dimensions: RubricAssessmentDto["dimensions"] = [
    ...(fresh.dimensions.filter(
      ({ id }) => id !== "code",
    ) as RubricAssessmentDto["dimensions"]),
    ...rubric.dimensions.filter(({ id }) => id === "code"),
  ];
  const points = dimensions.reduce((sum, { points }) => sum + points, 0);
  const size = rubric.size === null ? null : rubricSize(points);
  const next =
    size === null
      ? undefined
      : RUBRIC_BANDS[RUBRIC_BANDS.findIndex((band) => band.size === size) + 1];
  return {
    ...rubric,
    dimensions,
    points,
    counts: fresh.counts,
    size,
    nextSizeIn: next === undefined ? null : next.from - points,
  };
}

/** Whether the reader asked the page to keep still. */
function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * A number that counts its way to a new value rather than jumping there, so
 * a change in the score is seen happening. The first value is shown as is.
 */
function useCounted(value: number, ms = 450): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    if (reducedMotion()) {
      from.current = value;
      setShown(value);
      return;
    }
    let frame = 0;
    const began = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - began) / ms);
      const eased = 1 - (1 - progress) ** 3;
      const at = Math.round(start + (value - start) * eased);
      from.current = at;
      setShown(at);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return shown;
}

export function PricingRubricBlock({
  proposal,
  canUse,
  busy,
  onUse,
  scenarios,
}: {
  proposal: RubricProposal;
  /** Whether the viewer may put the rubric's size in force. */
  canUse: boolean;
  busy: boolean;
  onUse: () => void;
  /** The spec it scored, for its factors to open onto. */
  scenarios?: RubricScenarios | undefined;
}) {
  const stored = proposal.rubric ?? null;
  const shown = scenarios?.shown;
  const spec = shown?.spec ?? null;
  const earlier =
    shown !== undefined && shown.viewing !== null && spec !== null;
  const rubric =
    stored === null || !earlier ? stored : rescore(stored, spec.draft);
  const total = useCounted(rubric?.points ?? 0);
  // The dimension the bar is pointed at, lit in the rows under it.
  const [lit, setLit] = useState<string | null>(null);
  if (rubric === null) return null;
  const card = proposal.rateCard;
  const offer =
    !earlier &&
    canUse &&
    proposal.sizedBy !== "rubric" &&
    rubric.size !== null &&
    rubric.size !== proposal.complexity;

  return (
    <section data-testid="pricing-rubric" aria-labelledby="pricing-rubric-head">
      <SectionHeading icon={<Calculator />} id="pricing-rubric-head">
        Why this price
      </SectionHeading>
      <div className="bg-card overflow-hidden rounded-xl border">
        {/* The total, set large, and what it is made of, as one bar. */}
        <div className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="flex min-w-0 flex-col gap-1">
              <p
                className="text-muted-foreground flex flex-wrap items-baseline gap-x-1.5 text-sm"
                data-testid="rubric-total"
              >
                <span className="text-foreground text-3xl leading-none font-semibold tracking-tight tabular-nums">
                  {total}
                </span>{" "}
                points
                {rubric.size !== null && (
                  <>
                    {" "}
                    <span aria-hidden>→</span>
                    <span className="sr-only">is</span>{" "}
                    <span
                      key={rubric.size}
                      className="border-primary/30 bg-primary/10 text-primary animate-in fade-in-0 zoom-in-90 rounded-[4px] border px-1.5 py-px font-mono text-xs font-semibold duration-300 motion-reduce:animate-none"
                    >
                      {rubric.size}
                    </span>
                  </>
                )}
              </p>
              <p
                className="text-muted-foreground text-xs"
                data-testid="rubric-source"
              >
                {earlier
                  ? `As revision ${shown.viewing} would score. The price goes with revision ${shown.current}.`
                  : sourceLine(proposal, rubric)}
              </p>
            </div>
            {offer && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onUse}
              >
                Use the rubric's {rubric.size}
              </Button>
            )}
            {earlier && (
              <Button
                size="sm"
                variant="outline"
                data-testid="spec-earlier"
                onClick={() => shown.onView(null)}
              >
                Show current
              </Button>
            )}
          </div>

          <Breakdown rubric={rubric} onPoint={setLit} />

          <p
            className="text-muted-foreground text-sm leading-relaxed"
            data-testid="rubric-rationale"
          >
            {describeRubric(rubric as RubricAssessment)}
          </p>
        </div>

        <div className="divide-y border-t">
          {rubric.dimensions.map((dimension) => (
            <DimensionRow
              key={dimension.id}
              dimension={dimension}
              rubric={rubric}
              lit={lit === dimension.id}
              scenarios={
                scenarios !== undefined &&
                (dimension.id === "scenarios" || dimension.id === "tests")
                  ? scenarios
                  : undefined
              }
            />
          ))}
        </div>
        <div className="bg-muted/30 flex items-baseline justify-between border-t px-4 py-3 text-sm font-semibold sm:px-5">
          <span>Total</span>
          <span className="tabular-nums">{total}</span>
        </div>

        <Ladder rubric={rubric} card={card} current={proposal.complexity} />

        <Rules rubric={rubric} />
      </div>
    </section>
  );
}

/** Each dimension's colour, on the bar and beside its name below it. */
const DIMENSION_TONE: Readonly<Record<string, string>> = {
  scenarios: "bg-sky-400",
  tests: "bg-blue-500",
  code: "bg-violet-400",
};

function DimensionDot({ id }: { id: string }) {
  return (
    <span
      aria-hidden="true"
      className={`size-2 shrink-0 rounded-full ${DIMENSION_TONE[id] ?? "bg-muted-foreground"}`}
    />
  );
}

/**
 * The total as one bar, a segment per dimension as wide as its share, so
 * where the points came from reads before any line of it is read. A
 * segment pointed at names its share and lights its row below; the numbers
 * themselves are in the rows.
 */
function Breakdown({
  rubric,
  onPoint,
}: {
  rubric: RubricAssessmentDto;
  onPoint: (id: string | null) => void;
}) {
  const parts = rubric.dimensions.filter(
    ({ measured, points }) => measured && points > 0,
  );
  if (parts.length === 0) return null;
  const share = (points: number) =>
    `${Math.round((points / Math.max(1, rubric.points)) * 100)}%`;
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      <div className="bg-muted flex h-1.5 gap-0.5 rounded-full">
        {parts.map(({ id, label, points }) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <span
                className={`h-full rounded-full transition-[flex-grow,height,translate] duration-500 ease-out hover:-translate-y-px hover:scale-y-150 motion-reduce:transition-none ${DIMENSION_TONE[id] ?? "bg-muted-foreground"}`}
                style={{ flexGrow: points }}
                onPointerEnter={() => onPoint(id)}
                onPointerLeave={() => onPoint(null)}
              />
            </TooltipTrigger>
            <TooltipContent>
              {label}: {plural(points, "point")}, {share(points)} of the total
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {parts.map(({ id, label, points }) => (
          <span
            key={id}
            className="flex items-center gap-1.5"
            onPointerEnter={() => onPoint(id)}
            onPointerLeave={() => onPoint(null)}
          >
            <DimensionDot id={id} />
            {label}
            <span className="text-foreground font-medium tabular-nums">
              {points}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Every factor row shares one label column (7rem on a phone, 9.5rem above). */
const FACTOR_GRID =
  "grid grid-cols-[7rem_minmax(0,1fr)_auto] gap-x-4 sm:grid-cols-[9.5rem_minmax(0,1fr)_auto]";

/** A factor's cells: what it is, what was counted, and what it scored. */
function FactorCells({
  factor,
  chevron,
}: {
  factor: Factor;
  /** Drawn for a factor that opens; its place is kept on one that does not. */
  chevron?: "closed" | "open" | undefined;
}) {
  return (
    <>
      <span>{factor.label}</span>
      <span className="text-muted-foreground min-w-0 break-words">
        {factor.evidence}
      </span>
      <span className="flex items-center justify-end gap-1.5">
        <span
          className={cn(
            "font-mono tabular-nums",
            factor.points < 0 && "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {factor.points === 0 ? "0" : signed(factor.points)}
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "text-muted-foreground size-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
            chevron === undefined && "invisible",
            chevron === "open" && "rotate-90",
          )}
        />
      </span>
    </>
  );
}

/** What a factor opens: the scenarios under it, or a dialog. */
interface FactorDrill {
  readonly preview: ReactNode;
  readonly opens: "inline" | "dialog";
  readonly open: boolean;
  readonly onClick: () => void;
  readonly panel?: ReactNode;
}

/**
 * One factor of a dimension. One the spec scored previews what it counted
 * while the pointer rests on it, and a click unfolds its scenarios under
 * it, or opens what it counted as a dialog.
 */
function FactorRow({
  factor,
  drill,
}: {
  factor: Factor;
  drill?: FactorDrill | undefined;
}) {
  const panel = useId();
  const [hovering, setHovering] = useState(false);
  const muted = factor.points === 0 && "text-muted-foreground";
  if (drill === undefined)
    return (
      <li className={cn(FACTOR_GRID, "py-1", muted)}>
        <FactorCells factor={factor} />
      </li>
    );
  const inline = drill.opens === "inline";
  return (
    <li data-factor={factor.id}>
      <HoverCard
        // A preview of what is already unfolded says nothing new.
        open={hovering && !drill.open}
        // Not remembered while unfolded, or it would pop up once folded,
        // away from the pointer.
        onOpenChange={(next) => setHovering(!drill.open && next)}
      >
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-expanded={inline ? drill.open : undefined}
            aria-controls={inline ? panel : undefined}
            aria-haspopup={inline ? undefined : "dialog"}
            onClick={() => {
              setHovering(false);
              drill.onClick();
            }}
            className={cn(
              FACTOR_GRID,
              "hover:bg-muted/60 focus-visible:ring-ring/50 -mx-2 w-[calc(100%+1rem)] cursor-pointer rounded-md px-2 py-1 text-left transition-colors outline-none focus-visible:ring-[3px]",
              drill.open && "bg-muted/40",
              muted,
            )}
          >
            <FactorCells
              factor={factor}
              chevron={inline && drill.open ? "open" : "closed"}
            />
          </button>
        </HoverCardTrigger>
        <HoverCardContent side="top">{drill.preview}</HoverCardContent>
      </HoverCard>
      {inline && (
        <Reveal open={drill.open} id={panel}>
          {drill.panel}
        </Reveal>
      )}
    </li>
  );
}

function DimensionRow({
  dimension,
  rubric,
  lit,
  scenarios,
}: {
  dimension: Dimension;
  rubric: RubricAssessmentDto;
  lit: boolean;
  /** For the dimensions the spec scores: the spec, to open onto. */
  scenarios: RubricScenarios | undefined;
}) {
  const covers = RUBRIC_DIMENSIONS.find(
    ({ id }) => id === dimension.id,
  )?.covers;
  return (
    <div
      className={cn(
        "px-4 py-3.5 transition-colors duration-300 sm:px-5",
        lit && "bg-muted/40",
      )}
      data-testid={`rubric-${dimension.id}`}
    >
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <DimensionDot id={dimension.id} />
          {dimension.label}
        </span>
        <span className="font-medium tabular-nums">
          {dimension.measured ? dimension.points : "—"}
        </span>
      </div>
      {/* Everything under the name sits in its column, clear of the dot. */}
      <div className="pl-4">
        {covers !== undefined && (
          <p className="text-muted-foreground text-xs">{covers}</p>
        )}
        {!dimension.measured ? (
          rubric.code.status === "pending" ? (
            <ThinkingLine state="connecting" className="mt-2 text-xs">
              {UNMEASURED["pending"]}
            </ThinkingLine>
          ) : (
            <p className="text-muted-foreground mt-2 text-xs">
              {UNMEASURED[rubric.code.status] ?? UNMEASURED["unavailable"]}
            </p>
          )
        ) : scenarios === undefined ? (
          <ul className="mt-2 text-xs">
            {dimension.factors.map((factor) => (
              <FactorRow key={factor.id} factor={factor} />
            ))}
          </ul>
        ) : (
          <SpecFactors
            dimension={dimension}
            rubric={rubric}
            scenarios={scenarios}
          />
        )}
        {dimension.id === "code" && rubric.code.specRevision !== null && (
          <p className="text-muted-foreground mt-2 text-xs">
            Measured for spec revision {rubric.code.specRevision}.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A dimension the spec scores, its factors opening onto the scenarios
 * behind them. The Scenarios dimension also carries the spec itself: what
 * it is about, the way into every scenario, and the ways to change it.
 */
function SpecFactors({
  dimension,
  rubric,
  scenarios,
}: {
  dimension: Dimension;
  rubric: RubricAssessmentDto;
  scenarios: RubricScenarios;
}) {
  const { shown, changes } = scenarios;
  const spec = shown.spec;
  const weightPoints = rubric.weightPoints;
  // The factor unfolded under its row; one at a time, as an accordion.
  const [unfolded, setUnfolded] = useState<string | null>(null);
  const [target, setTarget] = useState<ScenarioTarget | null>(null);
  const [notes, setNotes] = useState<
    "questions" | "answer" | "assumptions" | null
  >(null);
  const [form, setForm] = useState(false);
  const entries: Entry[] = spec === null ? [] : entriesOf(spec, shown.diff);
  const working = changes?.control.state.phase === "working";
  const isScenarios = dimension.id === "scenarios";
  const scored = rubric.dimensions
    .filter(({ id }) => id === "scenarios" || id === "tests")
    .reduce((sum, { points }) => sum + points, 0);
  const questions = spec?.draft.openQuestions ?? [];

  const drillOf = (factor: Factor): FactorDrill | undefined => {
    if (spec === null) return undefined;
    if (factor.id === "open-questions")
      return questions.length === 0
        ? undefined
        : {
            preview: (
              <FactorPreview
                factorId={factor.id}
                entries={null}
                questions={questions}
              />
            ),
            opens: "dialog",
            open: notes === "questions" || notes === "answer",
            onClick: () => setNotes("questions"),
          };
    const counted = entriesFor(factor.id, entries, weightPoints);
    if (counted === null || counted.length === 0) return undefined;
    return {
      preview: (
        <FactorPreview
          factorId={factor.id}
          entries={counted}
          questions={questions}
        />
      ),
      opens: "inline",
      open: unfolded === factor.id,
      onClick: () =>
        setUnfolded((current) => (current === factor.id ? null : factor.id)),
      panel: (
        <FactorScenarios
          factorId={factor.id}
          entries={counted}
          onOpen={(id) => setTarget({ at: id })}
        />
      ),
    };
  };

  return (
    <>
      {isScenarios && (
        <SpecHead
          scenarios={scenarios}
          entries={entries}
          onAll={() => setTarget({ at: null })}
          onOpen={(id) => setTarget({ at: id })}
          onAnswer={() => setNotes("answer")}
          form={form}
          onForm={setForm}
        />
      )}
      <ul className="mt-2 text-xs">
        {dimension.factors.map((factor) => (
          <FactorRow key={factor.id} factor={factor} drill={drillOf(factor)} />
        ))}
      </ul>
      {isScenarios && spec !== null && spec.draft.assumptions.length > 0 && (
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setNotes("assumptions")}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 mt-1.5 flex cursor-pointer items-center gap-1.5 rounded-sm text-xs underline-offset-2 transition-colors outline-none hover:underline focus-visible:ring-[3px]"
        >
          <ASSUMPTIONS.icon
            aria-hidden="true"
            className={cn("size-3.5", ASSUMPTIONS.tone)}
          />
          Drafted on {plural(spec.draft.assumptions.length, "assumption")}, not
          scored
        </button>
      )}

      {spec !== null && (
        <ScenarioDialog
          target={target}
          onTarget={setTarget}
          entries={entries}
          spec={spec}
          weightPoints={weightPoints}
          scoredPoints={scored}
          changes={shown.viewing === null ? changes : undefined}
        />
      )}
      {spec !== null && isScenarios && (
        <>
          <NotesDialog
            open={notes === "questions" || notes === "answer"}
            onOpenChange={(open) => {
              if (!open) setNotes(null);
            }}
            heading="Open questions"
            description="What the bounty leaves unsaid: each one is a guess the contributor would make, and scores a point."
            notes={questions}
            {...QUESTIONS}
            answer={
              changes === undefined || shown.viewing !== null
                ? undefined
                : {
                    first: notes === "answer",
                    disabled: working,
                    onSubmit: (answers) =>
                      changes.control.request(
                        { mode: "answer", answers },
                        answers.length === 1
                          ? "Revising the spec for your answer…"
                          : "Revising the spec for your answers…",
                      ),
                  }
            }
          />
          <NotesDialog
            open={notes === "assumptions"}
            onOpenChange={(open) => {
              if (!open) setNotes(null);
            }}
            heading="Assumptions"
            description="What the draft took as given where the bounty was silent. Not scored."
            notes={spec.draft.assumptions}
            {...ASSUMPTIONS}
          />
        </>
      )}
    </>
  );
}

/**
 * The spec at the head of the Scenarios dimension: what it is about, as
 * the way into every scenario; what changed since sizing; and, for a
 * reader who may, the way to add to it.
 */
function SpecHead({
  scenarios,
  entries,
  onAll,
  onOpen,
  onAnswer,
  form,
  onForm,
}: {
  scenarios: RubricScenarios;
  entries: readonly Entry[];
  onAll: () => void;
  onOpen: (id: string) => void;
  onAnswer: () => void;
  /** Whether the instruction form is out. */
  form: boolean;
  onForm: (open: boolean) => void;
}) {
  const { shown } = scenarios;
  // Changed only on the current revision: an earlier one is read-only.
  const changes = shown.viewing === null ? scenarios.changes : undefined;
  const working = changes?.control.state.phase === "working";
  if (shown.read.state === "loading")
    return (
      <LoadingLine className="mt-2 text-xs">Loading scenarios…</LoadingLine>
    );
  if (shown.read.state === "failed")
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span>The scenarios could not be loaded.</span>
        <Button type="button" variant="outline" size="sm" onClick={shown.retry}>
          <RefreshCw />
          Try again
        </Button>
      </div>
    );
  const spec = shown.spec;
  if (spec === null)
    return (
      <p
        className="text-muted-foreground mt-2 text-xs"
        data-testid="spec-empty"
      >
        No scenarios were drafted for this proposal.
      </p>
    );
  const changed = entries.filter(({ change }) => change !== undefined);
  const added = changed.filter(({ change }) => change === "added").length;
  const removed = changed.length - added;
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="proposal-spec">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={onAll}
          className="group/all bg-background hover:border-foreground/25 hover:bg-muted/40 focus-visible:ring-ring/50 flex min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs shadow-xs transition-colors outline-none focus-visible:ring-[3px]"
        >
          <span className="text-foreground min-w-0 truncate font-medium">
            {spec.draft.feature}
          </span>
          <span className="text-muted-foreground shrink-0 tabular-nums">
            {plural(spec.draft.scenarios.length, "scenario")}
          </span>
          <ChevronRight
            aria-hidden="true"
            className="text-muted-foreground size-3.5 shrink-0 transition-transform group-hover/all:translate-x-0.5 motion-reduce:transition-none"
          />
        </button>
        {changed.length > 0 && (
          <HoverCard>
            <HoverCardTrigger asChild>
              <span
                tabIndex={0}
                className="text-muted-foreground flex cursor-default items-center gap-1.5 rounded-sm text-xs tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {added > 0 && (
                  <span className="text-emerald-700 dark:text-emerald-400">
                    +{added}
                  </span>
                )}
                {removed > 0 && (
                  <span className="text-red-700 dark:text-red-400">
                    −{removed}
                  </span>
                )}
                {shown.diff?.when ?? "since sizing"}
              </span>
            </HoverCardTrigger>
            <HoverCardContent side="top">
              <p className="mb-2 font-medium">
                Changed {shown.diff?.when ?? "since sizing"}
              </p>
              <ul className="flex flex-col gap-0.5">
                {changed.map((entry) => (
                  <li key={`${entry.change}${entry.id}`}>
                    <button
                      type="button"
                      onClick={() => onOpen(entry.id)}
                      className={cn(
                        "hover:bg-muted flex w-full cursor-pointer items-baseline gap-2 rounded-sm px-1 py-0.5 text-left",
                        entry.change === "added"
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-red-700 dark:text-red-400",
                      )}
                    >
                      <span className="w-2 font-mono">
                        {entry.change === "added" ? "+" : "−"}
                      </span>
                      <span className="flex h-lh items-center">
                        <KindDot kind={entry.kind} />
                      </span>
                      <span className="min-w-0 flex-1">{entry.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </HoverCardContent>
          </HoverCard>
        )}
        {changes !== undefined && (
          <span className="ml-auto" data-testid="spec-changes">
            <ExpandMenu
              disabled={working}
              canAnswer={spec.draft.openQuestions.length > 0}
              onKind={(kind) =>
                changes.control.request(
                  { mode: "expand", kinds: [kind] },
                  expandLabel(kind),
                )
              }
              onAnswer={onAnswer}
              onInstruction={() => onForm(true)}
            />
          </span>
        )}
      </div>
      {/* What the reviewer asked for, on a revision that came from it. */}
      {spec.origin !== "draft" && spec.instruction !== null && (
        <p
          className="text-muted-foreground flex items-start gap-1.5 text-xs"
          data-testid="spec-instruction"
        >
          <CornerDownRight
            aria-hidden="true"
            className="mt-px size-3.5 shrink-0"
          />
          <span className="min-w-0 whitespace-pre-line">
            {spec.origin === "expand"
              ? `Asked for: ${spec.instruction}`
              : spec.origin === "answer"
                ? `Answered: ${spec.instruction}`
                : spec.instruction}
          </span>
        </p>
      )}
      {changes !== undefined && (
        <>
          <Reveal open={form}>
            <div className="pt-1">
              <InstructionForm
                disabled={working}
                onCancel={() => onForm(false)}
                onSubmit={(instruction) => {
                  onForm(false);
                  changes.control.request(
                    { mode: "expand", instruction },
                    "Writing the scenarios you asked for…",
                  );
                }}
              />
            </div>
          </Reveal>
          <RespecStatus state={changes.control.state} size={changes.size} />
        </>
      )}
    </div>
  );
}

/**
 * Every size as a rung: its points and its price on the proposal's card.
 * The rubric's band is marked, and the size in force is filled, so a
 * reviewer sees how far the price sits from the next one; a rung pointed
 * at says how many points away it is.
 */
function Ladder({
  rubric,
  card,
  current,
}: {
  rubric: RubricAssessmentDto;
  card: BountyProposalDto["rateCard"];
  current: BountyProposalDto["complexity"];
}) {
  return (
    <div className="border-t px-4 py-4 sm:px-5">
      <p className="text-muted-foreground mb-2.5 text-xs font-medium">
        Points to size, on this rate card
      </p>
      <ol
        className="grid grid-cols-3 gap-1.5 sm:grid-cols-9"
        data-testid="rubric-ladder"
      >
        {RUBRIC_BANDS.map(({ size }) => {
          const band = rubricBand(size);
          const inForce = size === current;
          const scored = size === rubric.size;
          const away =
            band.from > rubric.points
              ? `${plural(band.from - rubric.points, "more point")} to reach it`
              : band.to !== null && band.to < rubric.points
                ? `${plural(rubric.points - band.to, "point")} fewer to fall to it`
                : `${plural(rubric.points, "point")} ${rubric.points === 1 ? "falls" : "fall"} here`;
          return (
            <Tooltip key={size}>
              <TooltipTrigger asChild>
                <li
                  tabIndex={0}
                  aria-current={inForce ? "true" : undefined}
                  className={`focus-visible:ring-ring/50 flex flex-col items-center gap-0.5 rounded-lg border px-1 py-2 text-center transition-[color,background-color,border-color,translate] outline-none hover:-translate-y-0.5 focus-visible:ring-[3px] motion-reduce:transition-none ${
                    inForce
                      ? "border-primary/60 bg-primary/10 ring-primary/25 ring-2"
                      : scored
                        ? "border-foreground/40 border-dashed"
                        : "text-muted-foreground bg-muted/20 hover:bg-muted/50"
                  }`}
                >
                  <span
                    className={`font-mono text-xs font-semibold ${
                      inForce ? "text-primary" : ""
                    }`}
                  >
                    {size}
                  </span>
                  <span className="text-2xs tabular-nums opacity-80">
                    {band.to === null
                      ? `${band.from}+`
                      : `${band.from}–${band.to}`}
                  </span>
                  <span
                    className={`text-2xs tabular-nums ${
                      inForce ? "text-foreground font-medium" : ""
                    }`}
                  >
                    {money(priceFor(size, card), card.currency)}
                  </span>
                  {scored && (
                    <span className="sr-only">(the rubric's size)</span>
                  )}
                </li>
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-semibold">{size}</span>
                {inForce ? " · in force" : scored ? " · the rubric's" : ""}
                <br />
                {away}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </ol>
    </div>
  );
}

/** The rubric itself, folded: what each rule counts, scores and why. */
function Rules({ rubric }: { rubric: RubricAssessmentDto }) {
  const rules = rubricRules(rubric.weightPoints);
  return (
    <details
      className="group bg-muted/20 border-t px-4 py-3 text-xs sm:px-5"
      data-testid="rubric-rules"
    >
      <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 font-medium transition-colors [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        How the rubric scores
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {RUBRIC_DIMENSIONS.map(({ id, label }) => (
          <div key={id}>
            <p className="mb-1 font-medium">{label}</p>
            <dl className="grid grid-cols-[7rem_minmax(0,1fr)] sm:grid-cols-[9.5rem_minmax(0,1fr)] gap-x-4 gap-y-1">
              {rules
                .filter(({ dimension }) => dimension === id)
                .map((rule) => (
                  <div key={rule.id} className="contents">
                    <dt>{rule.label}</dt>
                    <dd className="min-w-0">
                      <span className="tabular-nums">{rule.scoring}</span>
                      <span className="text-muted-foreground block">
                        {rule.why}
                      </span>
                    </dd>
                  </div>
                ))}
            </dl>
          </div>
        ))}
        <p className="text-muted-foreground">
          The total sets the size; the rate card sets its price. Until the code
          is measured the rubric has no size, and the model's stands. A
          reviewer's resize overrides both.
        </p>
      </div>
    </details>
  );
}
