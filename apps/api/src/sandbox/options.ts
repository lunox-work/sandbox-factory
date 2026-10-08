/**
 * Sandboxes and their versions, for the owning organization.
 *
 * A version is cut from a succeeded slice run: the route reads the run's
 * manifest and contract from private storage, verifies their hashes,
 * snapshots the approved task from the live proposal and spec, validates
 * the alias table, resolves the scope and writes the private provenance
 * in one store call. The build route queues a `sandbox_build` run whose
 * parameters carry every hash the output must bind to. A sandbox with no
 * repository has its versions generated instead: the starter route queues
 * an agent run that writes one from the bounty's text and builds it.
 * Publishing makes a built version the sandbox's current one until a date;
 * no public repository is pushed yet.
 */

import type {
  AnalysisRunStore,
  ArtifactStore,
  BountyProposalStore,
  BountySpecStore,
  BountyStore,
  GithubRepoStore,
  LatestBountyContext,
  ObjectStore,
  SandboxStore,
  StoredBounty,
} from "@sandbox-factory/db";

export interface SandboxRouteOptions {
  readonly sandboxes: SandboxStore;
  readonly runs: Pick<AnalysisRunStore, "get" | "enqueue">;
  readonly artifacts: Pick<ArtifactStore, "list">;
  readonly objects: Pick<ObjectStore, "get" | "remove">;
  readonly proposals: Pick<BountyProposalStore, "get" | "liveForBounty">;
  readonly specs: Pick<BountySpecStore, "get">;
  /** The bounty a generated version is written from: its text and stack. */
  readonly bounties: Pick<BountyStore, "get">;
  /** The repository a bounty names, for the stack detected in it. */
  readonly repos: Pick<GithubRepoStore, "get">;
  /**
   * The context a bounty holds from its sources (`heldContext`), frozen
   * into each version's task. Absent, a version is taken with none.
   */
  readonly contextFor?: (
    organizationId: string,
    bounty: StoredBounty,
  ) => Promise<LatestBountyContext>;
  readonly ensureWorker: () => Promise<void>;
  readonly maxActive?: number;
  readonly onLaunchError?: () => void;
  readonly now?: () => Date;
}
