/**
 * A bounty is made in three steps, each built on the one before:
 *
 * - its scope: the title and description, what the work is;
 * - its price: the proposal that sizes the scope and prices it;
 * - its sandbox: the task cut for contributors from the approved price.
 *
 * Each step is versioned, and each records the version of the step before
 * it that it was built on. A step is done when it is approved; a sandbox,
 * when it is published and its publication has not lapsed.
 *
 * The steps are not locked to each other. The scope can be edited while a
 * price stands on it, and a price unapproved and changed while a sandbox is
 * published over it: a later step keeps the version it was built on, and
 * reads as behind until it is built again. What is decided here is when a
 * step is behind, and how far a bounty has got, so every surface says so
 * alike.
 */

import { isPublicationLive, type SandboxStatus } from "./sandbox/provenance.js";
import type { ContextVersions } from "./sources.js";

/** The three steps, in the order a bounty is made in. */
export const BOUNTY_STEPS = ["scope", "price", "sandbox"] as const;
export type BountyStep = (typeof BOUNTY_STEPS)[number];

/** Where each step stands, and what each was built on. */
export interface BountyStages {
  /**
   * The scope's version: one for each change to its title or text. Its
   * `context` is the latest context synced from each source, which the
   * steps after it are made with (`contextDrift`).
   */
  readonly scope: {
    readonly version: number;
    readonly context?: ContextVersions;
  };
  /**
   * The live price: its version, 0 until it is first approved, and the
   * scope version it was sized from. That is null when it was sized from
   * text the scope never said, such as before a hash change.
   */
  readonly price: {
    readonly version: number;
    readonly scopeVersion: number | null;
    /** The context versions it was sized with. */
    readonly context?: ContextVersions;
  } | null;
  /**
   * The sandbox version contributors get, or the latest while none is
   * published, and the price version it was built on. Null when the
   * version predates the record.
   */
  readonly sandbox: {
    readonly version: number;
    readonly priceVersion: number | null;
    /** The context versions it was generated with. */
    readonly context?: ContextVersions;
  } | null;
}

/**
 * A step built on an earlier version of the step before it: the version it
 * uses, null when unknown, and the version the step before is at now.
 */
export interface StageDrift {
  readonly uses: number | null;
  readonly current: number;
}

/**
 * Which steps are behind the step before them. A price is behind once the
 * scope has moved past what it was sized from. A sandbox is behind once the
 * price has been approved as a version past the one it was built on; a
 * price changed but not yet approved again has no new version, so nothing
 * is behind it yet.
 */
export function stageDrift(stages: BountyStages): {
  readonly price: StageDrift | null;
  readonly sandbox: StageDrift | null;
} {
  const { scope, price, sandbox } = stages;
  return {
    price:
      price !== null &&
      (price.scopeVersion === null || price.scopeVersion < scope.version)
        ? { uses: price.scopeVersion, current: scope.version }
        : null,
    sandbox:
      sandbox !== null &&
      price !== null &&
      price.version > 0 &&
      (sandbox.priceVersion === null || sandbox.priceVersion < price.version)
        ? { uses: sandbox.priceVersion, current: price.version }
        : null,
  };
}

/**
 * The scope version a fingerprint was taken from: the latest version whose
 * text hashes to it, since text changed and changed back says what it said
 * before. Null when no version does.
 */
export function scopeVersionOf(
  specHash: string,
  versions: readonly { readonly version: number; readonly specHash: string }[],
): number | null {
  let found: number | null = null;
  for (const { version, specHash: hash } of versions) {
    if (hash === specHash && (found === null || version > found))
      found = version;
  }
  return found;
}

/**
 * Whether the scope stands approved: an owner or admin approved the version
 * it is at. While it does, its title, text, repository, stack and Jira link
 * are not changed; unapproving it opens them again. A version made since
 * (Jira's text, which no approval holds back) is not the one approved.
 */
export function scopeApproved(bounty: {
  readonly version: number;
  readonly approval: { readonly version: number } | null;
}): boolean {
  return bounty.approval !== null && bounty.approval.version === bounty.version;
}

/**
 * How far a bounty has got, as one status: the last step it has done.
 *
 * - `new`: no step done yet;
 * - `scoped`: its scope is approved;
 * - `priced`: its price is approved;
 * - `live`: its sandbox is published, and the publication has not lapsed.
 *
 * The furthest step done wins, whatever the steps before it say since: a
 * sandbox stays live while its scope is edited, and reads as live until it
 * is unpublished or lapses.
 */
export const BOUNTY_STATUSES = ["new", "scoped", "priced", "live"] as const;
export type BountyStatus = (typeof BOUNTY_STATUSES)[number];

export function bountyStatus(
  bounty: {
    readonly version: number;
    readonly approval: { readonly version: number } | null;
    readonly proposal: { readonly status: string } | null;
    readonly sandbox: {
      readonly status: SandboxStatus;
      readonly expiresAt?: string | null;
    } | null;
  },
  now: Date = new Date(),
): BountyStatus {
  if (bounty.sandbox !== null && isPublicationLive(bounty.sandbox, now))
    return "live";
  if (bounty.proposal?.status === "approved") return "priced";
  if (scopeApproved(bounty)) return "scoped";
  return "new";
}
