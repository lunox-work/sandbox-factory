/** One Orvanta ledger entry, in cents. */
export interface OrvantaEntry {
  readonly amountCents: number;
  readonly kind: "debit" | "credit";
}

/** What the entries leave on an Orvanta account, in cents. */
export function orvantaBalance(entries: readonly OrvantaEntry[]): number {
  return entries.reduce(
    (sum, entry) =>
      sum + (entry.kind === "credit" ? entry.amountCents : -entry.amountCents),
    0,
  );
}
