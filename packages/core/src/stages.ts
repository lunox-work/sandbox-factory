/**
 * A bounty is made in three steps, each built on the one before: its
 * overview (the title and description), the bounty itself (its proposal,
 * which specifies and prices the overview) and its sandbox (which is cut
 * for the approved bounty). Each step is versioned, and each records the
 * version of the step before it that it was built on.
 *
 * The steps are not locked to each other. The overview can be edited while
 * a proposal stands on it, and a proposal unapproved and changed while a
 * sandbox is published over it: a later step keeps the version it was built
 * on, and reads as behind until it is built again. What is decided here is
 * when a step is behind, so every surface says so alike.
 */

/** Where each step stands, and what each was built on. */
export interface BountyStages {
  /** The overview's version: one for each change to its title or text. */
  readonly overview: { readonly version: number };
  /**
   * The live proposal: its version, 0 until it is first approved, and the
   * overview version it was sized from. That is null when it was sized from
   * text the overview never said, such as before a hash change.
   */
  readonly bounty: {
    readonly version: number;
    readonly overviewVersion: number | null;
  } | null;
  /**
   * The sandbox version contributors get, or the latest while none is
   * published, and the bounty version it was built on. Null when the
   * version predates the record.
   */
  readonly sandbox: {
    readonly version: number;
    readonly bountyVersion: number | null;
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
 * Which steps are behind the step before them. A proposal is behind once
 * the overview has moved past what it was sized from. A sandbox is behind
 * once the bounty has been approved as a version past the one it was built
 * on; a bounty changed but not yet approved again has no new version, so
 * nothing is behind it yet.
 */
export function stageDrift(stages: BountyStages): {
  readonly bounty: StageDrift | null;
  readonly sandbox: StageDrift | null;
} {
  const { overview, bounty, sandbox } = stages;
  return {
    bounty:
      bounty !== null &&
      (bounty.overviewVersion === null ||
        bounty.overviewVersion < overview.version)
        ? { uses: bounty.overviewVersion, current: overview.version }
        : null,
    sandbox:
      sandbox !== null &&
      bounty !== null &&
      bounty.version > 0 &&
      (sandbox.bountyVersion === null || sandbox.bountyVersion < bounty.version)
        ? { uses: sandbox.bountyVersion, current: bounty.version }
        : null,
  };
}

/**
 * The overview version a fingerprint was taken from: the latest version
 * whose text hashes to it, since text changed and changed back says what
 * it said before. Null when no version does.
 */
export function overviewVersionOf(
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
 * Whether the overview stands approved: an owner or admin approved the
 * version it is at. While it does, its title, text, repository, stack and
 * Jira link are not changed; unapproving it opens them again. A version made
 * since (Jira's text, which no approval holds back) is not the one approved.
 */
export function overviewApproved(bounty: {
  readonly version: number;
  readonly approval: { readonly version: number } | null;
}): boolean {
  return bounty.approval !== null && bounty.approval.version === bounty.version;
}
