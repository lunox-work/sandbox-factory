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
 * Who set the size is said first, since the rubric only sets it once the
 * code is measured: until then the model's size stands, and after a
 * reviewer's resize the rubric's is offered back.
 */

import type {
  BountyProposalDto,
  RubricAssessmentDto,
} from "@sandbox-factory/shared";
import { Calculator, ChevronRight } from "lucide-react";
import {
  describeRubric,
  priceFor,
  RUBRIC_BANDS,
  RUBRIC_DIMENSIONS,
  rubricBand,
  rubricRules,
  type RubricAssessment,
} from "sandbox-factory";

import { LoadingLine } from "@/components/Message";
import { SectionHeading } from "@/components/ReadSection";
import { Button } from "@/components/ui/button";

import { money } from "./lib/format";

type RubricProposal = Pick<
  BountyProposalDto,
  "rubric" | "sizedBy" | "complexity" | "modelComplexity" | "rateCard"
>;

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
  if (rubric.size === null)
    return rubric.code.status === "pending"
      ? `The model's ${proposal.modelComplexity} stands until the code is measured.`
      : `The model's ${proposal.modelComplexity} stands: the rubric needs the code to size.`;
  const who = proposal.sizedBy === "reviewer" ? "A reviewer" : "The model";
  return rubric.size === proposal.complexity
    ? `${who} set this size, and the rubric agrees.`
    : `${who} set this size; the rubric says ${rubric.size}.`;
}

export function PricingRubricBlock({
  proposal,
  canUse,
  busy,
  onUse,
}: {
  proposal: RubricProposal;
  /** Whether the viewer may put the rubric's size in force. */
  canUse: boolean;
  busy: boolean;
  onUse: () => void;
}) {
  const rubric = proposal.rubric ?? null;
  if (rubric === null) return null;
  const card = proposal.rateCard;
  const offer =
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
                  {rubric.points}
                </span>{" "}
                points
                {rubric.size !== null && (
                  <>
                    {" "}
                    <span aria-hidden>→</span>
                    <span className="sr-only">is</span>{" "}
                    <span className="border-primary/30 bg-primary/10 text-primary rounded-[4px] border px-1.5 py-px font-mono text-xs font-semibold">
                      {rubric.size}
                    </span>
                  </>
                )}
              </p>
              <p
                className="text-muted-foreground text-xs"
                data-testid="rubric-source"
              >
                {sourceLine(proposal, rubric)}
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
          </div>

          <Breakdown rubric={rubric} />

          <p
            className="text-muted-foreground text-sm leading-relaxed"
            data-testid="rubric-rationale"
          >
            {describeRubric(rubric as RubricAssessment)}
          </p>
        </div>

        <div className="divide-y border-t">
          {rubric.dimensions.map((dimension) => (
            <Dimension
              key={dimension.id}
              dimension={dimension}
              rubric={rubric}
            />
          ))}
        </div>
        <div className="bg-muted/30 flex items-baseline justify-between border-t px-4 py-3 text-sm font-semibold sm:px-5">
          <span>Total</span>
          <span className="tabular-nums">{rubric.points}</span>
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
 * where the points came from reads before any line of it is read. Drawn
 * only: the numbers are in the rows under it.
 */
function Breakdown({ rubric }: { rubric: RubricAssessmentDto }) {
  const parts = rubric.dimensions.filter(
    ({ measured, points }) => measured && points > 0,
  );
  if (parts.length === 0) return null;
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      <div className="bg-muted flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {parts.map(({ id, points }) => (
          <span
            key={id}
            className={`h-full ${DIMENSION_TONE[id] ?? "bg-muted-foreground"}`}
            style={{ flexGrow: points }}
          />
        ))}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {parts.map(({ id, label, points }) => (
          <span key={id} className="flex items-center gap-1.5">
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

/*
  Every factor and rule list shares one label column (7rem on a phone, 9.5rem above), so evidence
  starts on the same line in each, however long its own labels are.
*/
function Dimension({
  dimension,
  rubric,
}: {
  dimension: RubricAssessmentDto["dimensions"][number];
  rubric: RubricAssessmentDto;
}) {
  const covers = RUBRIC_DIMENSIONS.find(
    ({ id }) => id === dimension.id,
  )?.covers;
  return (
    <div className="px-4 py-3.5 sm:px-5" data-testid={`rubric-${dimension.id}`}>
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
            <LoadingLine className="mt-2 text-xs">
              {UNMEASURED["pending"]}
            </LoadingLine>
          ) : (
            <p className="text-muted-foreground mt-2 text-xs">
              {UNMEASURED[rubric.code.status] ?? UNMEASURED["unavailable"]}
            </p>
          )
        ) : (
          <dl className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-xs sm:grid-cols-[9.5rem_minmax(0,1fr)_auto]">
            {dimension.factors.map((factor) => (
              <div
                key={factor.id}
                className={`contents ${factor.points === 0 ? "text-muted-foreground" : ""}`}
              >
                <dt>{factor.label}</dt>
                <dd className="text-muted-foreground min-w-0 break-words">
                  {factor.evidence}
                </dd>
                <dd
                  className={`text-right font-mono tabular-nums ${
                    factor.points < 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : ""
                  }`}
                >
                  {factor.points === 0 ? "0" : signed(factor.points)}
                </dd>
              </div>
            ))}
          </dl>
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
 * Every size as a rung: its points and its price on the proposal's card.
 * The rubric's band is marked, and the size in force is filled, so a
 * reviewer sees how far the price sits from the next one.
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
          return (
            <li
              key={size}
              aria-current={inForce ? "true" : undefined}
              className={`flex flex-col items-center gap-0.5 rounded-lg border px-1 py-2 text-center transition-colors ${
                inForce
                  ? "border-primary/60 bg-primary/10 ring-primary/25 ring-2"
                  : scored
                    ? "border-foreground/40 border-dashed"
                    : "text-muted-foreground bg-muted/20"
              }`}
            >
              <span
                className={`font-mono text-xs font-semibold ${
                  inForce ? "text-primary" : ""
                }`}
              >
                {size}
              </span>
              <span className="text-[11px] tabular-nums opacity-80">
                {band.to === null ? `${band.from}+` : `${band.from}–${band.to}`}
              </span>
              <span
                className={`text-[11px] tabular-nums ${
                  inForce ? "text-foreground font-medium" : ""
                }`}
              >
                {money(priceFor(size, card), card.currency)}
              </span>
              {scored && <span className="sr-only">(the rubric's size)</span>}
            </li>
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
