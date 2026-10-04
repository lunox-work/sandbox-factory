import assert from "node:assert/strict";
import { test } from "node:test";

import type { BountySizingResult } from "sandbox-factory";

import {
  FakeCaller,
  SizerError,
  type StructuredResult,
} from "../src/sizing/caller.js";
import { FallbackCaller } from "../src/sizing/fallback.js";
import { sizeBountyTool } from "../src/sizing/tools/size-bounty.js";

const input = {
  summary: "Add CSV export",
  descriptionText: "Export the filtered table.",
  issueType: "Story",
};

function sized(actualModel: string): StructuredResult<BountySizingResult> {
  return {
    result: {
      complexity: "S",
      confidence: "high",
      rationale: "A localized change.",
    },
    actualModel,
    usage: { inputTokens: 5, outputTokens: 3 },
  };
}

/** A provider with a queue of answers to the one tool these tests call. */
function provider(
  model: string,
  answers: Array<StructuredResult<BountySizingResult> | Error>,
): FakeCaller {
  return new FakeCaller(model, { size_bounty: answers });
}

test("the primary answers alone while it succeeds", async () => {
  const fallback = provider("deepseek", []);
  const caller = new FallbackCaller({
    primary: provider("anthropic", [sized("anthropic")]),
    fallback,
  });

  assert.equal(
    (await caller.call(sizeBountyTool, input)).actualModel,
    "anthropic",
  );
  assert.equal(fallback.calls.length, 0);
  // The reported model is the primary's; `actualModel` carries the truth.
  assert.equal(caller.model, "anthropic");
});

test("a provider failure hands the same bounty to the fallback", async () => {
  const handovers: string[] = [];
  const fallback = provider("deepseek", [sized("deepseek")]);
  const caller = new FallbackCaller({
    primary: provider("anthropic", [new SizerError("sizing_provider", false)]),
    fallback,
    onFallback: (code) => handovers.push(code),
  });

  assert.equal(
    (await caller.call(sizeBountyTool, input)).actualModel,
    "deepseek",
  );
  assert.deepEqual(fallback.inputsFor("size_bounty"), [input]);
  assert.deepEqual(handovers, ["sizing_provider"]);
});

test("a configuration failure falls back rather than stopping the run", async () => {
  // `sizing_configuration` is `stopsRun`, and is exactly what an exhausted or
  // revoked key looks like — the case the fallback exists for.
  const caller = new FallbackCaller({
    primary: provider("anthropic", [
      new SizerError("sizing_configuration", true),
    ]),
    fallback: provider("deepseek", [sized("deepseek")]),
  });

  assert.equal(
    (await caller.call(sizeBountyTool, input)).actualModel,
    "deepseek",
  );
});

test("cancellation is never retried on the fallback", async () => {
  const fallback = provider("deepseek", [sized("deepseek")]);
  const caller = new FallbackCaller({
    primary: provider("anthropic", [new SizerError("sizing_cancelled", false)]),
    fallback,
  });

  await assert.rejects(
    caller.call(sizeBountyTool, input),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_cancelled",
  );
  assert.equal(fallback.calls.length, 0);
});

test("an aborted signal stops the handover even on another error code", async () => {
  const controller = new AbortController();
  const fallback = provider("deepseek", [sized("deepseek")]);
  const caller = new FallbackCaller({
    primary: {
      model: "anthropic",
      call: () => {
        controller.abort();
        return Promise.reject(new SizerError("sizing_timeout", false));
      },
    },
    fallback,
  });

  await assert.rejects(
    caller.call(sizeBountyTool, input, { signal: controller.signal }),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_cancelled",
  );
  assert.equal(fallback.calls.length, 0);
});

test("when both providers fail the fallback's error is what propagates", async () => {
  // The `stopsRun` contract stays honest: the run stops only if the provider
  // that had the last word says it should.
  const caller = new FallbackCaller({
    primary: provider("anthropic", [
      new SizerError("sizing_configuration", true),
    ]),
    fallback: provider("deepseek", [new SizerError("sizing_provider", false)]),
  });

  await assert.rejects(
    caller.call(sizeBountyTool, input),
    (error: unknown) =>
      error instanceof SizerError &&
      error.code === "sizing_provider" &&
      !error.stopsRun,
  );
});
