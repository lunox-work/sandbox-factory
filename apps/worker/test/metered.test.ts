import assert from "node:assert/strict";
import { test } from "node:test";

import type { NewModelUsage } from "@sandbox-factory/db";

import type { AgentModel, AgentTurn } from "../src/agent/loop.js";
import { AGENT_LIMITS_DEFAULT, runAgent } from "../src/agent/loop.js";
import { meteredAgent, meteredModel } from "../src/agent/metered.js";

/**
 * Each turn an agent takes is written to the token ledger, against the
 * claimed run's workspace and the run, as the reply comes back.
 */

const run = { organizationId: "org_1", id: "arn_1", tool: "scope" };
const signal = new AbortController().signal;
const request = {
  system: "s",
  tools: [],
  messages: [],
  effort: "high" as const,
};

const turn = (overrides: Partial<AgentTurn> = {}): AgentTurn => ({
  content: [],
  stopReason: "end_turn",
  usage: {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 900,
    cacheWriteTokens: 30,
  },
  ...overrides,
});

/** A model answering `turns` in order, and a ledger recording every write. */
function scripted(turns: AgentTurn[]) {
  const model: AgentModel = {
    model: "configured-model",
    turn: () => {
      const next = turns.shift();
      return next === undefined
        ? Promise.reject(new Error("no turn left"))
        : Promise.resolve(next);
    },
  };
  const rows: Array<{ organizationId: string; entry: NewModelUsage }> = [];
  const ledger = {
    record: (organizationId: string, entry: NewModelUsage) => {
      rows.push({ organizationId, entry });
      return Promise.resolve();
    },
  };
  return { model, rows, ledger };
}

test("a turn's tokens are one ledger row against the run, and its reply is unchanged", async () => {
  const answered = turn({ model: "answering-model" });
  const { model, rows, ledger } = scripted([answered]);
  const metered = meteredModel(model, run, ledger, () => {
    throw new Error("no failure expected");
  });
  assert.equal(metered.model, "configured-model");
  assert.equal(await metered.turn(request, signal), answered);
  assert.deepEqual(rows, [
    {
      organizationId: "org_1",
      entry: {
        runFamily: "analysis",
        runId: "arn_1",
        kind: "scope",
        model: "answering-model",
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 900,
        cacheWriteTokens: 30,
      },
    },
  ]);
});

test("a reply that names no model is recorded as the configured one", async () => {
  const { model, rows, ledger } = scripted([turn()]);
  await meteredModel(model, run, ledger, () => {}).turn(request, signal);
  assert.equal(rows[0]?.entry.model, "configured-model");
});

test("a ledger write that fails is reported, and the turn's answer is kept", async () => {
  const answered = turn();
  const { model } = scripted([answered]);
  const failures: string[] = [];
  const metered = meteredModel(
    model,
    run,
    { record: () => Promise.reject(new Error("database down")) },
    (code) => failures.push(code),
  );
  assert.equal(await metered.turn(request, signal), answered);
  assert.deepEqual(failures, ["model_usage_record_failed"]);
});

test("a turn that fails records nothing: no reply, no usage to count", async () => {
  const { model, rows, ledger } = scripted([]);
  await assert.rejects(
    meteredModel(model, run, ledger, () => {}).turn(request, signal),
    /no turn left/,
  );
  assert.deepEqual(rows, []);
});

test("a run's agent is metered; a worker with no model is left as it is", () => {
  const { model, ledger } = scripted([]);
  const limits = AGENT_LIMITS_DEFAULT;
  const none = { model: null, limits };
  assert.equal(
    meteredAgent(none, run, ledger, () => {}),
    none,
  );
  const metered = meteredAgent({ model, limits }, run, ledger, () => {});
  assert.notEqual(metered.model, model);
  assert.equal(metered.model?.model, "configured-model");
  assert.equal(metered.limits, limits);
});

test("every turn of an agent's loop is recorded, the last one included", async () => {
  const call = (id: string, name: string) => ({
    type: "tool_use",
    id,
    name,
    input: {},
  });
  const { model, rows, ledger } = scripted([
    turn({
      stopReason: "tool_use",
      content: [call("t1", "look")] as AgentTurn["content"],
    }),
    turn({
      stopReason: "tool_use",
      content: [call("t2", "submit")] as AgentTurn["content"],
    }),
  ]);
  const outcome = await runAgent({
    model: meteredModel(model, run, ledger, () => {}),
    system: "s",
    prompt: "p",
    tools: [
      {
        name: "look",
        description: "Look.",
        inputSchema: { properties: {}, required: [] },
        run: () => Promise.resolve({ content: "seen" }),
      },
      {
        name: "submit",
        description: "Submit.",
        inputSchema: { properties: {}, required: [] },
        run: () => Promise.resolve({ content: "ok", accepted: true }),
      },
    ],
    submitTool: "submit",
    limits: AGENT_LIMITS_DEFAULT,
    signal,
    log: () => {},
  });
  assert.equal(outcome.stopped, "accepted");
  assert.equal(rows.length, 2);
  // What the loop counts and what the ledger holds are the same tokens.
  const recorded = rows.reduce(
    (sum, { entry }) =>
      sum +
      entry.inputTokens +
      entry.outputTokens +
      entry.cacheReadTokens +
      entry.cacheWriteTokens,
    0,
  );
  assert.equal(
    recorded,
    outcome.usage.inputTokens +
      outcome.usage.outputTokens +
      outcome.usage.cacheReadTokens +
      outcome.usage.cacheWriteTokens,
  );
});
