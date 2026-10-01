/** Pure commercial rules. This module stays dependency-free. */

import type { CategoryConfig, CategoryMatch } from "./selection/categories.js";

/**
 * The five sizes a ticket is judged in: the model's answer, and a
 * reviewer's resize. The rate card has a row for each.
 */
export const WHOLE_BOUNTY_COMPLEXITIES = ["XS", "S", "M", "L", "XL"] as const;
export type WholeComplexity = (typeof WHOLE_BOUNTY_COMPLEXITIES)[number];

/** What the sizing model may answer: a whole size, or none. */
export const MODEL_BOUNTY_COMPLEXITIES = [
  ...WHOLE_BOUNTY_COMPLEXITIES,
  "unsized",
] as const;
export type ModelComplexity = (typeof MODEL_BOUNTY_COMPLEXITIES)[number];

/**
 * Every size a proposal can be priced at, in order: the whole sizes with a
 * half step between each pair. A "+" size is never anyone's answer; it is
 * where a whole size lands when a reviewer has added weight to the spec
 * (`pricing/step`), and it prices between its neighbours. There is no
 * `XL+`: XL already means "consider splitting".
 */
export const PRICED_BOUNTY_COMPLEXITIES = [
  "XS",
  "XS+",
  "S",
  "S+",
  "M",
  "M+",
  "L",
  "L+",
  "XL",
] as const;
export const BOUNTY_COMPLEXITIES = [
  ...PRICED_BOUNTY_COMPLEXITIES,
  "unsized",
] as const;
export type BountyComplexity = (typeof BOUNTY_COMPLEXITIES)[number];
export type PricedComplexity = Exclude<BountyComplexity, "unsized">;

export interface RateCardValues {
  readonly currency: string;
  readonly xsMinor: number;
  readonly sMinor: number;
  readonly mMinor: number;
  readonly lMinor: number;
  readonly xlMinor: number;
}

export interface RateCardSnapshot extends RateCardValues {
  readonly revision: number;
}

/**
 * The card an organization prices with until someone edits it: USD, evenly
 * spaced from 10 to 200 in whole dollars. The rate card editor shows it as
 * the starting values, and the first run on an organization with no card
 * saves it, so a new Jira site is sized without a stop at settings first.
 */
export const DEFAULT_RATE_CARD: RateCardValues = {
  currency: "USD",
  xsMinor: 1_000,
  sMinor: 5_800,
  mMinor: 10_500,
  lMinor: 15_300,
  xlMinor: 20_000,
};

/**
 * The selection settings a run was started with, as snapshotted on the run.
 *
 * Runs from before categories existed hold the older shape (`maxTickets`,
 * `excludeAssigned`); those keys are simply absent from this type and are
 * never read.
 */
export interface BountySelection {
  /** A ceiling on tickets per run. Absent means every matching ticket. */
  readonly ticketCap?: number | undefined;
  readonly unassignedOnly: boolean;
  readonly issueTypes: readonly string[];
  readonly minAgeDays: number;
  readonly maxAgeDays?: number | undefined;
  readonly minSpecChars: number;
  /** Per-category overrides, by category id. See `selection/categories`. */
  readonly categories: CategoryConfig;
}

export type SizingConfidence = "low" | "medium" | "high";

export interface BountySizingResult {
  readonly complexity: ModelComplexity;
  readonly confidence: SizingConfidence;
  readonly rationale: string;
  readonly unsizedReason?: string;
}

export type BountyOutcomeStatus = "proposed" | "unsized" | "failed" | "skipped";

/**
 * A ticket a run chose to size, recorded before sizing starts, so a page
 * opened mid-run can show what is still to come as well as what is done.
 */
export interface BountyRunPlannedIssue {
  readonly externalIssueId: string;
  readonly issueKey: string;
  readonly summary: string;
  /**
   * Why a backlog run picked it. Absent on plans recorded before categories
   * existed, and empty for a ticket a person picked by hand.
   */
  readonly categories?: readonly CategoryMatch[] | undefined;
}

