/**
 * Starts approved bounties' sandboxes before anyone asks for one: once a
 * profile is ready and its proposal approved at that spec revision, the
 * bounty's sandbox is made and its first version cut and built, exactly as
 * a Sandbox click starts one (`routes.ts`), as the person who approved the
 * price. The build's one model step, the hidden tests, then runs while
 * nobody waits for it, and a click finds the sandbox already there: its
 * button is gone, and the bounty shows the build.
 *
 * It runs for every approved bounty with no sandbox in a workspace that
 * has not turned `prepareSandboxes` off, which is model spend for a sandbox
 * that may never be published; the setting is the workspace's to weigh. A
 * bounty whose step is held, whose work touches no single repository or
 * whose price nobody approved is left for a person. A pass is prompted by
 * the profiler settling a profile and by an approval, and a timer catches
 * what this process did not see. A build refused at the organization's
 * analysis cap is asked for again as a pending cut, which the cutter makes
 * once a run is free (`cutter.ts`).
 *
 * What `slice` would refuse without a sandbox, a price that is not priced
 * or a title that cannot name a version (`cutRefusal`), is checked before
 * the sandbox is made: made and then refused, it would stay with no
 * version, and `unprepared` never lists a bounty with a sandbox again.
 *
 * A profile left for a person stays listed, pass after pass, and reading
 * its proposal, bounty and repositories again finds the same answer. A
 * timer pass skips one skipped before at the same `updatedAt`; a prompted
 * pass, which follows something that changed, reads them all again.
 *
 * The hidden-tests agent reads the generated project, whose repository
 * text can steer it, so a slice wider than `AUTO_SLICE_LIMITS` is started
 * only once an owner or admin approved it. The profiler holds such a one
 * `awaiting_approval`, which this never lists; a profile measured `ready`
 * from one before approvals were asked for is checked here, and moved to
 * `awaiting_approval` rather than started (`holdsForApproval`).
 */

import type {
  AnalysisRunStore,
  ArtifactStore,
  BountyProfileStore,
  BountyProposalStore,
  BountyStore,
  SandboxStore,
  StoredBountyProfile,
  StoredSandbox,
} from "@sandbox-factory/db";
import { stepHeldBy } from "sandbox-factory";

import type { versionService } from "./version-service.js";
import {
  cutRefusal,
  holdsForApproval,
  sliceApprovalOf,
} from "./version-service.js";

/** How often unprepared profiles are looked at without a prompt. */
export const PREPARE_SWEEP_MS = 60_000;
/**
 * How many organizations one pass works on at once. Profiles within one
 * stay in order: the pass stops at that organization's cap.
 */
export const PREPARE_CONCURRENCY = 4;

type Slice = ReturnType<typeof versionService>["slice"];

export interface SandboxPreparerOptions {
  readonly profiles: Pick<
    BountyProfileStore,
    "unprepared" | "organizationsWithUnprepared" | "holdSlice"
  >;
  /** The slice run and its summary, which say whether it waits for approval. */
  readonly runs: Pick<AnalysisRunStore, "get">;
  readonly artifacts: Pick<ArtifactStore, "list">;
  readonly proposals: Pick<BountyProposalStore, "get">;
  readonly bounties: Pick<BountyStore, "get">;
  readonly sandboxes: Pick<SandboxStore, "create" | "requestCut">;
  /** The one repository the bounty's work touches, as a click finds it. */
  readonly touchedSource: (
    owner: string,
    bountyId: string,
  ) => Promise<string | null>;
  readonly slice: (
    owner: string,
    actor: string,
    sandbox: StoredSandbox,
    now: Date,
  ) => ReturnType<Slice>;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly onError?: (code: string, error?: unknown) => void;
}

