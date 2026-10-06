import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEEPWIKI_TOOL_VERSION } from "sandbox-factory";
import { deepwikiSummarySchema } from "@sandbox-factory/shared";
import { AnalysisError } from "../src/errors.js";
import {
  WIKI_PAGES_MAX,
  createDeepwikiAdapter,
  pagePaths,
  parseWiki,
} from "../src/tools/deepwiki.js";
import type { DeepwikiOptions } from "../src/tools/deepwiki.js";
import type { ToolRunInput } from "../src/tools/adapter.js";
import { toolContext } from "./helpers.js";

const params = { deadlineMinutes: 30, builder: "deepwiki" } as const;
const repository = {
  fullName: "acme/widgets",
  token: async () => "tok-secret",
};
const cacheQuery = "owner=acme&repo=widgets&repo_type=github&language=en";

interface Call {
  method: string;
  path: string;
  body: unknown;
}
/** A service double: one scripted reply per route, in call order per route. */
function service(
  replies: Record<string, (() => Response | Promise<Response>)[]>,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit) => {
    const path = String(url).replace("http://deepwiki.test", "");
    const method = init.method ?? "GET";
    calls.push({
      method,
      path,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    assert.ok(init.signal instanceof AbortSignal);
    const route = replies[`${method} ${path}`];
    const reply = route?.length === 1 ? route[0] : route?.shift();
    if (reply === undefined) throw new Error(`unscripted ${method} ${path}`);
    return reply();
  }) as typeof globalThis.fetch;
  return { calls, fetch: fetchImpl };
}
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const wiki = {
  wiki_structure: {
    id: "wiki",
    title: "Widgets",
    description: "How widgets work.",
    pages: [
      {
        id: "overview",
        title: "Overview",
        content: "structure text",
        filePaths: ["README.md"],
        importance: "high",
        relatedPages: ["api/routes"],
      },
      {
        id: "api/routes",
        title: "Routes",
        content: "routes text",
        importance: "weird",
      },
      { id: "api-routes", title: "Routes again" },
      { title: "no id" },
    ],
    sections: [
      { id: "s1", title: "Start", pages: ["overview"], subsections: [] },
      { title: "no id" },
    ],
    rootSections: ["s1"],
  },
  generated_pages: { overview: { id: "overview", content: "generated text" } },
  repo_url: "https://github.com/acme/widgets",
  repo: { owner: "acme", repo: "widgets", type: "github" },
  provider: "openai",
  model: "gpt-4o",
};
function adapterWith(
  replies: Record<string, (() => Response | Promise<Response>)[]>,
  overrides: Partial<DeepwikiOptions> = {},
) {
  const { calls, fetch } = service(replies);
  const sleeps: number[] = [];
  const adapter = createDeepwikiAdapter({
    baseUrl: "http://deepwiki.test/",
    authCode: "code",
    provider: "openai",
    repository,
    fetch,
    pollIntervalMs: 7,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { adapter, calls, sleeps };
}
function inputFor(
  outDir: string,
  overrides: Partial<ToolRunInput> = {},
): ToolRunInput & { messages: string[] } {
  const messages: string[] = [];
  return {
    ...toolContext(),
    sourceDir: outDir,
    outDir,
    params,
    signal: new AbortController().signal,
    log: (line) => messages.push(line),
    messages,
    ...overrides,
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof AnalysisError && error.code === expected;
async function scratch() {
  return mkdtemp(join(tmpdir(), "deepwiki-"));
}

test("a wiki is requested, awaited, read and written as pages", async () => {
  const out = await scratch();
  try {
    const { adapter, calls, sleeps } = adapterWith({
      [`DELETE /api/wiki_cache?${cacheQuery}&authorization_code=code`]: [
        json(404, { detail: "none" }),
      ],
      "POST /wiki/tasks": [
        json(200, {
          task_id: "t1",
          status: "pending",
          created: true,
          joined: false,
          from_cache: false,
        }),
      ],
      "GET /wiki/tasks/t1": [
        json(200, { id: "t1", status: "indexing" }),
        json(200, { id: "t1", status: "generating" }),
        json(200, { id: "t1", status: "completed" }),
      ],
      [`GET /api/wiki_cache?${cacheQuery}`]: [json(200, wiki)],
    });
    assert.equal(adapter.name, "deepwiki");
    assert.equal(adapter.version, DEEPWIKI_TOOL_VERSION);
    const input = inputFor(out);
    const files = await adapter.run(input);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      [
        `DELETE /api/wiki_cache?${cacheQuery}&authorization_code=code`,
        "POST /wiki/tasks",
        "GET /wiki/tasks/t1",
        "GET /wiki/tasks/t1",
        "GET /wiki/tasks/t1",
        `GET /api/wiki_cache?${cacheQuery}`,
      ],
    );
    assert.deepEqual(calls[1]?.body, {
      repo_url: "https://github.com/acme/widgets",
      type: "github",
      token: "tok-secret",
      owner: "acme",
      repo: "widgets",
      language: "en",
      comprehensive: true,
      provider: "openai",
      excluded_dirs: [],
      excluded_files: [],
      included_dirs: [],
      included_files: [],
    });
    assert.deepEqual(sleeps, [7, 7]);
    assert.deepEqual(
      files.map((file) => [file.path, file.kind, file.contentType]),
      [
        ["wiki/overview.md", "wiki_page", "text/markdown; charset=utf-8"],
        ["wiki/api-routes.md", "wiki_page", "text/markdown; charset=utf-8"],
        ["wiki/api-routes-2.md", "wiki_page", "text/markdown; charset=utf-8"],
        ["wiki-structure.json", "wiki_structure", "application/json"],
        ["manifest.json", "manifest", "application/json"],
      ],
    );
    assert.equal(
      await readFile(join(out, "wiki/overview.md"), "utf8"),
      "# Overview\n\ngenerated text\n",
    );
    assert.equal(
      await readFile(join(out, "wiki/api-routes.md"), "utf8"),
      "# Routes\n\nroutes text\n",
    );
    assert.equal(
      await readFile(join(out, "wiki/api-routes-2.md"), "utf8"),
      "# Routes again\n\n\n",
    );
    const parsed = deepwikiSummarySchema.safeParse(files[4]?.meta);
    assert.ok(parsed.success);
    assert.deepEqual(files[3]?.meta, files[4]?.meta);
    assert.equal(parsed.data.toolVersion, DEEPWIKI_TOOL_VERSION);
    assert.equal(parsed.data.title, "Widgets");
    assert.equal(parsed.data.description, "How widgets work.");
    assert.equal(parsed.data.provider, "openai");
    assert.equal(parsed.data.model, "gpt-4o");
    assert.equal(parsed.data.repositoryUrl, "https://github.com/acme/widgets");
    assert.equal(parsed.data.requestedCommitSha, "a".repeat(40));
    assert.deepEqual(parsed.data.pages, [
      {
        id: "overview",
        title: "Overview",
        importance: "high",
        filePaths: ["README.md"],
        relatedPages: ["api/routes"],
        path: "wiki/overview.md",
      },
      {
        id: "api/routes",
        title: "Routes",
        importance: "medium",
        filePaths: [],
        relatedPages: [],
        path: "wiki/api-routes.md",
      },
      {
        id: "api-routes",
        title: "Routes again",
        importance: "medium",
        filePaths: [],
        relatedPages: [],
        path: "wiki/api-routes-2.md",
      },
    ]);
    assert.deepEqual(parsed.data.sections, [
      { id: "s1", title: "Start", pages: ["overview"] },
    ]);
    const structure = JSON.parse(
      await readFile(join(out, "wiki-structure.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(structure["wiki_structure"], wiki.wiki_structure);
    assert.deepEqual(structure["repo"], wiki.repo);
    assert.equal(structure["provider"], "openai");
    assert.deepEqual(
      JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
      files[4]?.meta,
    );
    assert.deepEqual(input.messages, [
      "DeepWiki wiki started.",
      "DeepWiki task submitted.",
      "DeepWiki wiki read.",
      "DeepWiki wiki completed.",
    ]);
    assert.ok(input.messages.every((line) => !line.includes("tok-secret")));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("a finished task reads the cache; the model and auth code pass only when set", async () => {
  const out = await scratch();
  try {
    const { adapter, calls, sleeps } = adapterWith(
      {
        [`DELETE /api/wiki_cache?${cacheQuery}`]: [json(200, { ok: true })],
        "POST /wiki/tasks": [json(200, { task_id: "t2", status: "completed" })],
        "GET /wiki/tasks/t2": [json(404, { detail: "gone" })],
        [`GET /api/wiki_cache?${cacheQuery}`]: [
          json(200, {
            ...wiki,
            generated_pages: undefined,
            provider: undefined,
            model: 7,
            sections: null,
          }),
        ],
      },
      { authCode: undefined, provider: undefined, model: "m" },
    );
    const files = await adapter.run(inputFor(out));
    assert.equal(sleeps.length, 0);
    const body = calls[1]?.body as Record<string, unknown>;
    assert.equal(body["model"], "m");
    assert.equal("provider" in body, false);
    const parsed = deepwikiSummarySchema.safeParse(files.at(-1)?.meta);
    assert.ok(parsed.success);
    assert.equal(parsed.data.provider, null);
    assert.equal(parsed.data.model, null);
    assert.equal(
      await readFile(join(out, "wiki/overview.md"), "utf8"),
      "# Overview\n\nstructure text\n",
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("pages are capped and their file names made safe and unique", async () => {
  assert.deepEqual(
    [
      ...pagePaths([
        {
          id: "",
          title: "",
          content: "",
          filePaths: [],
          importance: "low",
          relatedPages: [],
        },
        {
          id: "a b",
          title: "",
          content: "",
          filePaths: [],
          importance: "low",
          relatedPages: [],
        },
        {
          id: "a-b",
          title: "",
          content: "",
          filePaths: [],
          importance: "low",
          relatedPages: [],
        },
        {
          id: "../x",
          title: "",
          content: "",
          filePaths: [],
          importance: "low",
          relatedPages: [],
        },
      ]).values(),
    ],
    ["wiki/page.md", "wiki/a-b.md", "wiki/a-b-2.md", "wiki/..-x.md"],
  );
  const out = await scratch();
  try {
    const pages = Array.from({ length: WIKI_PAGES_MAX + 1 }, (_, i) => ({
      id: `p${i}`,
      title: `Page ${i}`,
      content: "",
    }));
    const { adapter } = adapterWith({
      [`DELETE /api/wiki_cache?${cacheQuery}&authorization_code=code`]: [
        json(404, {}),
      ],
      "POST /wiki/tasks": [json(200, { task_id: "t3" })],
      "GET /wiki/tasks/t3": [json(200, { status: "completed" })],
      [`GET /api/wiki_cache?${cacheQuery}`]: [
        json(200, { wiki_structure: { pages } }),
      ],
    });
    const files = await adapter.run(inputFor(out));
    assert.equal(files.length, WIKI_PAGES_MAX + 2);
    assert.equal((await readdir(join(out, "wiki"))).length, WIKI_PAGES_MAX);
    const parsed = deepwikiSummarySchema.safeParse(files.at(-1)?.meta);
    assert.ok(parsed.success);
    assert.equal(parsed.data.pages.length, WIKI_PAGES_MAX);
    assert.equal(parsed.data.title, "");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("the cache is read leniently and malformed replies fail closed", () => {
  assert.throws(() => parseWiki(null), code("tool_failed"));
  assert.throws(() => parseWiki({ wiki_structure: {} }), code("tool_failed"));
  assert.throws(
    () => parseWiki({ wiki_structure: { pages: {} } }),
    code("tool_failed"),
  );
  const parsed = parseWiki({
    wiki_structure: { pages: [{ id: "x", importance: "low" }], sections: "no" },
    generated_pages: { x: "not a page" },
  });
  assert.deepEqual(parsed.pages, [
    {
      id: "x",
      title: "x",
      content: "",
      filePaths: [],
      importance: "low",
      relatedPages: [],
    },
  ]);
  assert.deepEqual(parsed.sections, []);
  assert.equal(parsed.repo, null);
});

test("missing service, repository or parameters fail with their codes", async () => {
  const out = await scratch();
  try {
    await assert.rejects(
      createDeepwikiAdapter({ baseUrl: undefined, repository }).run(
        inputFor(out),
      ),
      code("builder_unavailable"),
    );
    const untouched = adapterWith({}, { repository: null });
    await assert.rejects(
      untouched.adapter.run(inputFor(out)),
      code("source_unavailable"),
    );
    await assert.rejects(
      adapterWith(
        {},
        {
          repository: { fullName: "not a repository", token: async () => "" },
        },
      ).adapter.run(inputFor(out)),
      code("source_unavailable"),
    );
    await assert.rejects(
      adapterWith({}).adapter.run(inputFor(out, { run: null })),
      code("source_unavailable"),
    );
    await assert.rejects(
      adapterWith({}).adapter.run(
        inputFor(out, { params: { deadlineMinutes: 30 } }),
      ),
      code("tool_failed"),
    );
    assert.equal(untouched.calls.length, 0);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("every service failure is tool_failed and an abort is the abort", async () => {
  const out = await scratch();
  const del = `DELETE /api/wiki_cache?${cacheQuery}&authorization_code=code`;
  const get = `GET /api/wiki_cache?${cacheQuery}`;
  const task = (status: string) => json(200, { task_id: "t", status });
  const fails = (
    replies: Record<string, (() => Response | Promise<Response>)[]>,
    overrides: Partial<DeepwikiOptions> = {},
  ) =>
    assert.rejects(
      adapterWith(replies, overrides).adapter.run(inputFor(out)),
      code("tool_failed"),
    );
  try {
    await fails({ [del]: [json(500, {})] });
    await fails({
      [del]: [json(404, {})],
      "POST /wiki/tasks": [json(500, {})],
    });
    await fails({
      [del]: [json(404, {})],
      "POST /wiki/tasks": [json(200, {})],
    });
    await fails({
      [del]: [json(404, {})],
      "POST /wiki/tasks": [() => new Response("not json", { status: 200 })],
    });
    await fails({
      [del]: [json(404, {})],
      "POST /wiki/tasks": [task("pending")],
      "GET /wiki/tasks/t": [json(200, { status: "failed", error: "boom" })],
    });
    await fails({
      [del]: [json(404, {})],
      "POST /wiki/tasks": [task("pending")],
      "GET /wiki/tasks/t": [json(500, {})],
    });
    await fails({
      [del]: [json(404, {})],
      "POST /wiki/tasks": [task("pending")],
      "GET /wiki/tasks/t": [json(200, { status: "completed" })],
      [get]: [json(200, null)],
    });
    await fails({
      [del]: [json(404, {})],
      "POST /wiki/tasks": [task("pending")],
      "GET /wiki/tasks/t": [json(200, { status: "completed" })],
      [get]: [json(500, {})],
    });
    await fails({
      [del]: [json(404, {})],
      "POST /wiki/tasks": [task("pending")],
      "GET /wiki/tasks/t": [json(200, { status: "completed" })],
      [get]: [json(200, { nothing: true })],
    });
    await fails({
      [del]: [
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    });
    // An abort while the service is slow surfaces as the abort itself.
    const abort = new AbortController();
    await assert.rejects(
      adapterWith({
        [del]: [
          () => {
            abort.abort(new Error("lease lost"));
            throw abort.signal.reason;
          },
        ],
      }).adapter.run(inputFor(out, { signal: abort.signal })),
      /lease lost/,
    );
    // The default sleep honours the signal between polls.
    const waiting = new AbortController();
    const slow = adapterWith(
      {
        [del]: [json(404, {})],
        "POST /wiki/tasks": [task("pending")],
        "GET /wiki/tasks/t": [json(200, { status: "pending" })],
      },
      { sleep: undefined, pollIntervalMs: 50 },
    );
    setTimeout(() => waiting.abort(new Error("deadline")), 10);
    await assert.rejects(
      slow.adapter.run(inputFor(out, { signal: waiting.signal })),
      /deadline/,
    );
    const quick = adapterWith(
      {
        [del]: [json(404, {})],
        "POST /wiki/tasks": [task("pending")],
        "GET /wiki/tasks/t": [
          json(200, { status: "pending" }),
          json(200, { status: "completed" }),
        ],
        [get]: [json(200, wiki)],
      },
      { sleep: undefined, pollIntervalMs: 1 },
    );
    assert.equal((await quick.adapter.run(inputFor(out))).length, 5);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
