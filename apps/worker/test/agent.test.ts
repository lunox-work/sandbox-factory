import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { parseSliceGraph } from "sandbox-factory";
import type { SpecDraft } from "sandbox-factory";
import { createAnthropicModel } from "../src/agent/anthropic.js";
import { runAgent } from "../src/agent/loop.js";
import type { AgentModel, AgentTool, AgentTurn } from "../src/agent/loop.js";
import {
  FIXTURES_SYSTEM_PROMPT,
  SCOPE_SYSTEM_PROMPT,
  ticketSection,
} from "../src/agent/prompts.js";
import {
  REPO_TOOL_LIMITS,
  graphNeighboursTool,
  indexRepository,
  repositoryOverview,
  repositoryTools,
} from "../src/agent/repo-tools.js";
import { parseWorkerEnv } from "../src/env.js";
import { AnalysisError } from "../src/errors.js";
import { createTaskReader } from "../src/tasks.js";

const signal = new AbortController().signal;
const usage = {
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const call = (name: string, input: unknown, id = name): unknown => ({
  type: "tool_use",
  id,
  name,
  input,
});
const turn = (
  content: unknown[],
  stopReason = "tool_use",
  spent = usage,
): AgentTurn => ({
  content: content as AgentTurn["content"],
  stopReason,
  usage: spent,
});

/** A model that plays turns in order and records what it was sent. */
function scripted(turns: AgentTurn[]): AgentModel & {
  requests: { messages: readonly unknown[] }[];
} {
  const requests: { messages: readonly unknown[] }[] = [];
  return {
    model: "test-model",
    requests,
    async turn(request) {
      requests.push({ messages: structuredClone([...request.messages]) });
      const next = turns.shift();
      if (next === undefined) throw new Error("script exhausted");
      return next;
    },
  };
}
const echo: AgentTool = {
  name: "echo",
  description: "Echo.",
  inputSchema: { properties: {}, required: [], additionalProperties: false },
  async run(input) {
    return { content: JSON.stringify(input) };
  },
};
const submit = (accept: (input: unknown) => boolean): AgentTool => ({
  name: "submit",
  description: "Submit.",
  inputSchema: { properties: {}, required: [], additionalProperties: false },
  async run(input) {
    return accept(input)
      ? { content: "Recorded.", accepted: true }
      : { content: "Rejected.", isError: true };
  },
});
const limits = { maxTurns: 10, maxTokens: 10_000 };

test("the loop runs tools until the submit tool accepts, and logs only fixed lines", async () => {
  const model = scripted([
    turn([
      { type: "thinking", thinking: "", signature: "s" },
      call("echo", { a: 1 }, "t1"),
      call("missing", {}, "t2"),
    ]),
    turn([call("submit", { ok: false }, "t3")]),
    turn([call("submit", { ok: true }, "t4")]),
  ]);
  const lines: string[] = [];
  const outcome = await runAgent({
    model,
    system: "system",
    prompt: "prompt",
    tools: [echo, submit((input) => (input as { ok: boolean }).ok)],
    submitTool: "submit",
    limits,
    signal,
    log: (line) => lines.push(line),
  });
  assert.equal(outcome.stopped, "accepted");
  assert.equal(outcome.usage.turns, 3);
  assert.equal(outcome.usage.inputTokens, 300);
  assert.equal(outcome.usage.model, "test-model");
  // The second request carries the assistant turn back unchanged, then the results.
  const second = model.requests[1]?.messages as {
    role: string;
    content: { type: string; is_error?: boolean; content?: string }[];
  }[];
  assert.equal(second[1]?.content[0]?.type, "thinking");
  assert.deepEqual(
    second[2]?.content.map((block) => [block.type, block.is_error ?? false]),
    [
      ["tool_result", false],
      ["tool_result", true],
    ],
  );
  assert.match(second[2]?.content[1]?.content ?? "", /no tool named missing/);
  assert.deepEqual(lines.slice(0, 3), [
    "Turn 1: echo x1, missing x1.",
    "Turn 2: submit x1.",
    "Turn 3: submit x1.",
  ]);
  assert.match(lines[3] ?? "", /^Agent stopped \(accepted\) after 3 turns/);
  assert.ok(lines.every((line) => !line.includes('"a"')));
});

test("a turn with no tool call is nudged twice before the loop gives up", async () => {
  const model = scripted([
    turn([{ type: "text", text: "thinking aloud" }], "end_turn"),
    turn([{ type: "text", text: "still" }], "end_turn"),
    turn([{ type: "text", text: "done" }], "end_turn"),
  ]);
  const outcome = await runAgent({
    model,
    system: "s",
    prompt: "p",
    tools: [submit(() => true)],
    submitTool: "submit",
    limits,
    signal,
    log: () => {},
  });
  assert.equal(outcome.stopped, "no_answer");
  const nudge = model.requests[1]?.messages.at(-1) as {
    content: { text: string }[];
  };
  assert.equal(nudge.content[0]?.text, "Answer by calling submit.");
});

test("refusals, cut-off calls, failing tools and limits each stop or steer the loop", async () => {
  assert.equal(
    (
      await runAgent({
        model: scripted([turn([], "refusal")]),
        system: "s",
        prompt: "p",
        tools: [],
        submitTool: "submit",
        limits,
        signal,
        log: () => {},
      })
    ).stopped,
    "refusal",
  );
  // A call cut off at max_tokens is never run, however valid it looks.
  let ran = false;
  const guarded = scripted([
    turn([call("submit", {})], "max_tokens"),
    turn([], "refusal"),
  ]);
  await runAgent({
    model: guarded,
    system: "s",
    prompt: "p",
    tools: [
      {
        ...submit(() => true),
        async run() {
          ran = true;
          return { content: "Recorded.", accepted: true };
        },
      },
    ],
    submitTool: "submit",
    limits,
    signal,
    log: () => {},
  });
  assert.equal(ran, false);
  const lines: string[] = [];
  const failing = scripted([turn([call("boom", {})]), turn([], "refusal")]);
  await runAgent({
    model: failing,
    system: "s",
    prompt: "p",
    tools: [
      {
        ...echo,
        name: "boom",
        async run() {
          throw new Error("secret source text");
        },
      },
    ],
    submitTool: "submit",
    limits,
    signal,
    log: (line) => lines.push(line),
  });
  assert.ok(lines.includes("Tool boom failed."));
  assert.ok(lines.every((line) => !line.includes("secret")));
  // Past 80 % of the budget the agent is told to submit; past it, the loop stops.
  const heavy = { ...usage, inputTokens: 4_500 };
  const budget = scripted([
    turn([call("echo", {})], "tool_use", heavy),
    turn([call("echo", {})], "tool_use", heavy),
    turn([call("echo", {})], "tool_use", heavy),
  ]);
  const spent = await runAgent({
    model: budget,
    system: "s",
    prompt: "p",
    tools: [echo],
    submitTool: "submit",
    limits,
    signal,
    log: () => {},
  });
  assert.equal(spent.stopped, "budget");
  const warning = budget.requests[2]?.messages.at(-1) as {
    content: { type: string; text?: string }[];
  };
  assert.match(warning.content.at(-1)?.text ?? "", /budget is nearly spent/);
  const turns = await runAgent({
    model: scripted([turn([call("echo", {})]), turn([call("echo", {})])]),
    system: "s",
    prompt: "p",
    tools: [echo],
    submitTool: "submit",
    limits: { maxTurns: 2, maxTokens: 1_000_000 },
    signal,
    log: () => {},
  });
  assert.equal(turns.stopped, "turns");
  // A cancelled run stops at once, and a tool error after cancellation propagates.
  const controller = new AbortController();
  controller.abort(new AnalysisError("cancelled"));
  await assert.rejects(
    runAgent({
      model: scripted([]),
      system: "s",
      prompt: "p",
      tools: [],
      submitTool: "submit",
      limits,
      signal: controller.signal,
      log: () => {},
    }),
  );
  const aborting = new AbortController();
  await assert.rejects(
    runAgent({
      model: scripted([turn([call("stop", {})])]),
      system: "s",
      prompt: "p",
      tools: [
        {
          ...echo,
          name: "stop",
          async run() {
            aborting.abort(new AnalysisError("tool_timeout"));
            throw new Error("aborted");
          },
        },
      ],
      submitTool: "submit",
      limits,
      signal: aborting.signal,
      log: () => {},
    }),
    /aborted/,
  );
});

test("the Anthropic model streams one strict, cached, adaptive call per turn", async () => {
  const sent: Record<string, unknown>[] = [];
  const model = createAnthropicModel({
    apiKey: "key",
    model: "claude-test",
    messages: {
      stream(params: Record<string, unknown>) {
        sent.push(params);
        return {
          finalMessage: async () => ({
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              cache_read_input_tokens: 7,
              cache_creation_input_tokens: null,
            },
          }),
        };
      },
    } as never,
  });
  const reply = await model.turn(
    {
      system: "system",
      tools: [
        {
          name: "echo",
          description: "Echo.",
          inputSchema: {
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    },
    signal,
  );
  assert.deepEqual(reply.usage, {
    inputTokens: 5,
    outputTokens: 2,
    cacheReadTokens: 7,
    cacheWriteTokens: 0,
  });
  assert.equal(reply.stopReason, "end_turn");
  const params = sent[0] ?? {};
  assert.equal(params["model"], "claude-test");
  assert.deepEqual(params["thinking"], { type: "adaptive" });
  assert.deepEqual(params["cache_control"], { type: "ephemeral" });
  assert.equal(params["fallbacks"], "default");
  assert.deepEqual(params["betas"], ["server-side-fallback-2026-07-01"]);
  const tools = params["tools"] as {
    strict: boolean;
    input_schema: { type: string };
  }[];
  assert.equal(tools[0]?.strict, true);
  assert.equal(tools[0]?.input_schema.type, "object");
  const failing = (error: Error) =>
    createAnthropicModel({
      apiKey: "key",
      model: "claude-test",
      messages: {
        stream() {
          return {
            finalMessage: async () => {
              throw error;
            },
          };
        },
      } as never,
    });
  const request = { system: "s", tools: [], messages: [] };
  for (const error of [
    new Anthropic.AuthenticationError(401, undefined, "no", new Headers()),
    new Anthropic.PermissionDeniedError(403, undefined, "no", new Headers()),
    new Anthropic.NotFoundError(404, undefined, "no model", new Headers()),
  ])
    await assert.rejects(
      failing(error).turn(request, signal),
      (thrown) =>
        thrown instanceof AnalysisError && thrown.code === "agent_unavailable",
    );
  await assert.rejects(
    failing(
      new Anthropic.RateLimitError(429, undefined, "slow", new Headers()),
    ).turn(request, signal),
    Anthropic.RateLimitError,
  );
  assert.equal(
    createAnthropicModel({ apiKey: "key", model: "claude-test" }).model,
    "claude-test",
  );
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "agent-repo-"));
  await mkdir(join(root, "src", "billing"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "node_modules", "x"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref");
  await writeFile(join(root, "node_modules", "x", "index.js"), "x");
  await writeFile(join(root, "package.json"), '{ "name": "shop" }\n');
  await writeFile(
    join(root, "src", "billing", "invoice.ts"),
    Array.from(
      { length: 1_000 },
      (_, i) => `export const line${i} = ${i};`,
    ).join("\n"),
  );
  await writeFile(
    join(root, "src", "billing", "tax.ts"),
    "// Applies VAT\nexport function vat(total: number) { return total * 0.2; }\n",
  );
  await writeFile(
    join(root, "logo.png"),
    Buffer.from([0x89, 0x50, 0x00, 0x01]),
  );
  await writeFile(join(root, "README"), "Shop.\n");
  return root;
}

test("repository tools list, read and search only what the archive held", async () => {
  const root = await repository();
  try {
    const index = await indexRepository(root, signal);
    assert.deepEqual(index.paths, [
      "README",
      "logo.png",
      "package.json",
      "src/billing/invoice.ts",
      "src/billing/tax.ts",
    ]);
    const overview = repositoryOverview(index);
    assert.match(overview, /^5 files\./);
    assert.match(overview, /src \(2\)/);
    assert.match(overview, /Manifests: package\.json\./);
    const tools = new Map(
      repositoryTools(index).map((tool) => [tool.name, tool]),
    );
    const run = (name: string, input: unknown) =>
      tools.get(name)?.run(input, signal) ?? Promise.reject(new Error(name));
    assert.match(
      (await run("list_files", { prefix: "src/", cursor: null })).content,
      /src\/billing\/tax\.ts \d+\nEnd of list\./,
    );
    assert.equal(
      (await run("list_files", { prefix: "docs/", cursor: null })).content,
      "No files.",
    );
    assert.equal((await run("list_files", { prefix: 1 })).isError, true);
    const read = await run("read_file", {
      path: "src/billing/invoice.ts",
      startLine: null,
      endLine: null,
    });
    assert.match(
      read.content,
      /^src\/billing\/invoice\.ts lines 1-800 of 1000\n1\texport const line0/,
    );
    const range = await run("read_file", {
      path: "src/billing/invoice.ts",
      startLine: 990,
      endLine: 2_000,
    });
    assert.match(range.content, /lines 990-1000 of 1000/);
    for (const [input, pattern] of [
      [
        { path: "../etc/passwd", startLine: null, endLine: null },
        /not a file in this repository/,
      ],
      [{ path: "logo.png", startLine: null, endLine: null }, /not a text file/],
      [
        { path: "README", startLine: 1, endLine: null },
        /README lines 1-2 of 2/,
      ],
      [
        { path: "src/billing/tax.ts", startLine: 3, endLine: 1 },
        /endLine is before startLine/,
      ],
      [{ path: "" }, /Invalid input/],
    ] as const)
      assert.match((await run("read_file", input)).content, pattern);
    assert.match(
      (await run("search", { text: "vat", prefix: null })).content,
      /^src\/billing\/tax\.ts:1: \/\/ Applies VAT\nsrc\/billing\/tax\.ts:2: export function vat/,
    );
    assert.equal(
      (await run("search", { text: "nothing here", prefix: "src/" })).content,
      "No matches.",
    );
    assert.equal(
      (await run("search", { text: "x", prefix: null })).isError,
      true,
    );
    const many = await run("search", { text: "export const", prefix: null });
    assert.equal(
      many.content.split("\n").filter((line) => line.includes(":")).length,
      REPO_TOOL_LIMITS.searchMatches,
    );
    assert.match(many.content, /narrow the prefix/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graph neighbours name a file's imports and importers", async () => {
  const graph = parseSliceGraph({
    nodes: [
      {
        id: "file:src/a.ts",
        label: "a",
        source_file: "src/a.ts",
        community: 0,
      },
      {
        id: "file:src/b.ts",
        label: "b",
        source_file: "src/b.ts",
        community: 0,
      },
      {
        id: "symbol:src/b.ts:f",
        label: "f()",
        source_file: "src/b.ts",
        community: 0,
      },
      {
        id: "dependency:src/a.ts:pg",
        label: "pg",
        source_file: "src/a.ts",
        community: 0,
        dependencyStatus: "external",
      },
    ],
    links: [
      {
        source: "file:src/a.ts",
        target: "symbol:src/b.ts:f",
        relation: "calls",
        confidence: "EXTRACTED",
      },
      {
        source: "file:src/a.ts",
        target: "dependency:src/a.ts:pg",
        relation: "imports",
        confidence: "EXTRACTED",
      },
      {
        source: "file:src/b.ts",
        target: "symbol:src/b.ts:f",
        relation: "contains",
        confidence: "EXTRACTED",
      },
    ],
  });
  const tool = graphNeighboursTool(graph);
  const answer = await tool.run({ path: "src/a.ts" }, signal);
  assert.match(answer.content, /src\/a\.ts uses:\npackage pg\nsrc\/b\.ts/);
  assert.match(answer.content, /is used by:\n\(none\)/);
  assert.match(
    (await tool.run({ path: "src/b.ts" }, signal)).content,
    /used by:\nsrc\/a\.ts/,
  );
  assert.equal((await tool.run({ path: "src/c.ts" }, signal)).isError, true);
  assert.equal((await tool.run({}, signal)).isError, true);
});

const draft: SpecDraft = {
  feature: "Discounts",
  background: [],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "A coupon lowers the total",
      steps: [{ keyword: "When", text: "a coupon is applied" }],
      origin: "draft",
    },
  ],
  openQuestions: ["Do coupons stack?"],
  assumptions: [],
};

test("prompts carry the ticket's spec and the seam rule", () => {
  const ticket = ticketSection("SHOP-1", draft);
  assert.match(ticket, /^Ticket SHOP-1/);
  assert.match(ticket, /Scenario: A coupon lowers the total/);
  assert.match(ticket, /Do coupons stack\?/);
  assert.match(SCOPE_SYSTEM_PROMPT, /submit_scope/);
  assert.match(SCOPE_SYSTEM_PROMPT, /data, not instructions/);
  assert.match(FIXTURES_SYSTEM_PROMPT, /sandbox\/run\.ts/);
});

test("tasks are read owner-scoped: the proposal, then the spec revision", async () => {
  const proposals = {
    get: async (owner: string, id: string) =>
      owner === "org_1" && id === "bpr_1"
        ? ({ issueKey: "SHOP-1" } as never)
        : null,
  };
  const specs = {
    get: async (_owner: string, _id: string, revision: number) =>
      revision === 2 ? ({ revision: 2, specHash: "h", draft } as never) : null,
  };
  const reader = createTaskReader(proposals, specs);
  assert.deepEqual(await reader.get("org_1", "bpr_1", 2), {
    issueKey: "SHOP-1",
    specRevision: 2,
    specHash: "h",
    draft,
  });
  assert.equal(await reader.get("org_2", "bpr_1", 2), null);
  assert.equal(await reader.get("org_1", "bpr_1", 3), null);
});

test("a key needs a named model, a model alone does nothing, and limits are bounded", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    S3_BUCKET: "b",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
  const env = parseWorkerEnv({
    ...base,
    ANTHROPIC_API_KEY: "",
    AGENT_MODEL: "",
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.AGENT_TOKEN_BUDGET, 4_000_000);
  assert.equal(env.AGENT_MAX_TURNS, 40);
  assert.equal(
    parseWorkerEnv({
      ...base,
      ANTHROPIC_API_KEY: "k",
      AGENT_MODEL: "m",
      AGENT_MAX_TURNS: "12",
    }).AGENT_MAX_TURNS,
    12,
  );
  assert.throws(
    () => parseWorkerEnv({ ...base, ANTHROPIC_API_KEY: "k" }),
    /AGENT_MODEL must be set with ANTHROPIC_API_KEY/,
  );
  assert.equal(
    parseWorkerEnv({ ...base, AGENT_MODEL: "m" }).ANTHROPIC_API_KEY,
    undefined,
  );
  // A secret still holding the deploy's placeholder is unset.
  assert.equal(
    parseWorkerEnv({ ...base, ANTHROPIC_API_KEY: "REPLACE_ME" })
      .ANTHROPIC_API_KEY,
    undefined,
  );
  assert.throws(() => parseWorkerEnv({ ...base, AGENT_MAX_TURNS: "500" }));
});

test("text-only replies cannot continue after exhausting the token budget", async () => {
  const model = scripted(
    Array.from({ length: 3 }, () =>
      turn([{ type: "text", text: "thinking" }], "end_turn", {
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ),
  );
  const result = await runAgent({
    model,
    system: "test",
    prompt: "test",
    tools: [submit(() => true)],
    submitTool: "submit",
    limits: { maxTurns: 10, maxTokens: 5 },
    signal,
    log: () => {},
  });
  assert.equal(model.requests.length, 1);
  assert.equal(result.stopped, "budget");
  assert.equal(result.usage.inputTokens, 10);
});
