/**
 * Scores the invented corpus with the rubric and lays the result out as a
 * table of expected against actual band, spec-only and code-informed.
 *
 * Points come from `assessRubric` as it is; only the band a total falls in
 * can be swapped, so candidate edges are judged on the same points the
 * rubric gives today (`PRICING_CORPUS_BANDS="XS:0,XS+:4,S:7,..."`).
 */

import {
  assessRubric,
  PRICED_BOUNTY_COMPLEXITIES,
  RUBRIC_BANDS,
  type PricedComplexity,
} from "../../src/index.js";
import {
  PRICING_CORPUS,
  repositoriesOf,
  specOf,
  type CorpusTicket,
} from "./corpus.js";

export type Bands = readonly {
  readonly size: PricedComplexity;
  readonly from: number;
}[];

export interface Scored {
  readonly points: number;
  readonly size: PricedComplexity;
  /** Half-sizes from expected: positive is priced above it. */
  readonly gap: number;
}

export interface CorpusRow {
  readonly ticket: CorpusTicket;
  /** Before the code is measured, or with no repository. */
  readonly spec: Scored;
  /** Once every repository is measured; the spec's alone when none is. */
  readonly code: Scored;
  /** The code dimension's own points, discounts included. */
  readonly codePoints: number;
}

const position = (size: PricedComplexity) =>
  PRICED_BOUNTY_COMPLEXITIES.indexOf(size);

export function sizeWith(points: number, bands: Bands): PricedComplexity {
  let size: PricedComplexity = "XS";
  for (const band of bands) if (points >= band.from) size = band.size;
  return size;
}

/** `XS:0,XS+:4,...` as bands, rejecting anything not every size, rising. */
export function parseBands(text: string): Bands {
  const bands = text.split(",").map((part) => {
    const [size, from] = part.trim().split(":");
    const known = PRICED_BOUNTY_COMPLEXITIES.find((value) => value === size);
    const value = Number(from);
    if (known === undefined || !Number.isInteger(value))
      throw new Error(`not a band: ${part}`);
    return { size: known, from: value };
  });
  const sizes = bands.map(({ size }) => size).join(",");
  if (sizes !== PRICED_BOUNTY_COMPLEXITIES.join(","))
    throw new Error(`bands must name ${PRICED_BOUNTY_COMPLEXITIES.join(",")}`);
  if (bands[0]?.from !== 0) throw new Error("XS must start at 0");
  for (let index = 1; index < bands.length; index += 1)
    if ((bands[index]?.from ?? 0) <= (bands[index - 1]?.from ?? 0))
      throw new Error("band edges must rise");
  return bands;
}

export function scoreCorpus(
  bands: Bands = RUBRIC_BANDS,
  corpus: readonly CorpusTicket[] = PRICING_CORPUS,
): CorpusRow[] {
  return corpus.map((ticket) => {
    const spec = specOf(ticket);
    const scored = (points: number): Scored => {
      const size = sizeWith(points, bands);
      return { points, size, gap: position(size) - position(ticket.expected) };
    };
    const specOnly = assessRubric({ spec, code: { status: "unavailable" } });
    const profiles = repositoriesOf(ticket);
    const informed =
      profiles.length === 0
        ? specOnly
        : assessRubric({
            spec,
            code: { status: "measured", profiles, specRevision: 1 },
          });
    const codePoints =
      informed.dimensions.find(({ id }) => id === "code")?.points ?? 0;
    return {
      ticket,
      spec: scored(specOnly.points),
      code: scored(informed.points),
      codePoints,
    };
  });
}

export interface Summary {
  readonly tickets: number;
  readonly exact: number;
  /** Within one half-size either way, exact included. */
  readonly withinHalf: number;
  readonly above: number;
  readonly below: number;
  /** Mean absolute gap, in half-sizes. */
  readonly meanGap: number;
}

export function summarize(gaps: readonly number[]): Summary {
  const total = gaps.reduce((sum, gap) => sum + Math.abs(gap), 0);
  return {
    tickets: gaps.length,
    exact: gaps.filter((gap) => gap === 0).length,
    withinHalf: gaps.filter((gap) => Math.abs(gap) <= 1).length,
    above: gaps.filter((gap) => gap > 0).length,
    below: gaps.filter((gap) => gap < 0).length,
    meanGap: gaps.length === 0 ? 0 : total / gaps.length,
  };
}

const signedGap = (gap: number) =>
  gap === 0 ? "=" : gap > 0 ? `+${gap}` : `${gap}`;

const line = (summary: Summary, label: string) =>
  `${label}: ${summary.exact}/${summary.tickets} exact, ` +
  `${summary.withinHalf} within a half-size, ${summary.above} above, ` +
  `${summary.below} below, mean gap ${summary.meanGap.toFixed(2)} half-sizes`;

/** The table and its two summary lines, as plain text. */
export function formatReport(rows: readonly CorpusRow[], bands: Bands): string {
  const header = [
    "ticket",
    "expected",
    "spec pts",
    "spec",
    "gap",
    "code pts",
    "+code",
    "total",
    "gap",
  ];
  const body = rows.map(({ ticket, spec, code, codePoints }) => [
    ticket.id,
    ticket.expected,
    String(spec.points),
    spec.size,
    signedGap(spec.gap),
    ticket.code.length === 0 ? "-" : String(codePoints),
    code.size,
    String(code.points),
    signedGap(code.gap),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((cells) => cells[column]?.length ?? 0)),
  );
  const render = (cells: readonly string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    `bands: ${bands.map(({ size, from }) => `${size}:${from}`).join(",")}`,
    "expected bands are judgement, not truth (see corpus.ts)",
    render(header),
    ...body.map(render),
    line(summarize(rows.map(({ spec }) => spec.gap)), "spec-only"),
    line(summarize(rows.map(({ code }) => code.gap)), "code-informed"),
  ].join("\n");
}
