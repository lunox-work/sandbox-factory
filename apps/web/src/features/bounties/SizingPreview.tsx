/**
 * A proposal while a run makes it: each part as its model call returns,
 * read from the run's progress, so the page shows the scenarios and the
 * size as they land rather than a placeholder until both have.
 *
 * The size is the one the proposal will take: the rubric's, scored from
 * the scenarios as soon as they land, or the model's while they have not,
 * or where the two are too far apart to take without a reviewer. The price
 * follows from it on the run's own rate card, which is the one the
 * proposal will be priced on. The code's measurement, which can move the
 * size either way, comes once the proposal is written, as it always has.
 */

import type {
  BountyRunDto,
  RubricAssessmentDto,
} from "@sandbox-factory/shared";
import { ListChecks, Sparkles } from "lucide-react";
import {
  assessRubric,
  priceFor,
  rubricNeedsReview,
  type BountyComplexity,
} from "sandbox-factory";

import {
  ModelCard,
  RuledSection,
  SectionHeading,
} from "@/components/ReadSection";
import { ThinkingLine } from "@/components/Thinking";
import { cn } from "@/lib/utils";

import { money, plural } from "../../lib/format";
import { KindDot } from "../../RubricScenarios";
import { SizeCard } from "./SizeCard";

/**
 * How a part comes in as its call returns: rising into the place its
 * skeleton held, so the page fills in rather than snapping.
 */
const LAND =
  "animate-in fade-in slide-in-from-bottom-1 duration-500 ease-out motion-reduce:animate-none";

/** The run being followed, or undefined until its first read lands. */
type Following = BountyRunDto | undefined;

function progressOf(run: Following): NonNullable<BountyRunDto["progress"]> {
  return run?.progress ?? {};
}

/** What the run is doing now, in one line. */
export function previewLine(run: Following): string {
  if (run?.status === "queued")
    return "Waiting for room to start the analysis…";
  const { spec, sizing } = progressOf(run);
  if (spec === undefined && sizing === undefined)
    return "Reading the bounty, drafting its scenarios and sizing it…";
  if (spec === undefined) return "Drafting its scenarios…";
  if (sizing === undefined) return "Sizing the bounty…";
  return "Writing the proposal…";
}

/**
 * The size the proposal will take from what the run has made so far, as
 * the server sizes it: the rubric's from the scenarios once they land,
 * unless the model's is two whole sizes or more from it; else the model's.
 * Null while neither has landed.
 */
export function previewSize(
  run: Following,
  weightPoints?: RubricAssessmentDto["weightPoints"],
): BountyComplexity | null {
  const { spec, sizing } = progressOf(run);
  // A size the model could not give lands as unsized, as the proposal will.
  const model = sizing === undefined ? null : (sizing?.complexity ?? "unsized");
  if (spec === undefined || spec === null) return model;
  const { size } = assessRubric({
    spec,
    code: { status: "pending" },
    ...(weightPoints === undefined ? {} : { weightPoints }),
  });
  if (size === null) return model;
  return model !== null && rubricNeedsReview(model, size) ? model : size;
}

/**
 * The amount and the size, in the place the proposal's own will take: the
 * size's card and its price once the scenarios or the model have sized it,
 * and until then a shape of each. Under them, what the run is doing now.
 * `weightPoints` are the ones the board scores scenarios with, when known.
 */
