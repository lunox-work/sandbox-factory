/**
 * A `.feature` file as a document to read: the feature and its description,
 * then each scenario as a card of its steps, keywords in a column of their
 * own and coloured by role, with their tables, doc strings and examples.
 */

import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import {
  parseFeature,
  scenarioCount,
  type Feature,
  type Scenario,
  type Step,
  type StepKeyword,
} from "./gherkin";

const KEYWORD_COLOURS: Record<StepKeyword, string> = {
  Given: "text-[#569cd6]",
  When: "text-[#d7ba7d]",
  Then: "text-[#89d185]",
  And: "text-(--wb-gutter)",
  But: "text-(--wb-gutter)",
  "*": "text-(--wb-gutter)",
};

const PLACEHOLDER = "text-[#c586c0]";

/** Text with each pattern match coloured by `colour`, the rest left as is. */
function pickOut(
  text: string,
  pattern: RegExp,
  colour: (value: string, key: string) => ReactNode,
): ReactNode[] {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > from) parts.push(text.slice(from, at));
    parts.push(colour(match[0], String(at)));
    from = at + match[0].length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/**
 * A step's text with its "values", <placeholders> and numbers picked out; a
 * placeholder inside a value, `"<address>"`, still reads as a placeholder.
 */
function StepText({ text }: { text: string }) {
  return pickOut(
    text,
    /"[^"]*"|'[^']*'|<[^>\s]+>|\b\d+(?:\.\d+)?\b/g,
    (value, key) =>
      value.startsWith("<") ? (
        <span key={key} className={PLACEHOLDER}>
          {value}
        </span>
      ) : /^\d/.test(value) ? (
        <span key={key} className="text-[#b5cea8]">
          {value}
        </span>
      ) : (
        <span key={key} className="text-[#ce9178]">
          {pickOut(value, /<[^>\s]+>/g, (inner, at) => (
            <span key={at} className={PLACEHOLDER}>
              {inner}
            </span>
          ))}
        </span>
      ),
  );
}

