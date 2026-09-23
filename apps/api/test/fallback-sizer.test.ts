import assert from "node:assert/strict";
import { test } from "node:test";

import { FallbackSizer } from "../src/sizing/fallback.js";
import {
  FakeSizer,
  SizerError,
  type SizedTicket,
} from "../src/sizing/sizer.js";

const input = {
  summary: "Add CSV export",
  descriptionText: "Export the filtered table.",
  issueType: "Story",
};

function sized(actualModel: string): SizedTicket {
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

test("the primary answers alone while it succeeds", async () => {
  const fallback = new FakeSizer("deepseek", "jira-size-v2", []);
  const sizer = new FallbackSizer({
    primary: new FakeSizer("anthropic", "jira-size-v2", [sized("anthropic")]),
    fallback,
  });

  assert.equal((await sizer.size(input)).actualModel, "anthropic");
  assert.equal(fallback.calls.length, 0);
  // The reported model is the primary's; `actualModel` carries the truth.
  assert.equal(sizer.model, "anthropic");
});

test("a provider failure hands the same ticket to the fallback", async () => {
  const handovers: string[] = [];
  const fallback = new FakeSizer("deepseek", "jira-size-v2", [
    sized("deepseek"),
  ]);
  const sizer = new FallbackSizer({
    primary: new FakeSizer("anthropic", "jira-size-v2", [
      new SizerError("sizing_provider", false),
    ]),
    fallback,
    onFallback: (code) => handovers.push(code),
  });

  assert.equal((await sizer.size(input)).actualModel, "deepseek");
  assert.deepEqual(fallback.calls, [input]);
  assert.deepEqual(handovers, ["sizing_provider"]);
});

test("a configuration failure falls back rather than stopping the run", async () => {
  // `sizing_configuration` is `stopsRun`, and is exactly what an exhausted or
  // revoked key looks like — the case the fallback exists for.
  const sizer = new FallbackSizer({
    primary: new FakeSizer("anthropic", "jira-size-v2", [
      new SizerError("sizing_configuration", true),
    ]),
    fallback: new FakeSizer("deepseek", "jira-size-v2", [sized("deepseek")]),
  });

  assert.equal((await sizer.size(input)).actualModel, "deepseek");
});

test("cancellation is never retried on the fallback", async () => {
  const fallback = new FakeSizer("deepseek", "jira-size-v2", [
    sized("deepseek"),
  ]);
  const sizer = new FallbackSizer({
    primary: new FakeSizer("anthropic", "jira-size-v2", [
      new SizerError("sizing_cancelled", false),
    ]),
    fallback,
  });

  await assert.rejects(
    sizer.size(input),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_cancelled",
  );
  assert.equal(fallback.calls.length, 0);
});

test("an aborted signal stops the handover even on another error code", async () => {
  const controller = new AbortController();
  const fallback = new FakeSizer("deepseek", "jira-size-v2", [
    sized("deepseek"),
  ]);
  const sizer = new FallbackSizer({
    primary: {
      model: "anthropic",
      promptVersion: "jira-size-v2",
      size: () => {
        controller.abort();
        return Promise.reject(new SizerError("sizing_timeout", false));
      },
    },
    fallback,
  });

  await assert.rejects(
    sizer.size(input, { signal: controller.signal }),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_cancelled",
  );
  assert.equal(fallback.calls.length, 0);
});

test("when both providers fail the fallback's error is what propagates", async () => {
  // The `stopsRun` contract stays honest: the run stops only if the provider
  // that had the last word says it should.
  const sizer = new FallbackSizer({
    primary: new FakeSizer("anthropic", "jira-size-v2", [
      new SizerError("sizing_configuration", true),
    ]),
    fallback: new FakeSizer("deepseek", "jira-size-v2", [
      new SizerError("sizing_provider", false),
    ]),
  });

  await assert.rejects(
    sizer.size(input),
    (error: unknown) =>
      error instanceof SizerError &&
      error.code === "sizing_provider" &&
      !error.stopsRun,
  );
});