export interface BountyRunOutcome {
  readonly externalIssueId: string;
  readonly issueKey: string;
  readonly jiraIssueId?: string;
  readonly proposalId?: string;
  readonly status: BountyOutcomeStatus;
  readonly code?: string;
  readonly actualModel?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type RateCardValidation =
  | { readonly ok: true; readonly rateCard: RateCardValues }
  | { readonly ok: false; readonly reason: string };

const MAX_MINOR = Number.MAX_SAFE_INTEGER;

/** Maximum for new rate-card writes; historical snapshots remain readable. */
export function maximumRateCardMinor(currency: string): number {
  return currency.trim().toUpperCase() === "USD" ? 100_000 : MAX_MINOR;
}

export function validateRateCard(
  input: RateCardValues,
  supportedCurrencies: ReadonlySet<string>,
): RateCardValidation {
  const currency = input.currency.trim().toUpperCase();
  if (!supportedCurrencies.has(currency)) {
    return { ok: false, reason: "Choose a supported ISO currency." };
  }

  const amounts = [
    input.xsMinor,
    input.sMinor,
    input.mMinor,
    input.lMinor,
    input.xlMinor,
  ];
  if (
    amounts.some(
      (amount) =>
        !Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_MINOR,
    )
  ) {
    return {
      ok: false,
      reason: "Every rate must be a positive whole number of minor units.",
    };
  }
  if (
    input.xsMinor > input.sMinor ||
    input.sMinor > input.mMinor ||
    input.mMinor > input.lMinor ||
    input.lMinor > input.xlMinor
  ) {
    return { ok: false, reason: "Rates must increase from XS through XL." };
  }

  if (input.xlMinor > maximumRateCardMinor(currency)) {
    return { ok: false, reason: "XL cannot exceed USD 1,000." };
  }
  return { ok: true, rateCard: { ...input, currency } };
}

/**
 * What a size costs on a card. A "+" size is the midpoint of its two
 * neighbours, rounded to a whole minor unit: derived from the card rather
 * than stored on it, so the card keeps its five rows, and a snapshot taken
 * before half sizes existed prices them too.
 */
export function priceFor(
  complexity: BountyComplexity,
  rateCard: RateCardValues,
): number | null {
  const midpoint = (lower: number, upper: number) =>
    Math.round((lower + upper) / 2);
  switch (complexity) {
    case "XS":
      return rateCard.xsMinor;
    case "XS+":
      return midpoint(rateCard.xsMinor, rateCard.sMinor);
    case "S":
      return rateCard.sMinor;
    case "S+":
      return midpoint(rateCard.sMinor, rateCard.mMinor);
    case "M":
      return rateCard.mMinor;
    case "M+":
      return midpoint(rateCard.mMinor, rateCard.lMinor);
    case "L":
      return rateCard.lMinor;
    case "L+":
      return midpoint(rateCard.lMinor, rateCard.xlMinor);
    case "XL":
      return rateCard.xlMinor;
    case "unsized":
      return null;
  }
}

/**
 * Parses a decimal entered by a person without passing through binary floats.
 */
export function parseMinorUnits(
  value: string,
  fractionDigits: number,
): number | null {
  if (
    !Number.isInteger(fractionDigits) ||
    fractionDigits < 0 ||
    fractionDigits > 3
  ) {
    return null;
  }
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) return null;
  const fraction = match[1] ?? "";
  if (fraction.length > fractionDigits) return null;

  const scale = 10n ** BigInt(fractionDigits);
  const whole = BigInt(value.trim().split(".")[0] ?? "0");
  const padded = fraction.padEnd(fractionDigits, "0");
  const minor = whole * scale + BigInt(padded === "" ? "0" : padded);
  return minor > BigInt(MAX_MINOR) ? null : Number(minor);
}

/** Formats safe minor units as an exact decimal string for editable inputs. */
export function formatMinorUnits(
  value: number,
  fractionDigits: number,
): string | null {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isInteger(fractionDigits) ||
    fractionDigits < 0 ||
    fractionDigits > 3
  ) {
    return null;
  }
  if (fractionDigits === 0) return String(value);

  const scale = 10 ** fractionDigits;
  const whole = Math.floor(value / scale);
  const fraction = String(value % scale).padStart(fractionDigits, "0");
  return `${whole}.${fraction}`;
}
