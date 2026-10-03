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

import { DEFAULT_ISSUE_TYPE, ticketSpecHash } from "@sandbox-factory/shared";

import { adfToTextResult } from "./adf.js";

/** What a run reads before it prices a ticket. */
export interface JiraIssueSpec {
  readonly key: string;
  readonly summary: string;
  /** The description, flattened from ADF. Empty when the ticket has none. */
  readonly descriptionText: string;
  readonly issueType: string;
  /**
   * The ticket's Jira components, by name: the one signal Jira gives for
   * free about which part of the product a ticket touches. Read for the
   * spec draft, and **not part of either hash**: a component edit does not
   * make a proposal stale.
   */
  readonly components: readonly string[];
  /** The ticket's labels. Like `components`, read but not hashed. */
  readonly labels: readonly string[];
  /**
   * Jira's priority name, or null when the site has priorities off. Read
   * for the complexity profile; like `components`, not hashed.
   */
  readonly priority: string | null;
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
   * Version 1 of the ticket's own hash (`ticketSpecHash`): the normalized
   * summary, description and issue type as a JSON tuple. On review, the live
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
  "issuetype",
  "components",
  "labels",
  "priority",
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
  issueType: string,
) => Promise<string> = ticketSpecHash;

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
    issuetype?: { name?: unknown } | null;
    components?: unknown;
    labels?: unknown;
    priority?: { name?: unknown } | null;
    updated?: unknown;
  },
): Promise<JiraIssueSpec> {
  const summary = typeof fields.summary === "string" ? fields.summary : "";
  const description = adfToTextResult(fields.description);
  const issueType =
    typeof fields.issuetype?.name === "string"
      ? fields.issuetype.name
      : DEFAULT_ISSUE_TYPE;
  return {
    key,
    summary,
    descriptionText: description.text,
    issueType,
    components: names(fields.components),
    labels: strings(fields.labels),
    priority:
      typeof fields.priority?.name === "string" ? fields.priority.name : null,
    updated: typeof fields.updated === "string" ? fields.updated : null,
    inputTruncated: description.truncated,
    specHash: await specHash(summary, description.text),
    pricingSpecHash: await pricingSpecHash(
      summary,
      description.text,
      issueType,
    ),
  };
}

/** The strings of a list that may be missing or malformed. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
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
