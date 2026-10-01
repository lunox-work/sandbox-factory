import assert from "node:assert/strict";
import { test } from "node:test";

import { AnthropicCaller, toStrictSchema } from "../src/sizing/anthropic.js";
import { FakeCaller, SizerError } from "../src/sizing/caller.js";
import { sizeBountyTool } from "../src/sizing/tools/size-bounty.js";

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
  const caller = new AnthropicCaller({
    model: "requested-model",
    messages: {
      create: (params) => {
        calls.push(params);
        return Promise.resolve(
          message({
            complexity: "XS",
            confidence: "high",
            rationale: "A bounded change across a few files.",
          }),
        );
      },
    },
  });

  const sized = await caller.call(sizeBountyTool, input);
  assert.equal(sized.result.complexity, "XS");
  assert.equal(sized.actualModel, "actual-model");
  assert.deepEqual(sized.usage, { inputTokens: 12, outputTokens: 8 });
  assert.equal(calls[0]?.["max_tokens"], 1_024);
  assert.match(
    JSON.stringify(calls[0]?.["tools"]),
    /"enum":\["XS","S","M","L","XL","unsized"\]/,
  );
  // A strict tool schema with length keywords is a 400 at Anthropic, so
  // the limits the tool declares travel as prose instead.
  assert.doesNotMatch(
    JSON.stringify(calls[0]?.["tools"]),
    /minLength|maxLength/,
  );
  const tools = calls[0]?.["tools"] as {
    strict: boolean;
    input_schema: { properties: Record<string, { description?: string }> };
  }[];
  assert.equal(tools[0]?.strict, true);
  assert.equal(
    tools[0]?.input_schema.properties["rationale"]?.description,
    "Non-empty, at most 500 characters.",
  );
  assert.equal(calls[0]?.["system"], sizeBountyTool.system);
  assert.deepEqual(calls[0]?.["tool_choice"], {
    type: "tool",
    name: "size_bounty",
    disable_parallel_tool_use: true,
  });
});

test("malformed output gets one retry that names the field and never echoes model text", async () => {
  const prompts: string[] = [];
  const responses = [
    message({ complexity: "gigantic", rationale: "malformed secret text" }),
    message({
      complexity: "S",
      confidence: "medium",
      rationale: "A localized change.",
    }),
  ];
  const caller = new AnthropicCaller({
    model: "requested-model",
    messages: {
      create: (params) => {
        const messages = params["messages"] as { content: string }[];
        prompts.push(messages[0]?.content ?? "");
        return Promise.resolve(responses.shift() ?? message(null));
      },
    },
  });

  const sized = await caller.call(sizeBountyTool, input);
  assert.equal(sized.result.complexity, "S");
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[1]?.includes("malformed secret text"));
  assert.ok(!prompts[1]?.includes("gigantic"));
  // The first request is the data alone; the retry says what was wrong.
  assert.match(prompts[0] ?? "", /^Ticket data:/);
  assert.match(
    prompts[1] ?? "",
    /^The previous result was invalid: complexity must be one of: XS, S, M, L, XL, unsized\. Return exactly one valid size_bounty call\.\n\nTicket data:/,
  );
  // Both attempts reached the model, so both are in the bill.
  assert.deepEqual(sized.usage, { inputTokens: 24, outputTokens: 16 });
});

test("an answer the output limit cut short is retried as such", async () => {
  const prompts: string[] = [];
  const responses = [
    // The limit ends the turn mid-call: the block is there, its input is not.
    message({ complexity: "S" }, { stop_reason: "max_tokens" }),
    message({
      complexity: "S",
      confidence: "medium",
      rationale: "A localized change.",
    }),
  ];
  const caller = new AnthropicCaller({
    model: "requested-model",
    messages: {
      create: (params) => {
        const messages = params["messages"] as { content: string }[];
        prompts.push(messages[0]?.content ?? "");
        return Promise.resolve(responses.shift() ?? message(null));
      },
    },
  });

  assert.equal(
    (await caller.call(sizeBountyTool, input)).result.complexity,
    "S",
  );
  assert.match(prompts[1] ?? "", /cut off at the output limit/);
});

test("a transient failure retries with the data alone", async () => {
  // Nothing was wrong with an answer that never arrived, so the retry does
  // not tell the model its previous result was invalid.
  const prompts: string[] = [];
  let calls = 0;
  const caller = new AnthropicCaller({
    model: "requested-model",
    sleep: () => Promise.resolve(),
    messages: {
      create: (params) => {
        calls += 1;
        const messages = params["messages"] as { content: string }[];
        prompts.push(messages[0]?.content ?? "");
        return calls === 1
          ? Promise.reject(Object.assign(new Error("private"), { status: 503 }))
          : Promise.resolve(
              message({
                complexity: "S",
                confidence: "high",
                rationale: "A localized change.",
              }),
            );
      },
    },
  });

  await caller.call(sizeBountyTool, input);
  assert.equal(prompts[0], prompts[1]);
});

