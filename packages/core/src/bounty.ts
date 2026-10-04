/**
 * A bounty: the platform's own record of a piece of work, which a proposal
 * prices and a sandbox is cut for.
 *
 * The platform holds it, not a tracker. A bounty is written here by a
 * person, or imported from Jira, and whichever it was it is the same row,
 * proposed the same way. A source such as Jira enriches a bounty rather than
 * owning it: an imported bounty's text follows its Jira issue each time a
 * run reads it, and a bounty whose issue has gone keeps the text it last
 * had.
 *
 * What is decided here, once, is what a bounty's sizing input is and how it
 * is fingerprinted, so a proposal goes stale the same way whether its
 * bounty's text came from Jira or from the form.
 */

/** Where a bounty's text came from when it was made. Never changes. */
export const BOUNTY_ORIGINS = ["manual", "jira"] as const;
export type BountyOrigin = (typeof BOUNTY_ORIGINS)[number];

/**
 * The bounds of a bounty's text, for one written or edited here. The
 * description's is also where a Jira description is cut when it is
 * flattened, so a bounty asks a model for about as much whichever way it
 * was written. Jira's text is stored as read, and can run past these: a cut
 * description carries its truncation marker, and Jira bounds no labels.
 */
export const BOUNTY_LIMITS = {
  title: 255,
  description: 20_000,
  issueType: 64,
  priority: 64,
  labels: 20,
  label: 64,
} as const;

/** The issue type a bounty has when nobody named one, as Jira's default. */
export const DEFAULT_ISSUE_TYPE = "Task";

/**
 * A title from a source the limit does not bound, cut to fit it. Never in
 * the middle of a surrogate pair: half a character is stored as a
 * replacement character, which the source's title never matches again, so
 * every later read would see a change and move the revision.
 */
export function clampBountyTitle(title: string): string {
  const cut = title.slice(0, BOUNTY_LIMITS.title);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** What a bounty says: everything a run sizes it from. */
export interface BountyContent {
  readonly title: string;
  readonly description: string;
  readonly issueType: string;
  /** The priority's name, or null when the bounty has none. */
  readonly priority: string | null;
  readonly labels: readonly string[];
  /** Jira's components, by name. Empty for a bounty written here. */
  readonly components: readonly string[];
  /**
   * True when the source held more than the description keeps: a Jira
   * description past the flattening limit. A bounty written here is
   * refused at the limit instead, so it is never truncated.
   */
  readonly inputTruncated: boolean;
}

/**
 * The version of `bountySpecHash`: the normalized title, description and
 * issue type as a JSON tuple. Version 1 is the hash proposals stored when
 * bounties were read from Jira, so the proposals made then still compare.
 */
export const BOUNTY_SPEC_HASH_VERSION = 1;

/**
 * A stable fingerprint of what a bounty was priced from.
 *
 * Three properties matter, in this order:
 *
 * - **Stable.** The same text must hash the same on every machine and every
 *   run, or proposals would go stale at random. Hence a fixed field order,
 *   encoded as JSON so no field can run into the next.
 * - **Sensitive to meaning.** An edit to the words changes the hash.
 * - **Insensitive to noise.** Trailing whitespace and CRLF do not, because
 *   opening a bounty in a different editor should not invalidate a bounty.
 *
 * Labels, components and priority are read for the draft and the profile,
 * and are deliberately not hashed: retagging a bounty does not make its
 * price stale.
 *
 * SHA-256 via `crypto.subtle`, which exists in Node, browsers and workers
 * alike, so this stays dependency-free.
 */
export async function bountySpecHash(
  title: string,
  description: string,
  issueType: string,
): Promise<string> {
  const canonical = JSON.stringify([
    normalizeSpecText(title),
    normalizeSpecText(description),
    normalizeSpecText(issueType),
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Line endings and trailing space removed; the words themselves untouched. */
export function normalizeSpecText(value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * How a bounty is named to a person: its Jira key while it has one, and its
 * number here otherwise. The number is the organization's own count, so
 * `B-12` is the twelfth bounty the organization has, whatever its source.
 */
export function bountyKey(bounty: {
  readonly number: number;
  readonly jiraKey?: string | null | undefined;
}): string {
  return bounty.jiraKey ?? `B-${bounty.number}`;
}
