import { parseMinorUnits } from "sandbox-factory";

export function ungroupAmount(value: string): string {
  const trimmed = value.trim();
  return /^\d{1,3}(?:,\d{3})+$/.test(trimmed)
    ? trimmed.replaceAll(",", "")
    : value;
}

export function parseRateAmount(value: string, digits: number): number | null {
  const whole = ungroupAmount(value).trim();
  if (!/^\d+$/.test(whole)) return null;
  return parseMinorUnits(whole, digits);
}

export function formatRateAmount(value: string): string {
  const whole = parseRateAmount(value, 0);
  if (whole === null) return value;
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
