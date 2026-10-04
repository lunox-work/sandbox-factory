/**
 * Sandboxes and their versions, for the owning organization.
 *
 * A version is cut from a succeeded slice run: the route reads the run's
 * manifest and contract from private storage, verifies their hashes,
 * snapshots the approved task from the live proposal and spec, validates
 * the alias table, resolves the scope and writes the private provenance
 * in one store call. The build route queues a `sandbox_build` run whose
 * parameters carry every hash the output must bind to. Nothing here is
 * public; publication is phase 5D.
 */

import type {
  AnalysisRunStore,
  ArtifactStore,
  BountyProposalStore,
  BountySpecStore,
  ObjectStore,
  SandboxStore,
} from "@sandbox-factory/db";

export interface SandboxRouteOptions {
  readonly sandboxes: SandboxStore;
  readonly runs: Pick<AnalysisRunStore, "get" | "enqueue">;
  readonly artifacts: Pick<ArtifactStore, "list">;
  readonly objects: Pick<ObjectStore, "get" | "remove">;
  readonly proposals: Pick<BountyProposalStore, "get">;
  readonly specs: Pick<BountySpecStore, "get">;
  readonly ensureWorker: () => Promise<void>;
  readonly maxActive?: number;
  readonly onLaunchError?: () => void;
  readonly now?: () => Date;
}
