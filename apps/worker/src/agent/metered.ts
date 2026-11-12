/**
 * The agent model, metered for one run: each turn's tokens are written to
 * the token ledger (`model-usage.ts` in packages/db) against the run's
 * workspace and the run, as the reply comes back. Every agent a run starts
 * (scope, fixtures, starter, hidden tests, pseudonyms, the calibration's
 * reference run) asks through the model it is handed, so wrapping it once
 * per claimed run records them all.
 *
 * Recording is the truth the monthly quota counts. The quota itself is
 * admission, checked when a run is queued: nothing here stops a run, so one
 * already under way finishes past the limit and the next one is refused.
 */

import type { ModelUsageStore } from "@sandbox-factory/db";

import type { AgentModel, AgentSettings } from "./loop.js";

/** What a reply is recorded against. */
export interface MeteredRun {
  readonly organizationId: string;
  readonly id: string;
  readonly tool: string;
}

export function meteredModel(
  model: AgentModel,
  run: MeteredRun,
  ledger: Pick<ModelUsageStore, "record">,
  /** Told of a ledger write that failed; the turn's answer is kept. */
  onError: (code: string, error: unknown) => void,
): AgentModel {
  return {
    model: model.model,
    async turn(request, signal) {
      const reply = await model.turn(request, signal);
      // A write that fails costs the run nothing: the turn is paid for,
      // and failing the run would throw its work away.
      await ledger
        .record(run.organizationId, {
          runFamily: "analysis",
          runId: run.id,
          kind: run.tool,
          model: reply.model ?? model.model,
          inputTokens: reply.usage.inputTokens,
          outputTokens: reply.usage.outputTokens,
          cacheReadTokens: reply.usage.cacheReadTokens,
          cacheWriteTokens: reply.usage.cacheWriteTokens,
        })
        .catch((error: unknown) => onError("model_usage_record_failed", error));
      return reply;
    },
  };
}

/** The worker's agent settings for one run; unchanged with no model. */
export function meteredAgent(
  agent: AgentSettings,
  run: MeteredRun,
  ledger: Pick<ModelUsageStore, "record">,
  onError: (code: string, error: unknown) => void,
): AgentSettings {
  return agent.model === null
    ? agent
    : { ...agent, model: meteredModel(agent.model, run, ledger, onError) };
}
