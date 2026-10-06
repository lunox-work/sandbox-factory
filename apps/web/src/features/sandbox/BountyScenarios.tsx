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

import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

import { isPlainLeftClick } from "../../routes";
import type { Feature, Scenario } from "./gherkin";
import { DocumentLabel, ScenarioCard } from "./GherkinDocument";
import { currentRow, row, rowCount, SectionLabel } from "./SidePanels";

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

/** A word beside a title: a weight, where a scenario came from. Square, as
    the editor's own badges are; a pill is a web page's. */
const chip =
  "rounded-sm border border-(--wb-input-border) px-1.5 text-[11px] leading-[18px] text-(--wb-muted)";

/**
 * The spec's open questions or its assumptions, laid out as a scenario is:
 * a heading on a rule, then each numbered in the column the steps' keywords
 * take.
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
    <section aria-label={heading} className="mt-6">
      <header className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-x-3 border-b border-(--wb-border) pb-2">
        <span className="text-right font-(family-name:--wb-font-code) text-xs text-(--wb-gutter) tabular-nums">
          {notes.length}
        </span>
        <h2 className="text-[15px] font-semibold text-(--wb-strong)">
          {heading}
        </h2>
      </header>
      <ol className="py-1 text-[13px]">
        {notes.map((note, index) => (
          <li
            key={index}
            className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-x-3 border-t border-white/[0.04] py-1.5 leading-relaxed first:border-t-0"
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
    // Scenarios are numbered as the document numbers them; the background
    // and the notes are not.
    let number = 0;
    body = (
      <>
        <h1 className="text-[22px] leading-tight font-semibold text-(--wb-strong)">
          {draft.feature}
        </h1>
        <div className="mt-2 flex items-center gap-2 text-xs text-(--wb-muted)">
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
          const numbered = each.anchor.startsWith("scenario-");
          if (numbered) number += 1;
          return (
            <Fragment key={each.anchor}>
              {opensGroup && <DocumentLabel>{each.group}</DocumentLabel>}
              {/* A row on the steps' grid, the number where their keyword
                  goes: the overview reads as the document's table of
                  contents, not a stack of cards. */}
              {link(
                each.anchor,
                "-mx-2 grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 rounded-sm px-2 py-1.5 hover:bg-(--wb-hover)",
                <>
                  <span className="text-right font-(family-name:--wb-font-code) text-xs text-(--wb-gutter) tabular-nums">
                    {numbered ? String(number).padStart(2, "0") : ""}
                  </span>
                  <span className="min-w-0 text-(--wb-strong)">
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
    // A line of text either way, as a book's running foot: no tiles.
    const step = (to: Item | undefined, direction: "Previous" | "Next") =>
      to === undefined ? (
        <span />
      ) : (
        link(
          to.anchor,
          cn(
            "flex min-w-0 items-center gap-1 text-(--wb-muted) hover:text-(--wb-strong)",
            direction === "Next" && "text-right",
          ),
          <>
            {direction === "Previous" && (
              <ChevronLeft aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{to.title}</span>
            {direction === "Next" && (
              <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
            )}
          </>,
          `${direction}: ${to.title}`,
        )
      );
    body = (
      <>
        <nav
          aria-label="Scenarios"
          className="flex items-center gap-1.5 text-xs text-(--wb-muted)"
        >
          {link(undefined, "hover:text-(--wb-strong)", "Bounty scenarios")}
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{item.group}</span>
          <span className="shrink-0 tabular-nums">
            · {at + 1} of {items.length}
          </span>
          <span className="ml-auto">{openBounty}</span>
        </nav>
        {item.view}
        <div className="mt-8 grid grid-cols-2 gap-6 border-t border-(--wb-border) pt-3 text-xs">
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
      {/* Against the left, as the editor's own previews are; a column
          centred in the editor reads as a web page opened in it. */}
      <article className="max-w-[52rem] px-8 pt-6 pb-16 text-[14px]">
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
  /*
    Rows of the outline, as the editor's own outline view draws symbols:
    one line each, the title cut to the width, the whole of it in the
    tooltip. The feature at the top level; its scenarios and notes a level
    in, as the explorer indents a folder's files.
  */
  const link = (
    anchor: string | undefined,
    title: string,
    body: ReactNode,
    depth = 1,
  ) => (
    <a
      href={href(anchor)}
      aria-current={current === anchor ? "location" : undefined}
      title={title}
      className={cn(
        row,
        depth === 1 && "pl-[34px]",
        depth === 2 && "pl-[42px]",
        current === anchor && currentRow,
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
  return (
    <section aria-label="Bounty scenarios">
      <SectionLabel>
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate">Bounty scenarios</span>
          {points !== null && (
            <span className="shrink-0 font-normal tabular-nums">
              {plural(points, "pt")}
            </span>
          )}
        </span>
      </SectionLabel>
      <ul>
        <li>
          {link(
            undefined,
            draft.feature,
            <>
              <img
                src={iconUrl("file-type-cucumber")}
                alt=""
                aria-hidden="true"
                className="size-4 shrink-0"
              />
              <span className="truncate">{draft.feature}</span>
              <span className={rowCount}>
                {plural(draft.scenarios.length, "scenario")}
              </span>
            </>,
            0,
          )}
        </li>
        {/* By kind, as the document groups them: the kind is a row the
            scenarios sit under, a level in, rather than a word on each. */}
        {groupScenarios(draft).map(({ label, scenarios }) =>
          scenarios.length === 0 ? null : (
            <li key={label}>
              <span className={cn(row, "pl-[34px] text-(--wb-muted)")}>
                <span className="truncate">{label}</span>
              </span>
              <ul>
                {scenarios.map((scenario) => {
                  const weight = weightText(scenario.weight);
                  return (
                    <li key={scenario.id}>
                      {link(
                        scenarioAnchor(scenario.id),
                        [scenario.title, label, weight]
                          .filter((part) => part !== undefined)
                          .join(" · "),
                        <>
                          <ListChecks aria-hidden="true" className={icon} />
                          <span className="truncate">{scenario.title}</span>
                          {weight !== undefined && (
                            <span className={rowCount}>{weight}</span>
                          )}
                        </>,
                        2,
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ),
        )}
      </ul>
      {(draft.openQuestions.length > 0 || draft.assumptions.length > 0) && (
        <ul aria-label="Notes">
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
                  heading,
                  <>
                    <Icon aria-hidden="true" className={icon} />
                    <span className="truncate">{heading}</span>
                    <span className={rowCount}>{notes.length}</span>
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
  // One row, as the view's others are: the price where a name goes, the
  // size where a count goes.
  const body = (
    <>
      <span
        className={cn(
          "truncate font-semibold",
          priced ? "text-(--wb-strong) tabular-nums" : "text-(--wb-muted)",
        )}
      >
        {money(amountMinor, currency)}
      </span>
      <span className={cn(rowCount, "flex items-baseline gap-1")}>
        Size
        <span className="font-(family-name:--wb-font-code) text-xs text-(--wb-foreground)">
          {size}
        </span>
      </span>
    </>
  );
  return (
    <section aria-label="Bounty">
      <SectionLabel>Bounty</SectionLabel>
      {href === undefined ? (
        <div className={row}>{body}</div>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title="Open the bounty"
          className={cn(
            row,
            "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)",
          )}
        >
          {body}
        </a>
      )}
    </section>
  );
}
