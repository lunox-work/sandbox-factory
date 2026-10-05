/**
 * The bounty's scenarios as this version froze them: the spec its task was
 * approved with, which is what the sandbox and its hidden tests were built
 * against. Read from the version, not the bounty, so a spec revised since
 * does not change what this version says it was asked to do.
 *
 * Two views of it: the sidebar's outline, by kind as the bounty's own tab
 * groups them, and the whole of it as a document in the editor, laid out as
 * a `.feature` file is.
 */

import type { SpecDraftDto } from "@sandbox-factory/shared";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Lightbulb,
  ListChecks,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import {
  groupScenarios,
  pointsOfScenarios,
  SCENARIO_WEIGHT_DEFINITIONS,
  WEIGHT_POINTS,
  type Scenario as SpecScenario,
} from "sandbox-factory";

import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

import { isPlainLeftClick } from "../../routes";
import type { Feature, Scenario } from "./gherkin";
import { DocumentLabel, ScenarioCard } from "./GherkinDocument";
import { card, currentCard, SectionLabel } from "./SidePanels";

const WEIGHT_LABEL: ReadonlyMap<string, string> = new Map(
  SCENARIO_WEIGHT_DEFINITIONS.map(({ id, label }) => [id, label]),
);

/** How a scenario the first draft did not write came to be there. */
const ORIGIN_LABEL: Readonly<Record<string, string>> = {
  expansion: "Added",
  reviewer: "Reviewer",
};

/** The anchor a scenario is scrolled to by: `#scenario-s1`. */
export function scenarioAnchor(id: string): string {
  return `scenario-${id}`;
}

/** The anchor of the steps every scenario starts from. */
const BACKGROUND_ANCHOR = "background";

/** The anchor of the questions the bounty left open. */
export const QUESTIONS_ANCHOR = "open-questions";

/** The anchor of what the spec took as given. */
export const ASSUMPTIONS_ANCHOR = "assumptions";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A weight as it reads: `Light · 1 pt`. */
function weightText(weight: string | undefined): string | undefined {
  if (weight === undefined) return undefined;
  const points = Object.hasOwn(WEIGHT_POINTS, weight)
    ? WEIGHT_POINTS[weight as keyof typeof WEIGHT_POINTS]
    : undefined;
  const label = WEIGHT_LABEL.get(weight) ?? weight;
  return points === undefined ? label : `${label} · ${plural(points, "pt")}`;
}

/** The spec's scenarios in the order the outline groups them. */
function ordered(draft: SpecDraftDto) {
  return groupScenarios(draft).flatMap(({ label, scenarios }) =>
    scenarios.map((scenario) => ({ group: label, scenario })),
  );
}

/** The spec as a feature to lay out: its background, then each scenario. */
function featureOf(draft: SpecDraftDto): {
  feature: Feature;
  /** Beside each of the feature's scenarios: its group and the spec's own. */
  sources: ({ group: string; scenario: SpecScenario } | undefined)[];
} {
  const background: Scenario[] =
    draft.background.length === 0
      ? []
      : [
          {
            kind: "background",
            name: "",
            tags: [],
            line: 0,
            steps: draft.background.map((text, index) => ({
              keyword: index === 0 ? "Given" : "And",
              text,
              line: 0,
            })),
            examples: [],
          },
        ];
  const scenarios = ordered(draft);
  return {
    feature: {
      name: draft.feature,
      description: "",
      tags: [],
      scenarios: [
        ...background,
        ...scenarios.map(({ scenario }): Scenario => ({
          kind: "scenario",
          name: scenario.title,
          tags: [],
          line: 0,
          steps: scenario.steps.map(({ keyword, text }) => ({
            keyword,
            text,
            line: 0,
          })),
          examples: [],
        })),
      ],
    },
    sources: [...background.map(() => undefined), ...scenarios],
  };
}

const chip =
  "rounded-full border border-(--wb-input-border) px-2 text-[11px] leading-[18px] text-(--wb-muted)";

/**
 * The spec's open questions or its assumptions, as one card on the scenario
 * cards' grid: each numbered in the column their steps' keywords take.
 */
