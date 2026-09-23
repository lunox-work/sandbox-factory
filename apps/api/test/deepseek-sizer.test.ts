import assert from "node:assert/strict";
import { test } from "node:test";

import { DeepSeekSizer } from "../src/sizing/deepseek.js";
import { SizerError } from "../src/sizing/sizer.js";

const input = {
  summary: "Add CSV export",
  descriptionText: "Export the filtered table.",
  issueType: "Story",
};

/** The OpenAI-compatible shape: arguments arrive as a JSON string. */
function completion(
  toolInput: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    model: "actual-deepseek-model",
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: "size_bounty",
                arguments: JSON.stringify(toolInput),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 11 },
    ...overrides,
  };
}

test("a forced function call is validated and reports OpenAI-shaped usage", async () => {
  const calls: Record<string, unknown>[] = [];
  const sizer = new DeepSeekSizer({
    model: "requested-deepseek-model",
    completions: {
      create: (params) => {
        calls.push(params);
        return Promise.resolve(
          completion({
            complexity: "M",
            confidence: "medium",
            rationale: "One module and a few related files.",
          }),
        );
      },
    },
  });

  assert.equal(sizer.promptVersion, "jira-size-v2");
  const sized = await sizer.size(input);
  assert.equal(sized.result.complexity, "M");
  assert.equal(sized.actualModel, "actual-deepseek-model");
  // prompt_tokens/completion_tokens are mapped onto the shared field names.
  assert.deepEqual(sized.usage, { inputTokens: 30, outputTokens: 11 });
  assert.deepEqual(calls[0]?.["tool_choice"], {
    type: "function",
    function: { name: "size_bounty" },
  });
  // Thinking mode rejects a forced tool_choice outright, so every request
  // turns it off.
  assert.deepEqual(calls[0]?.["thinking"], { type: "disabled" });
  // The system prompt is a message here, not a top-level field.
  const messages = calls[0]?.["messages"] as { role: string }[];
  assert.equal(messages[0]?.role, "system");
});

