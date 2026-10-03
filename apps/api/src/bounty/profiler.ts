import { enqueueAnalysis } from "../analysis/enqueue.js";
/**
 * Profiles each proposal sized beside a repository: the scope agent picks
 * the slice for its spec, the slice is cut, and the complexity profile is
 * built from what was measured (`sandbox-factory`'s `buildComplexityProfile`).
 *
 * A sizing asks for a profile; nothing here runs on the request path. The
 * worker reports a finished run only to the database, so a sweep every
 * `intervalMs` reads each profile still in flight and takes it one step:
 *
 *   queued  → the graph and scope runs are enqueued      → scoping
 *   scoping → the scope's slice request is enqueued      → slicing
 *   slicing → the profile is built from the slice        → ready
 *
 * A step that meets the organization's analysis cap leaves the row where it
 * is for the next sweep, so a backlog of fifty tickets queues behind the cap
 * rather than failing. It meets it a slot early, so a person's own analysis
 * is not refused while a backlog's profiles fill the queue. A run that fails is final for that spec revision: the
 * profile fails with the run's code beside its own, and a re-price, which
 * drafts a new revision, asks again.
 */

import type {
  AnalysisRunStore,
  ArtifactStore,
  BountyProfileStore,
  BountySpecStore,
  NewBountyProfile,
  RepoSnapshotStore,
  StoredAnalysisRun,
  StoredBountyProfile,
} from "@sandbox-factory/db";
import {
  AGENT_DEADLINE_MINUTES,
  GRAPH_DEADLINE_MINUTES,
  scopeProposalSchema,
  sliceBoundarySummarySchema,
  type ScopeProposalDto,
} from "@sandbox-factory/shared";
import {
  buildComplexityProfile,
  sliceRequestOf,
  type AnalysisErrorCode,
  type ProfileErrorCode,
} from "sandbox-factory";

/** How often in-flight profiles are looked at. */
export const PROFILE_SWEEP_MS = 30_000;

export interface BountyProfilerOptions {
  readonly profiles: Pick<
    BountyProfileStore,
    "request" | "pending" | "organizationsWithPending" | "advance"
  >;
  readonly runs: Pick<AnalysisRunStore, "enqueue" | "get">;
  readonly artifacts: Pick<ArtifactStore, "list">;
  readonly snapshots: Pick<RepoSnapshotStore, "get">;
  readonly specs: Pick<BountySpecStore, "get">;
  readonly ensureWorker: () => Promise<void>;
  /** A re-queued run's previous log, to remove from the bucket. */
  readonly removeObject: (key: string) => Promise<void>;
  /**
   * The organization's analysis cap. The profiler leaves one of its slots
   * for a person whenever the cap has more than one.
   */
  readonly maxActive?: number;
  readonly intervalMs?: number;
  readonly onError?: (code: string, error?: unknown) => void;
}

/** What one step decided for a row. */
type Step =
  | { readonly kind: "wait" }
  /** The organization's analysis cap is reached: no more enqueues this sweep. */
  | { readonly kind: "full" }
  | { readonly kind: "moved" };

const WAIT: Step = { kind: "wait" };
const FULL: Step = { kind: "full" };
const MOVED: Step = { kind: "moved" };

export class BountyProfiler {
  readonly #options: BountyProfilerOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<void> | undefined;
  #again = false;
  /** A run this pass left queued, so a worker is wanted. */
  #wanted = false;
  /** Stopped: a request still in flight at shutdown starts no sweep. */
  #stopped = false;

  constructor(options: BountyProfilerOptions) {
    this.#options = options;
  }

