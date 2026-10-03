/**
 * Paging for the list routes: how many rows a page may hold, and the cursor
 * a newest-first page hands to the next.
 */

/** A page's size: 25 unless asked for, and between 1 and 50. */
export function boundedLimit(value: string | undefined): number {
  const parsed = Number(value ?? 25);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 50) : 25;
}

/**
 * A `createdAt|id` cursor, naming a page's last row. Undefined when none
 * was given, and null when the one given cannot be read.
 */
export function rowCursor(
  value: string | undefined,
): { createdAt: string; id: string } | undefined | null {
  if (value === undefined || value === "") return undefined;
  const separator = value.lastIndexOf("|");
  if (separator <= 0) return null;
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return Number.isFinite(Date.parse(createdAt)) && id !== ""
    ? { createdAt, id }
    : null;
}