test("arguments that are not valid JSON are a retryable invalid result", async () => {
  let calls = 0;
  const sizer = new DeepSeekSizer({
    model: "requested-deepseek-model",
    completions: {
      create: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(
              completion(
                {},
                {
                  choices: [
                    {
                      message: {
                        tool_calls: [
                          {
                            function: {
                              name: "size_bounty",
                              arguments: '{"complexity": "S", trunc',
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              ),
            )
          : Promise.resolve(
              completion({
                complexity: "S",
                confidence: "high",
                rationale: "A localized change.",
              }),
            );
      },
    },
  });

  assert.equal((await sizer.size(input)).result.complexity, "S");
  assert.equal(calls, 2);
});

test("a non-2xx response retries on Retry-After and never leaks the body", async () => {
  const waits: number[] = [];
  let calls = 0;
  const sizer = new DeepSeekSizer({
    model: "requested-deepseek-model",
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
    completions: {
      create: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(
              Object.assign(new Error("upstream body stays private"), {
                status: 429,
                headers: new Headers({ "retry-after": "2" }),
              }),
            )
          : Promise.resolve(
              completion({
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
});

test("authentication and invalid-model failures stop the run without retry", async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const sizer = new DeepSeekSizer({
      model: "requested-deepseek-model",
      completions: {
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
  const sizer = new DeepSeekSizer({
    model: "requested-deepseek-model",
    completions: { create: () => Promise.resolve(completion({})) },
  });
  await assert.rejects(
    sizer.size(input, { signal: controller.signal }),
    (error: unknown) =>
      error instanceof SizerError && error.code === "sizing_cancelled",
  );
});

/**
 * The default `fetch` client, against a real local server: the translation it
 * performs is the one part of this adapter that no injected fake exercises.
 */
async function withServer(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    body: string,
  ) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => handler(request, response, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the default client posts to /chat/completions with a bearer key", async () => {
  let seenUrl = "";
  let seenAuth = "";
  let seenModel = "";
  const server = await withServer((request, response, body) => {
    seenUrl = request.url ?? "";
    seenAuth = String(request.headers["authorization"] ?? "");
    seenModel = String((JSON.parse(body) as { model: string }).model);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        completion({
          complexity: "XS",
          confidence: "high",
          rationale: "A tightly bounded edit.",
        }),
      ),
    );
  });

  try {
    // A trailing slash must not produce a doubled path separator.
    const sizer = new DeepSeekSizer({
      apiKey: "secret-key",
      model: "requested-deepseek-model",
      baseUrl: `${server.baseUrl}/`,
    });
    const result = await sizer.size(input);
    assert.equal(result.result.complexity, "XS");
    assert.equal(seenUrl, "/chat/completions");
    assert.equal(seenAuth, "Bearer secret-key");
    assert.equal(seenModel, "requested-deepseek-model");
  } finally {
    await server.close();
  }
});

test("the default client maps a non-2xx status onto a fixed error code", async () => {
  const server = await withServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "upstream body stays private" }));
  });

  try {
    const sizer = new DeepSeekSizer({
      apiKey: "bad-key",
      model: "requested-deepseek-model",
      baseUrl: server.baseUrl,
    });
    await assert.rejects(
      sizer.size(input),
      (error: unknown) =>
        error instanceof SizerError &&
        error.code === "sizing_configuration" &&
        // Nothing from the upstream body reaches the caller.
        !error.message.includes("private"),
    );
  } finally {
    await server.close();
  }
});

test("the default client posts to /chat/completions and classifies HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; init: RequestInit }[] = [];
  let status = 200;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(
      status === 200
        ? new Response(
            JSON.stringify(
              completion({
                complexity: "S",
                confidence: "high",
                rationale: "A small change.",
              }),
            ),
            { status, headers: { "content-type": "application/json" } },
          )
        : new Response("provider body that must not surface", {
            status,
            headers: { "retry-after": "0" },
          }),
    );
  }) as typeof fetch;

  try {
    const sizer = new DeepSeekSizer({
      apiKey: "sk-test",
      model: "requested-deepseek-model",
      baseUrl: "https://gateway.example.test/v1/",
      sleep: () => Promise.resolve(),
    });
    const sized = await sizer.size(input);
    assert.equal(sized.result.complexity, "S");
    // A trailing slash on the base URL does not double up.
    assert.equal(
      requests[0]?.url,
      "https://gateway.example.test/v1/chat/completions",
    );
    const headers = requests[0]?.init.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer sk-test");
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<
      string,
      unknown
    >;
    assert.equal(body["model"], "requested-deepseek-model");
    // What DeepSeek actually receives: thinking off, so the forced call is
    // accepted.
    assert.deepEqual(body["thinking"], { type: "disabled" });

    // 401 is a configuration stop; the body is dropped.
    status = 401;
    await assert.rejects(
      sizer.size(input),
      (error: unknown) =>
        error instanceof SizerError &&
        error.code === "sizing_configuration" &&
        error.stopsRun,
    );

    // 500 is transient: retried once, then a provider failure.
    status = 500;
    const before = requests.length;
    await assert.rejects(
      sizer.size(input),
      (error: unknown) =>
        error instanceof SizerError && error.code === "sizing_provider",
    );
    assert.equal(requests.length - before, 2);

    // Without a key or base URL, the public API is addressed with an empty
    // bearer, and the 401 that follows is the same configuration stop.
    status = 401;
    const bare = new DeepSeekSizer({ model: "requested-deepseek-model" });
    await assert.rejects(bare.size(input));
    assert.equal(
      requests.at(-1)?.url,
      "https://api.deepseek.com/chat/completions",
    );
    assert.equal(
      (requests.at(-1)?.init.headers as Record<string, string>)[
        "authorization"
      ],
      "Bearer ",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