test("multiple or unexpected tool results fail after two requests", async () => {
  let calls = 0;
  const caller = new AnthropicCaller({
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
    caller.call(sizeBountyTool, input),
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
  const caller = new AnthropicCaller({
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

  assert.equal(
    (await caller.call(sizeBountyTool, input)).result.complexity,
    "L",
  );
  assert.deepEqual(waits, [2_000]);
  assert.equal(calls, 2);
});

test("authentication and invalid-model failures stop the run without retry", async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const caller = new AnthropicCaller({
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
      caller.call(sizeBountyTool, input),
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
  const caller = new AnthropicCaller({
    model: "requested-model",
    messages: { create: () => Promise.resolve(message({})) },
  });
  await assert.rejects(
    caller.call(sizeBountyTool, input, { signal: controller.signal }),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_cancelled",
  );
});

test("a retry that cannot fit before the run deadline becomes a timeout", async () => {
  const caller = new AnthropicCaller({
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
    caller.call(sizeBountyTool, input, { deadlineAt: new Date(5_000) }),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_timeout",
  );
});

test("an attempt is given the time its tool asks for, inside the run's deadline", async () => {
  // A slow tool's attempt must outlive a quick one's, and neither may
  // outlive the run. The provider here never answers; only the abort ends it.
  const never = {
    create: (_params: unknown, options?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
  };
  const patient = { ...sizeBountyTool, attemptTimeoutMs: 60_000 };

  const started = Date.now();
  await assert.rejects(
    new AnthropicCaller({
      model: "requested-model",
      messages: never,
      sleep: () => Promise.resolve(),
    }).call({ ...patient, attemptTimeoutMs: 5 }, input),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_timeout",
  );
  assert.ok(Date.now() - started < 5_000);

  // The deadline wins over a patient tool.
  await assert.rejects(
    new AnthropicCaller({ model: "requested-model", messages: never }).call(
      patient,
      input,
      { deadlineAt: new Date(Date.now() + 5) },
    ),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_timeout",
  );
  assert.ok(Date.now() - started < 5_000);

  // And a caller's own override wins over every tool's, which is what a
  // test uses to keep a timeout short.
  await assert.rejects(
    new AnthropicCaller({
      model: "requested-model",
      messages: never,
      attemptTimeoutMs: 5,
      sleep: () => Promise.resolve(),
    }).call(patient, input),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_timeout",
  );
  assert.ok(Date.now() - started < 5_000);
});

test("a strict schema carries its limits as prose, at every depth", () => {
  const strict = toStrictSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 160 },
      note: {
        type: "string",
        description: "What is missing.",
        minLength: 3,
        maxLength: 240,
      },
      count: { type: "integer", minimum: 0, maximum: 12 },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            keyword: { enum: ["Given", "When", "Then"] },
            text: { type: "string", maxLength: 240 },
          },
          required: ["keyword", "text"],
        },
      },
      tags: { type: "array", minItems: 2, items: { type: "string" } },
    },
    required: ["title", "steps"],
  });

  assert.deepEqual(strict, {
    type: "object",
    additionalProperties: false,
    properties: {
      title: {
        type: "string",
        description: "Non-empty, at most 160 characters.",
      },
      note: {
        type: "string",
        description:
          "What is missing. At least 3 characters, at most 240 characters.",
      },
      count: { type: "integer", description: "At least 0, at most 12." },
      steps: {
        type: "array",
        description: "At least 1 item, at most 12 items.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            keyword: { enum: ["Given", "When", "Then"] },
            text: { type: "string", description: "At most 240 characters." },
          },
          required: ["keyword", "text"],
        },
      },
      tags: {
        type: "array",
        description: "At least 2 items.",
        items: { type: "string" },
      },
    },
    required: ["title", "steps"],
  });
  assert.doesNotMatch(
    JSON.stringify(strict),
    /minLength|maxLength|minItems|maxItems|minimum|maximum/,
  );
});

test("a schema keyword that only looks like a limit is left alone", () => {
  // `properties` named after a limit are fields, not limits, and a
  // non-schema value under `items` or `properties` passes through.
  assert.deepEqual(
    toStrictSchema({
      type: "object",
      properties: {
        maximum: { type: "string" },
        constructor: { type: "string" },
        odd: true,
      },
      items: false,
      toString: "kept",
    }),
    {
      type: "object",
      properties: {
        maximum: { type: "string" },
        constructor: { type: "string" },
        odd: true,
      },
      items: false,
      toString: "kept",
    },
  );
});

test("FakeCaller answers by tool name, from a queue or a function", async () => {
  const answer = {
    result: {
      complexity: "S" as const,
      confidence: "high" as const,
      rationale: "Small.",
    },
    actualModel: "fake",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const queued = new FakeCaller("fake", { size_bounty: [answer] });
  assert.equal(
    (await queued.call(sizeBountyTool, input)).result.complexity,
    "S",
  );
  assert.deepEqual(queued.calls, [{ tool: "size_bounty", input }]);
  assert.deepEqual(queued.inputsFor("size_bounty"), [input]);
  assert.deepEqual(queued.inputsFor("draft_spec"), []);
  await assert.rejects(queued.call(sizeBountyTool, input), /no answer/);

  // A tool nothing was queued for has no answer either, whatever its name.
  const other = { ...sizeBountyTool, name: "toString" };
  await assert.rejects(queued.call(other, input), /no answer for toString/);

  const computed = new FakeCaller("fake", {
    size_bounty: (given) => (given === input ? answer : new Error("other")),
  });
  assert.equal(
    (await computed.call(sizeBountyTool, input)).actualModel,
    "fake",
  );
  assert.equal(
    (await computed.call(sizeBountyTool, input)).actualModel,
    "fake",
  );
  await assert.rejects(
    computed.call(sizeBountyTool, { ...input, summary: "Else" }),
    /other/,
  );
});
