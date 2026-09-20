/**
 * Reading a ticket's spec, and fingerprinting what was read.
 *
 * Kept apart from `client.ts` because the spec is the one thing this package
 * reads that the platform deliberately does not store. `ISSUE_FIELDS` — what
 * every list read asks for — does not include `description`, so a board read
 * cannot pull ticket text even by accident; only `issueSpec` can, one ticket
 * at a time, and the caller has to ask for it by name.
 */

import { adfToText } from "./adf.js";

/** What a run reads before it prices a ticket. */
export interface JiraIssueSpec {
  readonly key: string;
  readonly summary: string;
  /** The description, flattened from ADF. Empty when the ticket has none. */
  readonly descriptionText: string;
  readonly issueType: string;
  /** Jira's own `updated`, for ordering and for staleness reporting. */
  readonly updated: string | null;
  /**
   * A fingerprint of `summary` + `descriptionText`.
   *
   * The platform stores this and not the text. On review, the live ticket is
   * re-read and re-hashed: a difference means the spec changed after it was
   * priced, and the proposal is stale.
   */
  readonly specHash: string;
}

/**
 * The fields `issueSpec` requests. `description` appears here and nowhere
 * else — see the module comment.
 */
export const SPEC_FIELDS: readonly string[] = [
  "summary",
  "description",
  "issuetype",
  "updated",
];

/**
 * A stable fingerprint of the spec that was priced.
 *
 * Three properties matter, in this order:
 *
 * - **Stable.** The same spec must hash the same on every machine and every
 *   run, or proposals would go stale at random. Hence a fixed field order and
 *   a separator that cannot appear in the parts.
 * - **Sensitive to meaning.** An edit to the words changes the hash.
 * - **Insensitive to noise.** Trailing whitespace and CRLF do not, because
 *   opening a ticket in a different editor should not invalidate a bounty.
 *
 * SHA-256 via `crypto.subtle`, which exists in Node 18+, browsers and workers
 * alike — this package must not import `node:crypto` (see its tsconfig).
 */
export async function specHash(
  summary: string,
  descriptionText: string,
): Promise<string> {
  // `\u0000` separates the fields: it cannot occur in text Jira renders, so
  // no summary can be crafted to collide with a summary+description pair.
  const canonical = `${normalize(summary)}\u0000${normalize(descriptionText)}`;
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Line endings and trailing space removed; the words themselves untouched. */
function normalize(value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/** Builds the spec from a raw issue payload. Exported for the client. */
export async function toIssueSpec(
  key: string,
  fields: {
    summary?: unknown;
    description?: unknown;
    issuetype?: { name?: unknown } | null;
    updated?: unknown;
  },
): Promise<JiraIssueSpec> {
  const summary = typeof fields.summary === "string" ? fields.summary : "";
  const descriptionText = adfToText(fields.description);
  return {
    key,
    summary,
    descriptionText,
    issueType:
      typeof fields.issuetype?.name === "string"
        ? fields.issuetype.name
        : "Task",
    updated: typeof fields.updated === "string" ? fields.updated : null,
    specHash: await specHash(summary, descriptionText),
  };
}
