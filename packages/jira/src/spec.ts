import { normalizeSpecText } from "@sandbox-factory/shared";
/**
 * Reading a ticket's spec, and fingerprinting what was read.
 *
 * Kept apart from `client.ts` because the description is the one thing this
 * package reads only by name: a run hashes it, sizes from it, drafts a spec
 * from it and writes it onto the issue's ticket, the platform's own copy.
 * `ISSUE_FIELDS` — what every list read asks for —
 * does not include `description`, so a board read cannot pull ticket text
 * even by accident; only `issueSpec` can, one ticket at a time, and the
 * caller has to ask for it by name.
 */

import { bountySpecHash } from "@sandbox-factory/shared";

import { adfToTextResult } from "./adf.js";

/** What a run reads before it prices a ticket. */
export interface JiraIssueSpec {
  readonly key: string;
  readonly summary: string;
  /** The description, flattened from ADF. Empty when the ticket has none. */
  readonly descriptionText: string;
  /**
   * The ticket's Jira components, by name: the one signal Jira gives for
   * free about which part of the product a ticket touches. Read for the
   * spec draft, and **not part of either hash**: a component edit does not
   * make a proposal stale.
   */
  readonly components: readonly string[];
  /** Jira's own `updated`, for ordering and for staleness reporting. */
  readonly updated: string | null;
  /** True when ADF depth or length limits omitted any sizing input. */
  readonly inputTruncated: boolean;
  /**
   * A fingerprint of `summary` + `descriptionText`, the first version of
   * the spec hash. Nothing compares it now: proposals are priced against
   * `pricingSpecHash`.
   */
  readonly specHash: string;
  /**
   * The ticket's own hash (`bountySpecHash`, at its current version): the
   * normalized summary and description as a JSON tuple. On review, the live
   * ticket is re-read and re-hashed: a difference means the spec changed
   * after it was priced, and the proposal is stale.
   */
  readonly pricingSpecHash: string;
}

/**
 * The fields `issueSpec` requests. `description` appears here and nowhere
 * else — see the module comment.
 */
export const SPEC_FIELDS: readonly string[] = [
  "summary",
  "description",
  "components",
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
  const canonical = `${normalizeSpecText(summary)}\u0000${normalizeSpecText(descriptionText)}`;
  return sha256(canonical);
}

/**
 * Fingerprints every input that affects pricing, encoded without ambiguity.
 *
 * The ticket's own hash, not a copy of it: a ticket imported from Jira is
 * priced from its stored text, and the two must agree byte for byte or a
 * fresh read would call every proposal stale.
 */
export const pricingSpecHash: (
  summary: string,
  descriptionText: string,
) => Promise<string> = bountySpecHash;

async function sha256(canonical: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Builds the spec from a raw issue payload. Exported for the client. */
export async function toIssueSpec(
  key: string,
  fields: {
    summary?: unknown;
    description?: unknown;
    components?: unknown;
    updated?: unknown;
  },
): Promise<JiraIssueSpec> {
  const summary = typeof fields.summary === "string" ? fields.summary : "";
  const description = adfToTextResult(fields.description);
  return {
    key,
    summary,
    descriptionText: description.text,
    components: names(fields.components),
    updated: typeof fields.updated === "string" ? fields.updated : null,
    inputTruncated: description.truncated,
    specHash: await specHash(summary, description.text),
    pricingSpecHash: await pricingSpecHash(summary, description.text),
  };
}

/** The `name` of each entry, which is how Jira sends components. */
function names(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        typeof entry.name === "string"
          ? [entry.name]
          : [],
      )
    : [];
}
