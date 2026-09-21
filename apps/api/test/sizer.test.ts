import assert from "node:assert/strict";
import { test } from "node:test";

import { AnthropicSizer } from "../src/sizing/anthropic.js";
import { FakeSizer, SizerError } from "../src/sizing/sizer.js";

const input = {
  summary: "Add CSV export",
  descriptionText: "Export the filtered table.",
  issueType: "Story",
};

function message(toolInput: unknown, overrides: Record<string, unknown> = {}) {
  return {
    model: "actual-model",
    content: [{ type: "tool_use", name: "size_bounty", input: toolInput }],
    usage: { input_tokens: 12, output_tokens: 8 },
    ...overrides,
  };
}

test("forced tool output is validated and returns actual usage metadata", async () => {
  const calls: Record<string, unknown>[] = [];
  const sizer = new AnthropicSizer({
    model: "requested-model",
    messages: {
      create: (params) => {
        calls.push(params);
        return Promise.resolve(
          message({
            complexity: "M",
            confidence: "high",
            rationale: "A bounded change across a few files.",
          }),
        );
      },
    },
  });

  const sized = await sizer.size(input);
  assert.equal(sized.result.complexity, "M");
  assert.equal(sized.actualModel, "actual-model");
  assert.deepEqual(sized.usage, { inputTokens: 12, outputTokens: 8 });
  assert.equal(calls[0]?.["max_tokens"], 1_024);
  assert.deepEqual(calls[0]?.["tool_choice"], {
    type: "tool",
    name: "size_bounty",
    disable_parallel_tool_use: true,
  });
});

test("malformed output gets one generic retry and never echoes model text", async () => {
  const prompts: string[] = [];
  const responses = [
    message({ complexity: "gigantic", rationale: "malformed secret text" }),
    message({
      complexity: "S",
      confidence: "medium",
      rationale: "A localized change.",
    }),
  ];
  const sizer = new AnthropicSizer({
    model: "requested-model",
    messages: {
      create: (params) => {
        const messages = params["messages"] as { content: string }[];
        prompts.push(messages[0]?.content ?? "");
        return Promise.resolve(responses.shift() ?? message(null));
      },
    },
  });

  assert.equal((await sizer.size(input)).result.complexity, "S");
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[1]?.includes("malformed secret text"));
});

test("multiple or unexpected tool results fail after two requests", async () => {
  let calls = 0;
  const sizer = new AnthropicSizer({
    model: "requested-model",
    messages: {
      create: () => {
        calls += 1;
        return Promise.resolve(
          message(
            {},
            {
              content: [
                { type: "tool_use", name: "wrong", input: {} },
                { type: "tool_use", name: "size_bounty", input: {} },
              ],
            },
          ),
        );
      },
    },
  });

  await assert.rejects(
    sizer.size(input),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_invalid_output",
  );
  assert.equal(calls, 2);
});

test("a transient response retries once and respects Retry-After", async () => {
  const waits: number[] = [];
  let calls = 0;
  const transient = Object.assign(new Error("upstream body stays private"), {
    status: 429,
    headers: new Headers({ "retry-after": "2" }),
  });
  const sizer = new AnthropicSizer({
    model: "requested-model",
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
    messages: {
      create: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(transient)
          : Promise.resolve(
              message({
                complexity: "L",
                confidence: "low",
                rationale: "Cross-module work with unknowns.",
              }),
            );
      },
    },
  });

  assert.equal((await sizer.size(input)).result.complexity, "L");
  assert.deepEqual(waits, [2_000]);
  assert.equal(calls, 2);
});

test("authentication and invalid-model failures stop the run without retry", async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const sizer = new AnthropicSizer({
      model: "requested-model",
      messages: {
        create: () => {
          calls += 1;
          return Promise.reject(
            Object.assign(new Error("private"), { status }),
          );
        },
      },
    });
    await assert.rejects(
      sizer.size(input),
      (error: unknown) =>
        error instanceof SizerError &&
        error.code === "sizing_configuration" &&
        error.stopsRun,
    );
    assert.equal(calls, 1);
  }
});

test("external cancellation is classified without a provider request", async () => {
  const controller = new AbortController();
  controller.abort();
  const sizer = new AnthropicSizer({
    model: "requested-model",
    messages: { create: () => Promise.resolve(message({})) },
  });
  await assert.rejects(
    sizer.size(input, { signal: controller.signal }),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_cancelled",
  );
});

test("a retry that cannot fit before the run deadline becomes a timeout", async () => {
  const sizer = new AnthropicSizer({
    model: "requested-model",
    now: () => 1_000,
    messages: {
      create: () =>
        Promise.reject(
          Object.assign(new Error("private"), {
            status: 429,
            headers: new Headers({ "retry-after": "10" }),
          }),
        ),
    },
  });
  await assert.rejects(
    sizer.size(input, { deadlineAt: new Date(5_000) }),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_timeout",
  );
});

test("FakeSizer records inputs and returns queued answers", async () => {
  const answer = {
    result: {
      complexity: "S" as const,
      confidence: "high" as const,
      rationale: "Small.",
    },
    actualModel: "fake",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const fake = new FakeSizer("fake", "test-v1", [answer]);
  assert.equal((await fake.size(input)).result.complexity, "S");
  assert.deepEqual(fake.calls, [input]);
  await assert.rejects(fake.size(input), /no answer/);
});
