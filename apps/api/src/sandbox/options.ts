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
  BountyProfileStore,
  BountyProposalStore,
  BountySpecStore,
  BountyStore,
  GithubRepoStore,
  LatestBountyContext,
  NewBountyProfile,
  ObjectStore,
  SandboxStore,
  StoredBounty,
} from "@sandbox-factory/db";

export interface SandboxRouteOptions {
  readonly sandboxes: SandboxStore;
  readonly runs: Pick<AnalysisRunStore, "get" | "enqueue" | "latestSucceeded">;
  readonly artifacts: Pick<ArtifactStore, "list">;
  readonly objects: Pick<ObjectStore, "get" | "remove">;
  readonly proposals: Pick<BountyProposalStore, "get" | "liveForBounty">;
  readonly specs: Pick<BountySpecStore, "get">;
  /** The bounty a generated version is written from: its text and stack. */
  readonly bounties: Pick<BountyStore, "get">;
  /**
   * The workspace's repositories, any of which a bounty's work may touch,
   * for the stack detected in them.
   */
  readonly repos: Pick<GithubRepoStore, "list">;
  /**
   * What the organization is called and its handle, which a build checks
   * no public file names. Absent, only the repository's names are.
   */
  readonly organizationNames?: (
    organizationId: string,
  ) => Promise<readonly string[]>;
  /**
   * The context a bounty holds from its sources (`heldContext`), frozen
   * into each version's task. Absent, a version is taken with none.
   */
  readonly contextFor?: (
    organizationId: string,
    bounty: StoredBounty,
  ) => Promise<LatestBountyContext>;
  /**
   * The sizing's profiles of a spec revision, whose slice a linked
   * sandbox's version is cut from. Absent, nothing is sliced from here.
   */
  readonly profiles?: Pick<BountyProfileStore, "forRevision">;
  /** Asks the profiler for a revision's profile it does not have yet. */
  readonly requestProfile?: (
    organizationId: string,
    input: NewBountyProfile,
  ) => Promise<void>;
  /**
   * Where a version asked for before its slice was ready is remembered, for
   * the cutter to cut once it is (`cutter.ts`). Absent, such a request is
   * answered with where the slice stands and nothing more.
   */
  readonly cuts?: Pick<SandboxStore, "requestCut" | "clearCut">;
  readonly ensureWorker: () => Promise<void>;
  readonly maxActive?: number;
  readonly onLaunchError?: () => void;
  readonly now?: () => Date;
}
