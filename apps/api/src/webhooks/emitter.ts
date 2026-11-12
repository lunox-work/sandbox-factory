/**
 * Turning what happened into webhook events, owed to the endpoints that
 * take them.
 *
 * Where each event comes from:
 *
 * - `run.finished`, `proposal.priced` and `sandbox.build.finished`: the
 *   change channel (`RUN_CHANGED_CHANNEL`, which `events.ts` follows too).
 *   On each analysis or sizing run change the run is read; a run in a
 *   terminal state is `run.finished`, a sandbox build or starter run is
 *   also `sandbox.build.finished`, and each proposal a sizing run made is
 *   `proposal.priced`. Like the pages, a change lost to a restart is lost.
 * - `sandbox.published`: the publish route, once the version is published.
 * - `writeback.failed`: the Jira writeback worker, once it fails one.
 *
 * **Once per event, whatever saw it.** An event's id is derived from what
 * it is about (`eventId`), and a delivery is unique per endpoint and event,
 * so every API process hearing the same change, or the same run changing
 * twice after it ended, owes each endpoint one delivery.
 *
 * Payloads are `{ id, type, createdAt, organizationId, data }`, `data`
 * holding ids and states only; the receiver reads the rest through the
 * API, where every access rule still applies.
 */

import { createHash } from "node:crypto";

import type {
  AnalysisRunStore,
  BountyRunStore,
  RunChange,
  SandboxStore,
  WebhookStore,
} from "@sandbox-factory/db";
import type { WebhookEventType } from "@sandbox-factory/shared";

/** A stable id for the event `type` about `key` in an organization. */
export function eventId(
  organizationId: string,
  type: string,
  key: string,
): string {
  const digest = createHash("sha256")
    .update(`${organizationId}\n${type}\n${key}`, "utf8")
    .digest("hex");
  return `evt_${digest.slice(0, 32)}`;
}

/** The body of a delivery. */
export function eventPayload(
  id: string,
  type: string,
  organizationId: string,
  createdAt: Date,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    type,
    createdAt: createdAt.toISOString(),
    organizationId,
    data,
  };
}

const ANALYSIS_ENDED = new Set(["succeeded", "failed"]);
const SIZING_ENDED = new Set(["succeeded", "partial", "failed"]);
const BUILD_TOOLS = new Set(["sandbox_build", "sandbox_starter"]);

export interface WebhookEmitterOptions {
  readonly store: Pick<WebhookStore, "enqueue">;
  readonly analysisRuns?: Pick<AnalysisRunStore, "get"> | undefined;
  readonly bountyRuns?: Pick<BountyRunStore, "get"> | undefined;
  /** To name a built version's sandbox; without it the id is left out. */
  readonly sandboxes?: Pick<SandboxStore, "getVersion"> | undefined;
  /** Something was enqueued: the sender should look now. */
  readonly onEnqueued?: (() => void) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((code: string) => void) | undefined;
}

export class WebhookEmitter {
  readonly #options: WebhookEmitterOptions;

  constructor(options: WebhookEmitterOptions) {
    this.#options = options;
  }

  /**
   * Owes the event `type` about `key` to the organization's endpoints that
   * take it; how many deliveries that made. Never throws: a failure is
   * reported and the event is lost, as a missed change would be.
   */
  async emit(
    organizationId: string,
    type: WebhookEventType,
    key: string,
    data: Record<string, unknown>,
  ): Promise<number> {
    try {
      const at = (this.#options.now ?? (() => new Date()))();
      const id = eventId(organizationId, type, key);
      const made = await this.#options.store.enqueue(
        organizationId,
        { id, type, payload: eventPayload(id, type, organizationId, at, data) },
        at,
      );
      if (made.length > 0) this.#options.onEnqueued?.();
      return made.length;
    } catch {
      this.#options.onError?.("webhook_emit_failed");
      return 0;
    }
  }

  /** What a change on the run channel says, as events. */
  async onRunChange(change: RunChange): Promise<void> {
    try {
      if (change.kind === "analysis") await this.#analysis(change);
      else if (change.kind === "bounty") await this.#sizing(change);
    } catch {
      this.#options.onError?.("webhook_run_change_failed");
    }
  }

  async #analysis({ organizationId, id }: RunChange): Promise<void> {
    const run = await this.#options.analysisRuns?.get(organizationId, id);
    if (run === undefined || run === null || !ANALYSIS_ENDED.has(run.status))
      return;
    await this.emit(organizationId, "run.finished", `analysis:${run.id}`, {
      run: {
        id: run.id,
        family: "analysis",
        kind: run.tool,
        status: run.status,
        errorCode: run.errorCode,
      },
    });
    if (!BUILD_TOOLS.has(run.tool) || !("sandboxVersionId" in run.params))
      return;
    const versionId = run.params.sandboxVersionId;
    const found = await this.#options.sandboxes?.getVersion(
      organizationId,
      versionId,
    );
    await this.emit(organizationId, "sandbox.build.finished", run.id, {
      runId: run.id,
      sandboxId: found?.version.sandboxId ?? null,
      sandboxVersionId: versionId,
      status: run.status,
    });
  }

  async #sizing({ organizationId, id }: RunChange): Promise<void> {
    const run = await this.#options.bountyRuns?.get(organizationId, id);
    if (run === undefined || run === null || !SIZING_ENDED.has(run.status))
      return;
    await this.emit(organizationId, "run.finished", `sizing:${run.id}`, {
      run: {
        id: run.id,
        family: "sizing",
        kind: run.kind,
        status: run.status,
        bountyId: run.bountyId,
        errorCode: run.fatalErrorCode,
      },
    });
    for (const outcome of run.outcomes) {
      if (outcome.status !== "proposed" || outcome.proposalId === undefined)
        continue;
      await this.emit(
        organizationId,
        "proposal.priced",
        `${outcome.proposalId}:${run.id}`,
        {
          proposalId: outcome.proposalId,
          bountyId: outcome.bountyId ?? null,
          runId: run.id,
          status: "proposed",
        },
      );
    }
  }
}
