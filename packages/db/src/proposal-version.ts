/**
 * A proposal's version: the count people see of what it has been approved
 * as, apart from the `revision` every write moves and is checked against.
 *
 * An approval is a new version unless nothing has changed since the
 * current one. `version_revision` holds the revision at which nothing has:
 * an approval writes its own, and a withdrawal, which changes nothing it
 * says, moves it on to the withdrawal's. Every other write (a resize, a
 * re-price, a spec change) moves the revision past it, so the approval
 * after one is a new version.
 */

import { sql } from "drizzle-orm";

import { bountyProposal } from "./schema.js";

/** The version columns an approval from `expectedRevision` writes. */
export function approvalVersion(expectedRevision: number, now: Date) {
  const unchanged = sql`${bountyProposal.versionRevision} = ${expectedRevision}`;
  return {
    version: sql`case when ${unchanged} then ${bountyProposal.version} else ${bountyProposal.version} + 1 end`,
    // Bound as text and cast: the driver does not serialise a Date inside
    // a raw fragment.
    versionedAt: sql`case when ${unchanged} then ${bountyProposal.versionedAt} else ${now.toISOString()}::timestamptz end`,
    versionRevision: expectedRevision + 1,
  };
}

/**
 * The version columns a withdrawal from `expectedRevision` writes: an
 * approved proposal's version is its approval's, so the version stands at
 * the withdrawal's revision too.
 */
export function withdrawalVersion(expectedRevision: number) {
  return { versionRevision: expectedRevision + 1 };
}