function Table({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  if (head === undefined) return null;
  return (
    <div className="overflow-x-auto rounded-[4px] border border-(--wb-border)">
      <table className="w-full border-collapse font-(family-name:--wb-font-code) text-xs">
        <thead>
          <tr className="bg-white/[0.04] text-(--wb-muted)">
            {head.map((cell, index) => (
              <th key={index} className="px-3 py-1.5 text-left font-semibold">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, at) => (
            <tr key={at} className="border-t border-(--wb-border)">
              {row.map((cell, index) => (
                <td key={index} className="px-3 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  return (
    <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 border-t border-white/[0.04] py-1.5 first:border-t-0">
      <span
        className={cn(
          "text-right font-semibold",
          KEYWORD_COLOURS[step.keyword],
        )}
      >
        {step.keyword}
      </span>
      <span className="min-w-0">
        <StepText text={step.text} />
      </span>
      {(step.table !== undefined || step.docString !== undefined) && (
        <div className="col-start-2 mt-2 mb-1 flex flex-col gap-2">
          {step.table !== undefined && <Table rows={step.table} />}
          {step.docString !== undefined && (
            <pre className="overflow-x-auto rounded-[4px] border border-(--wb-border) bg-(--wb-editor) px-3 py-2 font-(family-name:--wb-font-code) text-xs text-(--wb-code)">
              {step.docString}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

function Tags({ tags }: { tags: readonly string[] }) {
  return tags.map((tag) => (
    <span
      key={tag}
      className="rounded-[4px] border border-(--wb-input-border) px-1.5 text-2xs leading-[18px] text-[#9cdcfe]"
    >
      {tag}
    </span>
  ));
}

/** What a reader of one scenario gets beyond its steps, when there is more. */
export interface ScenarioExtras {
  /** Chips beside the title: a weight, where it came from. */
  badges?: ReactNode;
  /** A line under the title: why it weighs what it does. */
  note?: ReactNode;
}

export function ScenarioCard({
  scenario,
  number,
  onReveal,
  extras,
}: {
  scenario: Scenario;
  /** 1-based among scenarios; undefined for the background. */
  number: number | undefined;
  /** Shows the file as written at the scenario's line; absent with no file. */
  onReveal?: (line: number) => void;
  extras?: ScenarioExtras;
}) {
  const background = scenario.kind === "background";
  const title = scenario.name || (background ? "Background" : "Scenario");
  return (
    // Laid out as a document's section, not boxed: a heading on a rule,
    // the steps under it on the same grid. The background's heading is
    // quieter, since it is what every scenario shares rather than one.
    <section aria-label={title} className="group/card mt-6">
      <header className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 border-b border-(--wb-border) pb-2">
        <span className="text-right font-(family-name:--wb-font-code) text-xs text-(--wb-gutter) tabular-nums">
          {number === undefined ? "BG" : String(number).padStart(2, "0")}
        </span>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2
            className={cn(
              "min-w-0 text-[15px] font-semibold",
              background ? "text-(--wb-muted)" : "text-(--wb-strong)",
            )}
          >
            {title}
          </h2>
          {scenario.kind === "outline" && (
            <span className="rounded-[4px] border border-[#c586c0]/40 px-1.5 text-2xs text-[#c586c0]">
              Outline
            </span>
          )}
          <Tags tags={scenario.tags} />
          {extras?.badges}
          {onReveal !== undefined && (
            <button
              type="button"
              onClick={() => onReveal(scenario.line)}
              className="ml-auto flex items-center gap-0.5 rounded-[4px] px-1 text-xs text-(--wb-muted) opacity-0 group-hover/card:opacity-100 hover:text-(--wb-strong) focus-visible:opacity-100 coarse:opacity-100"
            >
              Line {scenario.line}
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </div>
        {extras?.note !== undefined && (
          <p className="col-start-2 text-xs text-(--wb-muted)">{extras.note}</p>
        )}
      </header>
      <ol className="py-1 text-[13px]">
        {scenario.steps.map((step, index) => (
          <StepRow key={index} step={step} />
        ))}
      </ol>
      {scenario.examples.map((examples, index) => (
        <div
          key={index}
          className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-white/[0.04] py-3"
        >
          <span className="col-start-2 text-xs font-semibold text-(--wb-muted)">
            Examples{examples.name === "" ? "" : ` — ${examples.name}`}
          </span>
          <div className="col-start-2">
            <Table rows={examples.table} />
          </div>
        </div>
      ))}
    </section>
  );
}

/** A group's heading in a document: a quiet line, as a sub-heading is. */
export function DocumentLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-6 mb-1 flex items-baseline justify-between gap-3 text-xs font-semibold text-(--wb-muted)">
      {children}
    </h2>
  );
}

/**
 * A feature laid out to read: its name, description and counts, then each
 * scenario as a card.
 */
function FeatureView({
  feature,
  onReveal,
}: {
  feature: Feature;
  onReveal: (line: number) => void;
}) {
  const steps = feature.scenarios.reduce(
    (total, scenario) => total + scenario.steps.length,
    0,
  );
  const scenarios = scenarioCount(feature);
  let number = 0;
  return (
    <div
      className="min-h-0 flex-1 overflow-auto"
      data-testid="gherkin-document"
    >
      {/* Against the left, as the editor's own previews are. */}
      <article className="max-w-[52rem] px-8 pt-6 pb-[40vh] text-[14px]">
        <p className="text-xs text-(--wb-muted)">Feature</p>
        <h1 className="mt-0.5 text-[22px] leading-tight font-semibold text-(--wb-strong)">
          {feature.name || "Untitled feature"}
        </h1>
        {feature.description !== "" && (
          <p className="mt-3 leading-relaxed whitespace-pre-line text-(--wb-muted)">
            {feature.description}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-(--wb-muted)">
          <Tags tags={feature.tags} />
          <span>
            {scenarios} {scenarios === 1 ? "scenario" : "scenarios"} · {steps}{" "}
            {steps === 1 ? "step" : "steps"}
          </span>
        </div>
        {feature.scenarios.map((scenario, index) => (
          <ScenarioCard
            key={index}
            scenario={scenario}
            number={scenario.kind === "background" ? undefined : (number += 1)}
            onReveal={onReveal}
          />
        ))}
      </article>
    </div>
  );
}

/** A `.feature` file, parsed and laid out. */
export function GherkinDocument({
  text,
  onReveal,
}: {
  text: string;
  /** Shows the file as written, at a line. */
  onReveal: (line: number) => void;
}) {
  return <FeatureView feature={parseFeature(text)} onReveal={onReveal} />;
}