function Notes({
  heading,
  notes,
}: {
  heading: string;
  notes: readonly string[];
}) {
  if (notes.length === 0) return null;
  return (
    <section
      aria-label={heading}
      className="mt-4 overflow-hidden rounded-lg border border-(--wb-border) bg-(--wb-chrome)"
    >
      <header className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-3 border-b border-(--wb-border) px-4 py-2.5">
        <span className="text-right font-(family-name:--wb-font-code) text-xs text-(--wb-gutter) tabular-nums">
          {notes.length}
        </span>
        <h2 className="font-medium text-(--wb-strong)">{heading}</h2>
      </header>
      <ol className="py-1 text-[13px]">
        {notes.map((note, index) => (
          <li
            key={index}
            className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-x-3 border-t border-white/[0.04] px-4 py-1.5 leading-relaxed first:border-t-0"
          >
            <span className="text-right font-(family-name:--wb-font-code) text-xs text-(--wb-gutter) tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0">{note}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One thing the document shows at a time, in the order it reads. */
interface Item {
  anchor: string;
  title: string;
  /** What it is filed under: its kind, for a scenario. */
  group: string;
  /** A weight or a count, beside the title in the overview. */
  detail?: string;
  view: ReactNode;
}

/** The spec's parts as the document pages through them. */
function itemsOf(draft: SpecDraftDto): Item[] {
  const { feature, sources } = featureOf(draft);
  let number = 0;
  const scenarios = feature.scenarios.map((scenario, index): Item => {
    const source = sources[index];
    if (source === undefined)
      return {
        anchor: BACKGROUND_ANCHOR,
        title: "What every scenario starts from",
        group: "Background",
        detail: plural(scenario.steps.length, "step"),
        view: <ScenarioCard scenario={scenario} number={undefined} />,
      };
    number += 1;
    const weight = weightText(source.scenario.weight);
    const origin = ORIGIN_LABEL[source.scenario.origin];
    return {
      anchor: scenarioAnchor(source.scenario.id),
      title: source.scenario.title,
      group: source.group,
      detail: weight,
      view: (
        <ScenarioCard
          scenario={scenario}
          number={number}
          extras={{
            badges: (
              <>
                {origin !== undefined && <span className={chip}>{origin}</span>}
                {weight !== undefined && <span className={chip}>{weight}</span>}
              </>
            ),
            note: source.scenario.weightReason,
          }}
        />
      ),
    };
  });
  const notes = (
    [
      ["Open questions", draft.openQuestions, QUESTIONS_ANCHOR],
      ["Assumptions", draft.assumptions, ASSUMPTIONS_ANCHOR],
    ] as const
  ).flatMap(([heading, list, anchor]): Item[] =>
    list.length === 0
      ? []
      : [
          {
            anchor,
            title: heading,
            group: "Notes",
            detail: String(list.length),
            view: <Notes heading={heading} notes={list} />,
          },
        ],
  );
  return [...scenarios, ...notes];
}

/**
 * The spec, one part at a time: with no anchor, an overview of every part
 * to pick from; with one, that scenario or that card alone, and the parts
 * either side of it to step to, round from the last to the first.
 */
export function ScenariosDocument({
  draft,
  bountyHref,
  hash,
  href,
  onOpen,
}: {
  draft: SpecDraftDto;
  /** The bounty's own page, where the spec can be changed. */
  bountyHref: string | undefined;
  /** The address's `#…`, naming the part to show. */
  hash: string;
  /** The document's address, at a part when one is given. */
  href: (anchor?: string) => string;
  onOpen: (anchor?: string) => void;
}) {
  const items = itemsOf(draft);
  const at = items.findIndex(({ anchor }) => anchor === hash.slice(1));
  const item = items[at];
  const points = pointsOfScenarios(draft.scenarios, WEIGHT_POINTS);

  const link = (
    anchor: string | undefined,
    className: string,
    children: ReactNode,
    label?: string,
  ) => (
    <a
      href={href(anchor)}
      aria-label={label}
      className={cn(
        "focus-visible:outline-1 focus-visible:outline-(--wb-accent)",
        className,
      )}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        onOpen(anchor);
      }}
    >
      {children}
    </a>
  );
  const openBounty = bountyHref !== undefined && (
    <a
      href={bountyHref}
      target="_blank"
      rel="noreferrer"
      className="ml-auto flex shrink-0 items-center gap-0.5 hover:text-(--wb-strong)"
    >
      Open bounty
      <ArrowUpRight aria-hidden="true" className="size-3.5" />
    </a>
  );

  let body: ReactNode;
  if (item === undefined) {
    const steps = draft.scenarios.reduce(
      (total, { steps: each }) => total + each.length,
      0,
    );
    let group: string | undefined;
    body = (
      <>
        <p className="text-[11px] tracking-wider text-(--wb-muted) uppercase">
          Bounty scenarios
        </p>
        <h1 className="mt-1 text-[26px] leading-tight font-semibold text-(--wb-strong)">
          {draft.feature}
        </h1>
        <div className="mt-4 flex items-center gap-2 text-xs text-(--wb-muted)">
          <span>
            {[
              plural(draft.scenarios.length, "scenario"),
              plural(steps, "step"),
              ...(points === null ? [] : [plural(points, "point")]),
            ].join(" · ")}
          </span>
          {openBounty}
        </div>
        {items.map((each) => {
          const opensGroup = each.group !== group;
          group = each.group;
          return (
            <Fragment key={each.anchor}>
              {opensGroup && <DocumentLabel>{each.group}</DocumentLabel>}
              {link(
                each.anchor,
                "mt-2 flex items-baseline gap-3 rounded-lg border border-(--wb-border) bg-(--wb-chrome) px-4 py-2.5 hover:border-(--wb-input-border) hover:bg-(--wb-hover)",
                <>
                  <span className="min-w-0 flex-1 font-medium text-(--wb-strong)">
                    {each.title}
                  </span>
                  {each.detail !== undefined && (
                    <span className="shrink-0 text-xs text-(--wb-muted) tabular-nums">
                      {each.detail}
                    </span>
                  )}
                </>,
              )}
            </Fragment>
          );
        })}
      </>
    );
  } else {
    // A loop: before the first is the last, after the last the first. A
    // spec of one part has nowhere else to go.
    const previous =
      items.length > 1
        ? items[(at - 1 + items.length) % items.length]
        : undefined;
    const next = items.length > 1 ? items[(at + 1) % items.length] : undefined;
    const step = (to: Item | undefined, direction: "Previous" | "Next") =>
      to === undefined ? (
        <span />
      ) : (
        link(
          to.anchor,
          cn(
            "flex min-w-0 flex-col gap-0.5 rounded-lg border border-(--wb-border) px-4 py-2.5 hover:border-(--wb-input-border) hover:bg-(--wb-hover)",
            direction === "Next" && "items-end text-right",
          ),
          <>
            <span className="flex items-center gap-0.5 text-[11px] tracking-wider text-(--wb-muted) uppercase">
              {direction === "Previous" && (
                <ChevronLeft aria-hidden="true" className="size-3.5" />
              )}
              {direction}
              {direction === "Next" && (
                <ChevronRight aria-hidden="true" className="size-3.5" />
              )}
            </span>
            <span className="max-w-full truncate text-(--wb-strong)">
              {to.title}
            </span>
          </>,
          `${direction}: ${to.title}`,
        )
      );
    body = (
      <>
        <nav
          aria-label="Scenarios"
          className="flex items-center gap-1.5 text-[11px] tracking-wider text-(--wb-muted) uppercase"
        >
          {link(undefined, "hover:text-(--wb-strong)", "Bounty scenarios")}
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{item.group}</span>
          <span className="shrink-0 normal-case tracking-normal tabular-nums">
            · {at + 1} of {items.length}
          </span>
          <span className="ml-auto text-xs tracking-normal normal-case">
            {openBounty}
          </span>
        </nav>
        {item.view}
        <div className="mt-6 grid grid-cols-2 gap-3">
          {step(previous, "Previous")}
          {step(next, "Next")}
        </div>
      </>
    );
  }

  return (
    // Keyed by the part, so each opens scrolled to its top.
    <div
      key={item?.anchor ?? ""}
      className="min-h-0 flex-1 overflow-auto"
      data-testid="scenarios-document"
    >
      <article className="mx-auto max-w-[52rem] px-8 pt-8 pb-16 text-[14px] sm:px-12">
        {body}
      </article>
    </div>
  );
}

/**
 * The spec in the docs view, ahead of the files: the overview, each
 * scenario with its kind and weight, and the open questions and assumptions,
 * a card each. Each opens the scenarios document at that part.
 */
export function ScenariosOutline({
  draft,
  href,
  current,
  onOpen,
  iconUrl,
}: {
  draft: SpecDraftDto;
  /** The document's address, at a part when one is given. */
  href: (anchor?: string) => string;
  /** The part open in the document; null when the document is not open. */
  current: string | null | undefined;
  onOpen: (anchor?: string) => void;
  iconUrl: (name: string) => string | undefined;
}) {
  const link = (anchor: string | undefined, body: ReactNode) => (
    <a
      href={href(anchor)}
      aria-current={current === anchor ? "location" : undefined}
      className={cn(
        card,
        current === anchor && currentCard,
        "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)",
      )}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        onOpen(anchor);
      }}
    >
      {body}
    </a>
  );
  const icon = "size-4 shrink-0 text-(--wb-muted)";
  const points = pointsOfScenarios(draft.scenarios, WEIGHT_POINTS);
  const kindOf = new Map(
    groupScenarios(draft).flatMap(({ label, scenarios }) =>
      scenarios.map(({ id }) => [id, label] as const),
    ),
  );
  return (
    <section aria-label="Bounty scenarios">
      <SectionLabel>
        <span className="flex items-baseline justify-between gap-2">
          Bounty scenarios
          {points !== null && (
            <span className="font-normal tabular-nums">
              {plural(points, "pt")}
            </span>
          )}
        </span>
      </SectionLabel>
      <ul className="flex flex-col gap-1.5">
        <li>
          {link(
            undefined,
            <>
              <img
                src={iconUrl("file-type-cucumber")}
                alt=""
                aria-hidden="true"
                className="size-4 shrink-0"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-(--wb-strong)">{draft.feature}</span>
                <span className="text-[11px] text-(--wb-muted)">
                  {plural(draft.scenarios.length, "scenario")}
                </span>
              </span>
            </>,
          )}
        </li>
        {groupScenarios(draft)
          .flatMap(({ scenarios }) => scenarios)
          .map((scenario) => (
            <li key={scenario.id}>
              {link(
                scenarioAnchor(scenario.id),
                <>
                  <ListChecks aria-hidden="true" className={icon} />
                  <span className="flex min-w-0 flex-col">
                    <span className="leading-snug text-(--wb-strong)">
                      {scenario.title}
                    </span>
                    <span className="text-[11px] text-(--wb-muted)">
                      {[kindOf.get(scenario.id), weightText(scenario.weight)]
                        .filter((part) => part !== undefined)
                        .join(" · ")}
                    </span>
                  </span>
                </>,
              )}
            </li>
          ))}
      </ul>
      {(draft.openQuestions.length > 0 || draft.assumptions.length > 0) && (
        <ul aria-label="Notes" className="mt-1.5 flex flex-col gap-1.5">
          {(
            [
              [
                "Open questions",
                draft.openQuestions,
                QUESTIONS_ANCHOR,
                CircleHelp,
              ],
              ["Assumptions", draft.assumptions, ASSUMPTIONS_ANCHOR, Lightbulb],
            ] as const
          ).map(([heading, notes, anchor, Icon]) =>
            notes.length === 0 ? null : (
              <li key={anchor}>
                {link(
                  anchor,
                  <>
                    <Icon aria-hidden="true" className={icon} />
                    <span className="min-w-0 flex-1 text-(--wb-strong)">
                      {heading}
                    </span>
                    <span className="text-[11px] text-(--wb-muted) tabular-nums">
                      {notes.length}
                    </span>
                  </>,
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * The bounty this version was cut for, as the version froze it: what it
 * pays and its size, as the bounty's own page shows them. Opens that page,
 * which may have moved on since, in a tab of its own.
 */
export function BountyCard({
  size,
  amountMinor,
  currency,
  href,
}: {
  size: string;
  /** Null when the version froze no price. */
  amountMinor: number | null;
  currency: string | null;
  href: string | undefined;
}) {
  const priced = amountMinor !== null && currency !== null;
  const body = (
    <>
      <span
        className={cn(
          "text-2xl leading-none font-semibold tracking-tight",
          priced ? "text-(--wb-strong) tabular-nums" : "text-(--wb-muted)",
        )}
      >
        {money(amountMinor, currency)}
      </span>
      <span className="flex items-center gap-1.5 text-sm">
        <span className="text-(--wb-muted)">Size</span>
        <Badge variant="outline" className="font-mono">
          {size}
        </Badge>
      </span>
    </>
  );
  const box = cn(card, "justify-between py-3");
  return (
    <section aria-label="Bounty">
      <SectionLabel>Bounty</SectionLabel>
      {href === undefined ? (
        <div className={box}>{body}</div>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title="Open the bounty"
          className={cn(
            box,
            "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)",
          )}
        >
          {body}
        </a>
      )}
    </section>
  );
}
