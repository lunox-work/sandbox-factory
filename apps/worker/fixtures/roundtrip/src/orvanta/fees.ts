/**
 * Fee rules: https://wiki.orvanta.internal/payments/fees
 * @author ada.lovelace@orvanta.io
 */
import type { OrvantaEntry } from "./ledger.js";

/** The flat Orvanta charge on a debit, in cents. */
const orvantaCharge = 25;

/** The Orvanta fee on one entry, in cents: a flat charge on every debit. */
export function orvantaFee(entry: OrvantaEntry): number {
  return entry.kind === "debit" ? orvantaCharge : 0;
}