/** `task` on each item, at most `limit` at a time, taken in order. */
async function forEachLimited<T>(
  items: Iterable<T>,
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items[Symbol.iterator]();
  const worker = async () => {
    for (let step = queue.next(); !step.done; step = queue.next())
      await task(step.value);
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

export class SandboxPreparer {
  readonly #options: SandboxPreparerOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<void> | undefined;
  #again = false;
  #againPrompted = false;
  #stopped = false;
  /**
   * Profiles skipped by a pass, at the `updatedAt` they were skipped at.
   * Only what the pass still lists is kept, so it does not grow with the
   * profiles that left the listing.
   */
  #skipped = new Map<string, string>();

  constructor(options: SandboxPreparerOptions) {
    this.#options = options;
  }

  /** The first pass reads everything; the timer's skip what was skipped. */
  start(): void {
    if (this.#timer !== undefined) return;
    this.#stopped = false;
    this.kick();
    this.#timer = setInterval(
      () => this.#run(false),
      this.#options.intervalMs ?? PREPARE_SWEEP_MS,
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending?.catch(() => {});
  }

  /** A prompted pass now, or another straight after the one in progress. */
  kick(): void {
    this.#run(true);
  }

  #run(prompted: boolean): void {
    if (this.#stopped) return;
    void this.sweep(prompted).catch((error: unknown) =>
      this.#options.onError?.("sandbox_prepare_sweep_failed", error),
    );
  }

  /**
   * One pass over every organization with something unprepared. Prompted,
   * it forgets what earlier passes skipped and reads every profile again;
   * a timer pass leaves a profile skipped at the same `updatedAt` alone.
   * Asked for during a pass, a prompted one makes the next pass prompted.
   */
  async sweep(prompted = true): Promise<void> {
    if (this.#pending !== undefined) {
      this.#again = true;
      this.#againPrompted ||= prompted;
      return this.#pending;
    }
    const work = async () => {
      let forget = prompted;
      do {
        this.#again = false;
        this.#againPrompted = false;
        if (forget) this.#skipped.clear();
        await this.#pass();
        forget = this.#againPrompted;
      } while (this.#again);
    };
    this.#pending = work();
    try {
      await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }

  async #pass(): Promise<void> {
    const skipped = new Map<string, string>();
    await forEachLimited(
      await this.#options.profiles.organizationsWithUnprepared(),
      PREPARE_CONCURRENCY,
      async (owner) => {
        try {
          await this.#prepareOrganization(owner, skipped);
        } catch (error) {
          // Left for the next pass; the other organizations still move.
          this.#options.onError?.("sandbox_prepare_failed", error);
        }
      },
    );
    this.#skipped = skipped;
  }

  /** Stops at the organization's cap. */
  async #prepareOrganization(
    owner: string,
    skipped: Map<string, string>,
  ): Promise<void> {
    for (const profile of await this.#options.profiles.unprepared(owner)) {
      if (this.#skipped.get(profile.id) === profile.updatedAt) {
        skipped.set(profile.id, profile.updatedAt);
        continue;
      }
      const outcome = await this.#prepare(owner, profile);
      if (outcome === "full") break;
      // Started or with a sandbox, it leaves the listing by itself.
      if (outcome === "skipped") skipped.set(profile.id, profile.updatedAt);
    }
  }

  async #prepare(
    owner: string,
    profile: StoredBountyProfile,
  ): Promise<"started" | "full" | "skipped"> {
    if (profile.snapshotId === null || profile.sliceRunId === null)
      return "skipped";
    if (profile.sliceApprovedAt === null) {
      const approval = await sliceApprovalOf(
        this.#options,
        owner,
        profile.sliceRunId,
      );
      // Unreadable, it cannot be told within the limits: not started.
      if (approval === null) return "skipped";
      if (holdsForApproval(profile, approval)) {
        // Held only while still unapproved: an approval that landed since
        // this read stands, and the next pass starts it.
        await this.#options.profiles.holdSlice(owner, profile.id);
        return "skipped";
      }
    }
    const proposal = await this.#options.proposals.get(
      owner,
      profile.proposalId,
    );
    if (proposal === null || proposal.decidedBy === null) return "skipped";
    const [bounty, sourceRepoId] = await Promise.all([
      this.#options.bounties.get(owner, proposal.bountyId),
      this.#options.touchedSource(owner, proposal.bountyId),
    ]);
    if (bounty === null || stepHeldBy("sandbox", bounty, proposal) !== null)
      return "skipped";
    // Several repositories, or none connected: a person picks.
    if (sourceRepoId === null) return "skipped";
    // What the cut would refuse is refused before there is a sandbox.
    if (cutRefusal(bounty, proposal) !== null) return "skipped";
    const made = await this.#options.sandboxes.create(owner, {
      bountyId: bounty.id,
      sourceRepoId,
    });
    if (!made.ok) {
      // A click made it first.
      if (made.reason !== "bounty_has_sandbox")
        this.#options.onError?.(`sandbox_prepare_${made.reason}`);
      return "skipped";
    }
    const now = (this.#options.now ?? (() => new Date()))();
    const actor = proposal.decidedBy;
    const sliced = await this.#options.slice(owner, actor, made.sandbox, now);
    if (sliced.ok) return "started";
    const code = "code" in sliced.body ? sliced.body.code : undefined;
    if (code === "run_limit") {
      // The draft is cut; the cutter builds it once a run is free.
      await this.#options.sandboxes.requestCut(
        owner,
        made.sandbox.id,
        actor,
        now,
      );
      return "full";
    }
    // Refused once made: the sandbox stays, with no version, for a person.
    this.#options.onError?.(
      `sandbox_prepare_${String(code)}`,
      new Error(
        `Sandbox ${made.sandbox.id} for bounty ${bounty.id} was made, but its version was refused: ${
          "error" in sliced.body ? String(sliced.body.error) : String(code)
        }`,
      ),
    );
    return "skipped";
  }
}
