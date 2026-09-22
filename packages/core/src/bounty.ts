/** Pure commercial rules. This module stays dependency-free. */

export const PRICED_BOUNTY_COMPLEXITIES = ["XS", "S", "M", "L", "XL"] as const;
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

export interface BountySelection {
  readonly maxTickets: number;
  readonly excludeAssigned: boolean;
  readonly issueTypes: readonly string[];
  readonly minAgeDays: number;
  readonly maxAgeDays?: number;
  readonly minSpecChars: number;
}

export type SizingConfidence = "low" | "medium" | "high";

export interface BountySizingResult {
  readonly complexity: BountyComplexity;
  readonly confidence: SizingConfidence;
  readonly rationale: string;
  readonly unsizedReason?: string;
}

export type BountyOutcomeStatus = "proposed" | "unsized" | "failed" | "skipped";

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

export function priceFor(
  complexity: BountyComplexity,
  rateCard: RateCardValues,
): number | null {
  switch (complexity) {
    case "XS":
      return rateCard.xsMinor;
    case "S":
      return rateCard.sMinor;
    case "M":
      return rateCard.mMinor;
    case "L":
      return rateCard.lMinor;
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
