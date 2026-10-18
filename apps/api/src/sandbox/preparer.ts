/**
 * Prepares approved bounties' sandboxes before anyone asks for one: once a
 * profile is ready and its proposal approved at that spec revision, the
 * fixtures agent and the pseudonyms agent run on its slice (a `fixtures`
 * run with `pseudonyms`), and the profile names the run. A Sandbox click
 * then cuts the draft with the fixtures attached, and its build takes the
 * name table when its own check passes it (`version-service.ts`), so the
 * click waits for one baseline and the hidden tests only.
 *
 * It runs for every approved bounty in a workspace that has not turned
 * `prepareSandboxes` off, which is model spend for a sandbox that may never
 * be made; the setting is the workspace's to weigh. A pass is prompted by
 * the profiler settling a profile and by an approval, and a timer catches
 * what this process did not see. A run refused at the organization's
 * analysis cap is asked for again on the next pass, one slot short of the
 * cap, as the profiler's are, so a person's own analysis is not refused.
 *
 * The fixtures and pseudonyms agents read the slice, whose repository text
 * can steer them, so a slice wider than `AUTO_SLICE_LIMITS` is prepared
 * only once an owner or admin approved it. The profiler holds such a one
 * `awaiting_approval`, which this never lists; a profile measured `ready`
 * from one before approvals were asked for is checked here, and moved to
 * `awaiting_approval` rather than prepared (`holdsForApproval`).
 */

import type {
  AnalysisRunStore,
  ArtifactStore,
  BountyProfileStore,
  BountyProposalStore,
  BountyStore,
  StoredBountyProfile,
} from "@sandbox-factory/db";
import { organizationNames, workspaceVocabulary } from "sandbox-factory";

import { enqueueAnalysis } from "../analysis/enqueue.js";
import {
  holdsForApproval,
  sliceApprovalOf,
  sliceListing,
} from "./version-service.js";

/** How often unprepared profiles are looked at without a prompt. */
export const PREPARE_SWEEP_MS = 60_000;
/** Two agents in one run: the fixtures', then the pseudonyms'. */
export const PREPARATION_DEADLINE_MINUTES = 90;

export interface SandboxPreparerOptions {
  readonly profiles: Pick<
    BountyProfileStore,
    "unprepared" | "organizationsWithUnprepared" | "recordPrepared" | "advance"
  >;
  readonly runs: Pick<AnalysisRunStore, "enqueue" | "get" | "latestSucceeded">;
  /** The slice run's summary, which says whether it waits for approval. */
  readonly artifacts: Pick<ArtifactStore, "list">;
  readonly proposals: Pick<BountyProposalStore, "get">;
  readonly bounties: Pick<BountyStore, "get">;
  /** The organization's name and handle, which no public file may carry. */
  readonly organizationNames: (organizationId: string) => Promise<string[]>;
  readonly ensureWorker: () => Promise<void>;
  /** A re-queued run's previous log, to remove from the bucket. */
  readonly removeObject: (key: string) => Promise<void>;
  readonly maxActive?: number;
  readonly intervalMs?: number;
  readonly onError?: (code: string, error?: unknown) => void;
}

export class SandboxPreparer {
  readonly #options: SandboxPreparerOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<void> | undefined;
  #again = false;
  #stopped = false;

  constructor(options: SandboxPreparerOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#stopped = false;
    this.kick();
    this.#timer = setInterval(
      () => this.kick(),
      this.#options.intervalMs ?? PREPARE_SWEEP_MS,
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending?.catch(() => {});
  }

  /** A pass now, or another straight after the one in progress. */
  kick(): void {
    if (this.#stopped) return;
    void this.sweep().catch((error: unknown) =>
      this.#options.onError?.("sandbox_prepare_sweep_failed", error),
    );
  }

  async sweep(): Promise<void> {
    if (this.#pending !== undefined) {
      this.#again = true;
      return this.#pending;
    }
    const work = async () => {
      do {
        this.#again = false;
        let queued = false;
        for (const owner of await this.#options.profiles.organizationsWithUnprepared()) {
          try {
            if (await this.#prepareOrganization(owner)) queued = true;
          } catch (error) {
            // Left for the next pass; the other organizations still move.
            this.#options.onError?.("sandbox_prepare_failed", error);
          }
        }
        if (queued)
          await this.#options
            .ensureWorker()
            .catch((error: unknown) =>
              this.#options.onError?.("analysis_worker_launch_failed", error),
            );
      } while (this.#again);
    };
    this.#pending = work();
    try {
      await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }

  /** Whether a run was queued; stops at the organization's cap. */
  async #prepareOrganization(owner: string): Promise<boolean> {
    let queued = false;
    const names = await this.#options.organizationNames(owner);
    for (const profile of await this.#options.profiles.unprepared(owner)) {
      const outcome = await this.#prepare(owner, profile, names);
      if (outcome === "full") break;
      if (outcome === "queued") queued = true;
    }
    return queued;
  }

  async #prepare(
    owner: string,
    profile: StoredBountyProfile,
    names: readonly string[],
  ): Promise<"queued" | "found" | "full" | "skipped"> {
    if (profile.snapshotId === null || profile.sliceRunId === null)
      return "skipped";
    if (profile.sliceApprovedAt === null) {
      const approval = await sliceApprovalOf(
        this.#options,
        owner,
        profile.sliceRunId,
      );
      // Unreadable, it cannot be told within the limits: not prepared.
      if (approval === null) return "skipped";
      if (holdsForApproval(profile, approval)) {
        if (profile.profile !== null)
          await this.#options.profiles.advance(owner, profile.id, "ready", {
            status: "awaiting_approval",
            profile: profile.profile,
          });
        return "skipped";
      }
    }
    const proposal = await this.#options.proposals.get(
      owner,
      profile.proposalId,
    );
    const bounty =
      proposal === null
        ? null
        : await this.#options.bounties.get(owner, proposal.bountyId);
    if (bounty === null) return "skipped";
    const dataModel = await this.#options.runs.latestSucceeded(
      owner,
      profile.snapshotId,
      "data_model",
    );
    let queued = false;
    const result = await enqueueAnalysis(
      {
        runs: this.#options.runs,
        removeObject: this.#options.removeObject,
        onQueued: () => {
          queued = true;
        },
      },
      owner,
      profile.snapshotId,
      {
        tool: "fixtures",
        params: {
          deadlineMinutes: PREPARATION_DEADLINE_MINUTES,
          agent: "fixtures",
          proposalId: profile.proposalId,
          specRevision: profile.specRevision,
          specHash: profile.specHash,
          sliceRunId: profile.sliceRunId,
          ...(dataModel === null ? {} : { dataModelRunId: dataModel.id }),
          pseudonyms: {
            // The names `workspaceNames` gives a build of this sandbox.
            vocabulary: workspaceVocabulary([
              ...organizationNames([
                ...names,
                ...(profile.repository?.split("/").slice(0, 1) ?? []),
              ]),
              ...(profile.repository?.split("/").slice(1) ?? []),
            ]),
            ...sliceListing(bounty),
          },
        },
        requestedBy: null,
        maxActive: Math.max(1, (this.#options.maxActive ?? 3) - 1),
      },
    );
    if (!result.ok) {
      if (result.reason === "run_limit") return "full";
      this.#options.onError?.(`sandbox_prepare_${result.reason}`);
      return "skipped";
    }
    await this.#options.profiles.recordPrepared(
      owner,
      profile.id,
      result.run.id,
    );
    return queued ? "queued" : "found";
  }
}