export function PreviewPrice({
  run,
  weightPoints,
}: {
  run: Following;
  weightPoints?: RubricAssessmentDto["weightPoints"];
}) {
  const complexity = previewSize(run, weightPoints);
  return (
    <div
      className="grid grid-cols-1 items-center gap-x-6 gap-y-2.5 sm:grid-cols-[1fr_auto]"
      data-testid="proposal-reanalyzing"
    >
      {complexity === null || run === undefined ? (
        <>
          <div aria-hidden="true" className="skeleton h-8 w-36 rounded" />
          <div
            aria-hidden="true"
            className="skeleton h-12 w-12 rounded-md sm:col-start-2 sm:row-start-1 sm:justify-self-end"
          />
        </>
      ) : (
        /*
          Keyed by the size, so a size the scenarios change lands again
          rather than its number swapping in place.
        */
        <>
          <span
            key={`amount-${complexity}`}
            className={`${LAND} text-3xl leading-none font-semibold tracking-tight ${
              complexity === "unsized"
                ? "text-muted-foreground"
                : "tabular-nums"
            }`}
            data-testid="preview-amount"
          >
            {money(
              complexity === "unsized"
                ? null
                : priceFor(complexity, run.rateCard),
              run.rateCard.currency,
            )}
          </span>
          <div
            key={`size-${complexity}`}
            className={`${LAND} sm:col-start-2 sm:row-start-1 sm:justify-self-end`}
          >
            <SizeCard size={complexity} current />
          </div>
        </>
      )}
      <ThinkingLine
        state="solving"
        className="sm:col-span-2"
        since={run?.startedAt ?? run?.createdAt}
      >
        {previewLine(run)}
      </ThinkingLine>
    </div>
  );
}

/**
 * Why the model sized it so, once it has. `flat` inside its bounty: a ruled
 * section on the page, as the proposal's own will be, not a card.
 */
export function PreviewReason({
  run,
  flat = false,
}: {
  run: Following;
  flat?: boolean;
}) {
  const { sizing } = progressOf(run);
  const reason =
    sizing === undefined ? (
      <Lines />
    ) : (
      <p className={`${LAND} text-sm leading-relaxed`}>
        {sizing === null
          ? "The model could not size this bounty."
          : sizing.rationale}
      </p>
    );
  if (flat)
    return (
      <RuledSection title="Why this size" data-testid="preview-reason">
        {reason}
      </RuledSection>
    );
  return (
    <div data-testid="preview-reason">
      <SectionHeading icon={<Sparkles />} tone="model">
        Why this size
      </SectionHeading>
      <ModelCard>{reason}</ModelCard>
    </div>
  );
}

/**
 * The scenarios the bounty was drafted into, once they are. `flat` inside
 * its bounty: a ruled section on the page, not a card.
 */
export function PreviewScenarios({
  run,
  flat = false,
}: {
  run: Following;
  flat?: boolean;
}) {
  const { spec } = progressOf(run);
  const count =
    spec == null ? undefined : plural(spec.scenarios.length, "scenario");
  const box = flat ? undefined : "rounded-lg border p-4";
  const body =
    spec === undefined ? (
      <div className={box}>
        <Lines />
      </div>
    ) : spec === null ? (
      <p className={`${LAND} text-muted-foreground text-sm`}>
        The scenarios could not be drafted.
      </p>
    ) : (
      <div className={cn(LAND, box)}>
        <p className="mb-2 text-sm font-medium">{spec.feature}</p>
        <ul className="flex flex-col gap-1.5">
          {spec.scenarios.map((scenario) => (
            <li key={scenario.id} className="flex items-center gap-2 text-sm">
              <KindDot kind={scenario.kind} />
              <span className="min-w-0 break-words">{scenario.title}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  if (flat)
    return (
      <RuledSection
        title="Scenarios"
        aside={
          count === undefined ? undefined : (
            <span className="text-muted-foreground text-xs tabular-nums">
              {count}
            </span>
          )
        }
        data-testid="preview-scenarios"
      >
        {body}
      </RuledSection>
    );
  return (
    <div data-testid="preview-scenarios">
      <SectionHeading icon={<ListChecks />} aside={count}>
        Scenarios
      </SectionHeading>
      {body}
    </div>
  );
}

/** The shape of a paragraph still being written. */
function Lines() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2.5">
      <div className="skeleton h-3 w-full rounded" />
      <div className="skeleton h-3 w-11/12 rounded" />
      <div className="skeleton h-3 w-4/5 rounded" />
    </div>
  );
}
