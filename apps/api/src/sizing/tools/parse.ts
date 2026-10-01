/** What every tool's `parse` shares: cleaning text, and naming what failed. */

import type { z } from "zod";

/**
 * Text cut to its cap, with an ellipsis where it was cut.
 *
 * A model overshooting a length is truncated here, not refused: the limit
 * cannot be put in a strict schema, and refusing the whole answer over its
 * last few words is how a good answer used to be thrown away.
 */
export function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Whitespace collapsed to single spaces: one line, with no edges. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The first thing wrong with a result, as a sentence for the retry.
 *
 * Built from the issue's path and the schema's own limits. **Never from
 * the value, and from a message only when it is a refinement's**, which
 * this codebase wrote: anything else can carry what the model wrote, and
 * the retry must not echo that back, nor may it reach a log.
 */
export function describeProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "it did not match the schema.";
  const field =
    issue.path.length === 0 ? "it" : issue.path.map(String).join(".");
  switch (issue.code) {
    case "too_big":
      return `${field} must be at most ${amount(issue.maximum, issue.origin)}.`;
    case "too_small":
      return `${field} must be at least ${amount(issue.minimum, issue.origin)}.`;
    case "invalid_value":
      return `${field} must be one of: ${issue.values.map(String).join(", ")}.`;
    case "invalid_type":
      return `${field} must be present and be ${issue.expected}.`;
    case "custom":
      return `${field}: ${issue.message}`;
    default:
      return `${field} did not match the schema.`;
  }
}

/** A limit with what it counts: "500 characters", "1 item", "3". */
function amount(limit: number | bigint, origin: string): string {
  const unit =
    origin === "string" ? "character" : origin === "array" ? "item" : null;
  if (unit === null) return String(limit);
  return `${String(limit)} ${unit}${Number(limit) === 1 ? "" : "s"}`;
}