  /**
   * Asks for a spec revision's profile and starts on it at once. Never
   * throws: a profile is evidence beside a price, not what the price
   * stands on, so a failure here must not fail the sizing that asked.
   */
  async request(organizationId: string, input: NewBountyProfile) {
    try {
      const stored = await this.#options.profiles.request(
        organizationId,
        input,
      );
      if (stored !== null) this.kick();
    } catch (error) {
      this.#options.onError?.("bounty_profile_request_failed", error);
    }
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#stopped = false;
    this.kick();
    this.#timer = setInterval(
      () => this.kick(),
      this.#options.intervalMs ?? PROFILE_SWEEP_MS,
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending?.catch(() => {});
  }

  /** A sweep now, or another straight after the one in progress. */
  kick(): void {
    if (this.#stopped) return;
    void this.sweep().catch((error: unknown) =>
      this.#options.onError?.("bounty_profile_sweep_failed", error),
    );
  }

  /**
   * One pass over every organization's profiles in flight. A call during a
   * pass returns that pass, and runs one more after it, so a profile asked
   * for mid-pass is not left for the timer.
   */
  async sweep(): Promise<void> {
    if (this.#pending !== undefined) {
      this.#again = true;
      return this.#pending;
    }
    const work = async () => {
      do {
        this.#again = false;
        this.#wanted = false;
        for (const owner of await this.#options.profiles.organizationsWithPending()) {
          try {
            await this.#sweepOrganization(owner);
          } catch (error) {
            // One organization's rows that could not be read wait for the
            // next sweep; the other organizations' still move.
            this.#options.onError?.("bounty_profile_sweep_failed", error);
          }
        }
        if (this.#wanted)
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

  async #sweepOrganization(owner: string): Promise<void> {
    let full = false;
    for (const profile of await this.#options.profiles.pending(owner)) {
      let step: Step;
      try {
        step = await this.#step(owner, profile, full);
      } catch (error) {
        // One row's trouble (a database blip, an artifact that would not
        // list) is retried on the next sweep; the rest still move.
        this.#options.onError?.("bounty_profile_step_failed", error);
        continue;
      }
      if (step.kind === "full") full = true;
    }
  }

  #step(owner: string, profile: StoredBountyProfile, full: boolean) {
    switch (profile.status) {
      case "queued":
        return full ? Promise.resolve(FULL) : this.#scope(owner, profile);
      case "scoping":
        return this.#slice(owner, profile, full);
      case "slicing":
        return this.#build(owner, profile);
      default:
        return Promise.resolve(WAIT);
    }
  }

  /** queued → scoping: the snapshot's graph, then the scope run that reads it. */
  async #scope(owner: string, profile: StoredBountyProfile): Promise<Step> {
    if (profile.snapshotId === null)
      return this.#fail(owner, profile, "source_unavailable");
    const graph = await this.#enqueue(owner, profile.snapshotId, {
      tool: "graphify",
      params: { deadlineMinutes: GRAPH_DEADLINE_MINUTES },
    });
    if (graph === "full") return FULL;
    if (graph === null) return this.#fail(owner, profile, "source_unavailable");
    if (graph.status === "failed")
      return this.#fail(owner, profile, "scope_failed", graph.errorCode);
    const scope = await this.#enqueue(owner, profile.snapshotId, {
      tool: "scope",
      params: {
        deadlineMinutes: AGENT_DEADLINE_MINUTES,
        agent: "scope",
        graphRunId: graph.id,
        proposalId: profile.proposalId,
        specRevision: profile.specRevision,
        specHash: profile.specHash,
      },
    });
    if (scope === "full") return FULL;
    if (scope === null) return this.#fail(owner, profile, "source_unavailable");
    if (scope.status === "failed")
      return this.#fail(owner, profile, "scope_failed", scope.errorCode);
    return this.#advance(owner, profile, {
      status: "scoping",
      scopeRunId: scope.id,
    });
  }

  /** scoping → slicing: once the scope has succeeded, the slice it chose. */
  async #slice(
    owner: string,
    profile: StoredBountyProfile,
    full: boolean,
  ): Promise<Step> {
    const run = await this.#run(owner, profile.scopeRunId);
    if (run === null) return this.#fail(owner, profile, "source_unavailable");
    if (run.status === "failed")
      return this.#fail(owner, profile, "scope_failed", run.errorCode);
    if (run.status !== "succeeded") return WAIT;
    if (full) return FULL;
    const scope = await this.#scopeProposal(owner, run.id);
    if (scope === null) return this.#fail(owner, profile, "output_invalid");
    const slice = await this.#enqueue(owner, run.snapshotId, {
      tool: "slice",
      params: {
        deadlineMinutes: GRAPH_DEADLINE_MINUTES,
        graphRunId: scope.graphRunId,
        ...sliceRequestOf(scope),
      },
    });
    if (slice === "full") return FULL;
    if (slice === null) return this.#fail(owner, profile, "source_unavailable");
    if (slice.status === "failed")
      return this.#fail(owner, profile, "slice_failed", slice.errorCode);
    return this.#advance(owner, profile, {
      status: "slicing",
      sliceRunId: slice.id,
    });
  }

  /** slicing → ready: the profile, from the slice, its scope, the tree and the spec. */
  async #build(owner: string, profile: StoredBountyProfile): Promise<Step> {
    const run = await this.#run(owner, profile.sliceRunId);
    if (run === null) return this.#fail(owner, profile, "source_unavailable");
    if (run.status === "failed")
      return this.#fail(owner, profile, "slice_failed", run.errorCode);
    if (run.status !== "succeeded") return WAIT;
    const [scope, summary, snapshot, spec] = await Promise.all([
      profile.scopeRunId === null
        ? null
        : this.#scopeProposal(owner, profile.scopeRunId),
      this.#boundarySummary(owner, run.id),
      profile.snapshotId === null
        ? null
        : this.#options.snapshots.get(owner, profile.snapshotId),
      this.#options.specs.get(owner, profile.proposalId, profile.specRevision),
    ]);
    if (snapshot === null || spec === null)
      return this.#fail(owner, profile, "source_unavailable");
    if (scope === null || summary === null)
      return this.#fail(owner, profile, "output_invalid");
    return this.#advance(owner, profile, {
      status: "ready",
      profile: buildComplexityProfile({
        ticket: profile.ticket,
        spec: spec.draft,
        facts: snapshot.facts,
        scope,
        slice: summary,
      }),
    });
  }

  /**
   * A run enqueued or found. `"full"` at the organization's cap; null when
   * the snapshot, or the run another names, is not there to run against.
   */
  async #enqueue(
    owner: string,
    snapshotId: string,
    input: Pick<Parameters<AnalysisRunStore["enqueue"]>[2], "tool" | "params">,
  ): Promise<StoredAnalysisRun | "full" | null> {
    const result = await enqueueAnalysis(
      {
        runs: this.#options.runs,
        removeObject: this.#options.removeObject,
        onQueued: () => {
          this.#wanted = true;
        },
      },
      owner,
      snapshotId,
      {
        ...input,
        requestedBy: null,
        maxActive: Math.max(1, (this.#options.maxActive ?? 3) - 1),
      },
    );
    if (!result.ok) return result.reason === "run_limit" ? "full" : null;
    return result.run;
  }

  async #run(
    owner: string,
    runId: string | null,
  ): Promise<StoredAnalysisRun | null> {
    return runId === null ? null : this.#options.runs.get(owner, runId);
  }

  /** The scope run's recorded proposal, as its artifact's `meta` carries it. */
  async #scopeProposal(
    owner: string,
    runId: string,
  ): Promise<ScopeProposalDto | null> {
    const artifact = (await this.#options.artifacts.list(owner, runId)).find(
      (candidate) => candidate.kind === "scope_proposal",
    );
    const parsed = scopeProposalSchema.safeParse(artifact?.meta);
    return parsed.success ? parsed.data : null;
  }

  /** The slice's bounded summary, as its boundary contract's `meta` carries it. */
  async #boundarySummary(owner: string, runId: string) {
    const artifact = (await this.#options.artifacts.list(owner, runId)).find(
      (candidate) => candidate.kind === "boundary_contract",
    );
    const parsed = sliceBoundarySummarySchema.safeParse(artifact?.meta);
    return parsed.success ? parsed.data : null;
  }

  async #advance(
    owner: string,
    profile: StoredBountyProfile,
    to: Parameters<BountyProfileStore["advance"]>[3],
  ): Promise<Step> {
    // A row another sweep moved first is simply looked at again next time.
    return (await this.#options.profiles.advance(
      owner,
      profile.id,
      profile.status,
      to,
    ))
      ? MOVED
      : WAIT;
  }

  #fail(
    owner: string,
    profile: StoredBountyProfile,
    errorCode: ProfileErrorCode,
    runErrorCode: AnalysisErrorCode | null = null,
  ): Promise<Step> {
    return this.#advance(owner, profile, {
      status: "failed",
      errorCode,
      runErrorCode,
    });
  }
}
