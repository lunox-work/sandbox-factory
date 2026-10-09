/**
 * A proposal while a run makes it: each part as its model call returns,
 * read from the run's progress, so the page shows the scenarios and the
 * size as they land rather than a placeholder until both have.
 *
 * The price follows from the size on the run's own rate card, which is the
 * one the proposal will be priced on. What needs the proposal written, the
 * rubric's score and the code's measurement, comes once it is, as it
 * always has.
 */

import type { BountyRunDto } from "@sandbox-factory/shared";
import { ListChecks, Sparkles } from "lucide-react";
import { priceFor } from "sandbox-factory";

import { ModelCard, SectionHeading } from "@/components/ReadSection";
import { ThinkingLine } from "@/components/Thinking";

import { money, plural } from "../../lib/format";
import { KindDot } from "../../RubricScenarios";
import { SizeCard } from "./SizeCard";

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
 * The amount and the size, in the place the proposal's own will take: the
 * size's card and its price once the model has sized it, and until then a
 * shape of each. Under them, what the run is doing now.
 */
export function PreviewPrice({ run }: { run: Following }) {
  const { sizing } = progressOf(run);
  // A size the model could not give lands as unsized, as the proposal will.
  const complexity =
    sizing === undefined ? null : (sizing?.complexity ?? "unsized");
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
        <>
          <span
            className={`text-3xl leading-none font-semibold tracking-tight ${
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
          <div className="sm:col-start-2 sm:row-start-1 sm:justify-self-end">
            <SizeCard size={complexity} current />
          </div>
        </>
      )}
      <ThinkingLine
        className="sm:col-span-2"
        since={run?.startedAt ?? run?.createdAt}
      >
        {previewLine(run)}
      </ThinkingLine>
    </div>
  );
}

/** Why the model sized it so, once it has. */
export function PreviewReason({ run }: { run: Following }) {
  const { sizing } = progressOf(run);
  return (
    <div data-testid="preview-reason">
      <SectionHeading icon={<Sparkles />} tone="model">
        Why this size
      </SectionHeading>
      <ModelCard>
        {sizing === undefined ? (
          <Lines />
        ) : (
          <p className="text-sm leading-relaxed">
            {sizing === null
              ? "The model could not size this bounty."
              : sizing.rationale}
          </p>
        )}
      </ModelCard>
    </div>
  );
}

/** The scenarios the bounty was drafted into, once they are. */
export function PreviewScenarios({ run }: { run: Following }) {
  const { spec } = progressOf(run);
  return (
    <div data-testid="preview-scenarios">
      <SectionHeading
        icon={<ListChecks />}
        aside={
          spec == null ? undefined : plural(spec.scenarios.length, "scenario")
        }
      >
        Scenarios
      </SectionHeading>
      {spec === undefined ? (
        <div className="rounded-lg border p-4">
          <Lines />
        </div>
      ) : spec === null ? (
        <p className="text-muted-foreground text-sm">
          The scenarios could not be drafted.
        </p>
      ) : (
        <div className="rounded-lg border p-4">
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
      )}
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
