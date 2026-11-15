/**
 * The flow's edges, and nothing inside them: object storage in memory,
 * GitHub's REST API answered from the fixture, graphify's Python run
 * replaced by the graph it would write, and the two models scripted. The
 * sizing model answers through each tool's own `parse`, and the agents call
 * the real tools (a slice check, a hidden-test baseline, a reference run),
 * so everything a model's answer passes through is the product's code.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toIssueSpec } from "@sandbox-factory/jira";

/** The fixture's names, as the repository writes them (private). */
export const FIXTURE = {
  fullName: "orvanta-labs/payments",
  externalId: "424242",
  installationId: "9001",
  feeModule: "src/orvanta/fees.ts",
  ledgerModule: "src/orvanta/ledger.ts",
};

/** An `ObjectStore` in memory, shared by the API and the worker. */
export function memoryObjects() {
  const objects = new Map();
  return {
    objects,
    async put(key, body) {
      objects.set(key, Buffer.from(body));
    },
    async get(key) {
      const found = objects.get(key);
      return found === undefined ? undefined : new Uint8Array(found);
    },
    async exists(key) {
      return objects.has(key);
    },
    async remove(key) {
      objects.delete(key);
    },
    async signedUrl(key) {
      return `memory://objects/${encodeURIComponent(key)}`;
    },
  };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Git's object id of a blob. */
const blobSha = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");

/** What merge-back needs the App's installation to have accepted. */
export const WRITE_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  issues: "read",
};
const LEVELS = ["read", "write", "admin"];
const covers = (granted, wanted) =>
  Object.entries(wanted).every(
    ([name, level]) =>
      LEVELS.indexOf(granted[name] ?? "") >= LEVELS.indexOf(level),
  );

/**
 * GitHub's REST API for one installation and one repository, from the
 * fixture's files: installation tokens, the installation itself (its
 * accepted permissions, `installation.permissions`, which a step may
 * change), the recursive tree, languages and blobs; and the Git data and
 * pull-request routes a merge-back writes through, kept in memory so the
 * opened pull request's files can be read back (`pulls`). A token carries
 * what it was minted with: a mint asking for more than the installation
 * holds is refused 422, as GitHub refuses it, and a write the token may
 * not make is refused 403. Anything else is answered 404 and recorded in
 * `unexpected`, so a step that starts calling GitHub shows up rather than
 * passing quietly.
 */
export function fakeGithub({ files, commitSha }) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const blobs = new Map();
  const tree = [];
  const directories = new Set();
  for (const [path, bytes] of files) {
    const sha = blobSha(bytes);
    blobs.set(sha, bytes);
    tree.push({
      path,
      mode: "100644",
      type: "blob",
      sha,
      size: bytes.byteLength,
    });
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1)
      directories.add(parts.slice(0, depth).join("/"));
  }
  for (const path of directories)
    tree.push({
      path,
      mode: "040000",
      type: "tree",
      sha: blobSha(Buffer.from(path)),
    });
  tree.sort((a, b) => a.path.localeCompare(b.path));
  const treeSha = blobSha(Buffer.from(JSON.stringify(tree)));
  const typescriptBytes = [...files]
    .filter(([path]) => path.endsWith(".ts"))
    .reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
  const calls = [];
  const unexpected = [];
  const repo = `/repos/${FIXTURE.fullName}`;
  const installation = { permissions: { ...WRITE_PERMISSIONS } };
  /** Each token minted, with the permissions it carries. */
  const tokens = new Map();
  /** Git's objects a merge-back makes: trees by sha, commits by sha. */
  const trees = new Map([[treeSha, { base: null, files: [] }]]);
  const commits = new Map([[commitSha, { tree: treeSha, parents: [] }]]);
  /** Branches by name, each its head commit. */
  const refs = new Map();
  /** Every pull request opened, with the files its head commit adds. */
  const pulls = [];
  const digest = (value) => blobSha(Buffer.from(JSON.stringify(value)));
  const may = (init, name) => {
    const token = String(new Headers(init.headers).get("authorization"))
      .replace(/^(Bearer|token) /i, "")
      .trim();
    return covers(tokens.get(token) ?? {}, { [name]: "write" });
  };
  const forbidden = () =>
    json(403, { message: "Resource not accessible by integration" });
  const body = (init) => JSON.parse(String(init.body ?? "{}"));

  async function fetch(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    if (url.hostname !== "api.github.com") {
      unexpected.push(`${method} ${url.href}`);
      return json(404, { message: "Not Found" });
    }
    const installationPath = `/app/installations/${FIXTURE.installationId}`;
    if (method === "POST" && path === `${installationPath}/access_tokens`) {
      const wanted = body(init).permissions ?? installation.permissions;
      if (!covers(installation.permissions, wanted))
        return json(422, {
          message:
            "The permissions requested are not granted to this installation.",
        });
      const token = `ghs_flow_${tokens.size + 1}`;
      tokens.set(token, { ...wanted });
      return json(201, {
        token,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { ...wanted },
        repository_selection: "selected",
      });
    }
    if (method === "GET" && path === installationPath)
      return json(200, {
        id: Number(FIXTURE.installationId),
        repository_selection: "selected",
        permissions: { ...installation.permissions },
        suspended_at: null,
      });
    if (method === "GET" && path === `${repo}/git/trees/${commitSha}`)
      return json(200, { sha: treeSha, truncated: false, tree });
    if (method === "GET" && path === `${repo}/languages`)
      return json(200, { TypeScript: typescriptBytes });
    const blob = path.startsWith(`${repo}/git/blobs/`)
      ? blobs.get(path.slice(`${repo}/git/blobs/`.length))
      : undefined;
    if (method === "GET" && blob !== undefined)
      return json(200, {
        sha: path.split("/").at(-1),
        content: blob.toString("base64"),
        encoding: "base64",
      });

    // Merge-back: Git data, then the pull request.
    if (method === "GET" && path.startsWith(`${repo}/git/commits/`)) {
      const sha = decodeURIComponent(path.split("/").at(-1));
      const commit = commits.get(sha);
      return commit === undefined
        ? json(404, { message: "Not Found" })
        : json(200, { sha, tree: { sha: commit.tree }, parents: [] });
    }
    if (method === "POST" && path === `${repo}/git/trees`) {
      if (!may(init, "contents")) return forbidden();
      const { base_tree: base, tree: entries } = body(init);
      if (!trees.has(base)) return json(422, { message: "base_tree invalid" });
      const added = entries
        .map((entry) => ({ path: entry.path, text: entry.content }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const sha = digest({ base, added });
      trees.set(sha, { base, files: added });
      return json(201, { sha });
    }
    if (method === "POST" && path === `${repo}/git/commits`) {
      if (!may(init, "contents")) return forbidden();
      const { tree: treeOf, parents, message } = body(init);
      if (!trees.has(treeOf) || !parents.every((sha) => commits.has(sha)))
        return json(422, { message: "tree or parent invalid" });
      const sha = digest({ treeOf, parents, message });
      commits.set(sha, { tree: treeOf, parents });
      return json(201, { sha, tree: { sha: treeOf } });
    }
    if (method === "GET" && path.startsWith(`${repo}/git/ref/heads/`)) {
      const branch = decodeURIComponent(
        path.slice(`${repo}/git/ref/heads/`.length),
      );
      const head = refs.get(branch);
      return head === undefined
        ? json(404, { message: "Not Found" })
        : json(200, {
            ref: `refs/heads/${branch}`,
            object: { sha: head, type: "commit" },
          });
    }
    if (method === "POST" && path === `${repo}/git/refs`) {
      if (!may(init, "contents")) return forbidden();
      const { ref, sha } = body(init);
      const branch = ref.replace(/^refs\/heads\//, "");
      if (refs.has(branch))
        return json(422, { message: "Reference already exists" });
      if (!commits.has(sha)) return json(422, { message: "Object not found" });
      refs.set(branch, sha);
      return json(201, { ref, object: { sha, type: "commit" } });
    }
    const owner = FIXTURE.fullName.split("/")[0];
    const openFrom = (head) =>
      pulls.filter((pull) => pull.state === "open" && pull.head === head);
    const summary = (pull) => ({
      number: pull.number,
      html_url: pull.url,
      state: pull.state,
    });
    if (method === "GET" && path === `${repo}/pulls`) {
      const head = url.searchParams.get("head") ?? "";
      const branch = head.startsWith(`${owner}:`)
        ? head.slice(owner.length + 1)
        : null;
      return json(200, branch === null ? [] : openFrom(branch).map(summary));
    }
    if (method === "POST" && path === `${repo}/pulls`) {
      if (!may(init, "pull_requests")) return forbidden();
      const opened = body(init);
      const head = refs.get(opened.head);
      if (head === undefined) return json(422, { message: "head invalid" });
      if (openFrom(opened.head).length > 0)
        return json(422, {
          message: `A pull request already exists for ${owner}:${opened.head}.`,
        });
      const number = pulls.length + 1;
      const pull = {
        number,
        url: `https://github.com/${FIXTURE.fullName}/pull/${number}`,
        state: "open",
        head: opened.head,
        base: opened.base,
        title: opened.title,
        body: opened.body,
        commitSha: head,
        // What the head commit's tree adds onto the base commit's.
        files: trees.get(commits.get(head).tree).files,
      };
      pulls.push(pull);
      return json(201, summary(pull));
    }
    unexpected.push(`${method} ${path}`);
    return json(404, { message: "Not Found" });
  }
  return {
    fetch,
    privateKey,
    calls,
    unexpected,
    treeSha,
    installation,
    pulls,
    refs,
    commits,
  };
}

/**
 * graphify's run (`python/run_graphify.py`) as a function: the outputs the
 * adapter requires, with the fixture's import graph. The adapter itself,
 * and every builder that reads the graph, run as they do in production.
 */
export function graphifyExecute() {
  const node = (path) => ({
    id: `file:${path}`,
    label: path,
    source_file: path,
    community: 0,
  });
  const graph = {
    schemaVersion: 1,
    analysisMode: "ast",
    directed: true,
    multigraph: true,
    nodes: [node(FIXTURE.feeModule), node(FIXTURE.ledgerModule)],
    links: [
      {
        source: `file:${FIXTURE.feeModule}`,
        target: `file:${FIXTURE.ledgerModule}`,
        relation: "imports",
        confidence: "EXTRACTED",
        specifier: "./ledger.js",
        resolved: true,
        source_location: "L1",
      },
    ],
    communities: {
      0: [`file:${FIXTURE.feeModule}`, `file:${FIXTURE.ledgerModule}`],
    },
    unresolvedDependencies: [],
  };
  return async (_python, [, , outDir]) => {
    await mkdir(join(outDir, "wiki"), { recursive: true });
    const graphText = JSON.stringify(graph);
    await writeFile(join(outDir, "graph.json"), graphText);
    await writeFile(
      join(outDir, "graph.html"),
      "<!doctype html><title>graph</title>",
    );
    await writeFile(
      join(outDir, "GRAPH_REPORT.md"),
      "# Structural graph report\n",
    );
    await writeFile(join(outDir, "wiki", "index.md"), "# Community 0\n");
    await writeFile(
      join(outDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        toolVersion: "flow-harness",
        analysisMode: "ast",
        files: graph.nodes.map((entry) => entry.source_file),
        nodes: graph.nodes.length,
        edges: graph.links.length,
        unresolved: 0,
        canonicalGraphSha256: createHash("sha256")
          .update(graphText)
          .digest("hex"),
      }),
    );
    return "";
  };
}

/** The Jira site, board and issue the flow imports a bounty from. */
export const JIRA = {
  cloudId: "flow-cloud",
  siteUrl: "https://orvanta.atlassian.net",
  boardExternalId: "42",
  projectKey: "PAY",
  issue: {
    id: "10007",
    key: "PAY-7",
    summary: "Show the Orvanta fee on the statement",
    // Jira's own rich text, which the import flattens.
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Each debit line on a statement shows the fee it paid, in cents.",
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Credits show no fee." }],
        },
      ],
    },
    components: [{ name: "statements" }],
    updated: "2026-11-10T09:00:00.000+0000",
  },
};

/**
 * Jira's client for the one connection the flow seeds, as `clientFor`
 * hands it to the import route and the sizing run: one board holding one
 * issue. The issue's text goes through `@sandbox-factory/jira`'s own
 * `toIssueSpec`, so its rich text is flattened and hashed as a real read
 * does. A connection other than `connectionId` (set once seeded) answers
 * `not-found`; a read of anything else throws and is kept in `unexpected`.
 */
export function fakeJira() {
  const unexpected = [];
  const calls = [];
  const { issue } = JIRA;
  const signals = {
    id: issue.id,
    key: issue.key,
    summary: issue.summary,
    status: "To Do",
    statusCategory: "new",
    assignee: null,
    priority: "Medium",
    issueType: "Story",
    labels: ["billing"],
    projectKey: JIRA.projectKey,
    parentKey: null,
    created: "2026-11-01T09:00:00.000+0000",
    updated: issue.updated,
    dueDate: null,
    url: `${JIRA.siteUrl}/browse/${issue.key}`,
    subtaskCount: 0,
    sprint: null,
    closedSprints: [],
    votes: null,
    watchers: null,
    links: [],
    releases: [],
  };
  const context = {
    key: issue.key,
    issueType: "Story",
    status: "To Do",
    statusCategory: "new",
    priority: "Medium",
    labels: ["billing"],
    components: issue.components.map(({ name }) => name),
    fixVersions: [],
    parentKey: null,
    dueDate: null,
    storyPoints: 3,
    originalEstimateSeconds: null,
    remainingEstimateSeconds: null,
    votes: null,
    watchers: null,
    subtaskCount: 0,
    links: [],
    updated: issue.updated,
  };
  const only = (what, id) => {
    calls.push(`${what} ${id}`);
    if (String(id) === issue.id) return;
    unexpected.push(`${what} ${id}`);
    throw new Error(`The flow's Jira has no ${what} ${id}.`);
  };
  const client = {
    async boardIssueSignals(boardId, { jql }) {
      calls.push(`boardIssueSignals ${boardId} ${jql}`);
      if (String(boardId) !== JIRA.boardExternalId) {
        unexpected.push(`boardIssueSignals ${boardId}`);
        throw new Error(`The flow's Jira has no board ${boardId}.`);
      }
      const single = /^issue = (\d+)$/.exec(jql);
      return {
        issues: single === null || single[1] === issue.id ? [signals] : [],
      };
    },
    async issueSpec(id) {
      only("issueSpec", id);
      return toIssueSpec(issue.key, issue);
    },
    async issueContext(id) {
      only("issueContext", id);
      return context;
    },
    async issue(id) {
      only("issue", id);
      // The list fields: the signals without what only a scan reads.
      const {
        sprint: _sprint,
        closedSprints: _closed,
        votes: _votes,
        watchers: _watchers,
        links: _links,
        releases: _releases,
        ...listed
      } = signals;
      return listed;
    },
  };
  const jira = {
    connectionId: null,
    calls,
    unexpected,
    async clientFor(_organizationId, connectionId) {
      return connectionId === jira.connectionId
        ? { ok: true, client }
        : { ok: false, reason: "not-found" };
    },
  };
  return jira;
}

/** The bounty the flow prices: the fixture's fee, by amount. */
export const BOUNTY = {
  title: "Charge the Orvanta fee by amount",
  description:
    "A debit pays one percent of its amount, rounded to the cent and never less than the flat 25 cent charge. A credit stays free.",
};

/** What the sizing model answers: three scenarios, s1 to s3, and size S. */
export const SIZING = {
  complexity: "S",
  draft: {
    feature: "Orvanta entry fee by amount",
    background: ["an Orvanta ledger entry in cents"],
    scenarios: [
      {
        kind: "happy",
        title: "a credit is free",
        steps: [
          { keyword: "Given", text: "a credit of 10000 cents" },
          { keyword: "Then", text: "its fee is 0 cents" },
        ],
        weight: "covered",
        weightReason: "credits are already free",
      },
      {
        kind: "happy",
        title: "a debit pays one percent, rounded",
        steps: [
          { keyword: "Given", text: "a debit of 4250 cents" },
          { keyword: "Then", text: "its fee is 43 cents" },
        ],
        weight: "light",
        weightReason: "one formula in one function",
      },
      {
        kind: "boundary",
        title: "a small debit pays the 25 cent minimum",
        steps: [
          { keyword: "Given", text: "a debit of 100 cents" },
          { keyword: "Then", text: "its fee is 25 cents" },
        ],
        weight: "covered",
        weightReason: "the flat charge is the minimum",
      },
    ],
    openQuestions: [],
    assumptions: ["Half a cent rounds up."],
    repositories: ["Repository 1"],
  },
};

/**
 * A `StructuredCaller` that answers each tool from `SIZING`, through the
 * tool's own `render` and `parse`, so the stored draft and size are what
 * the parser makes of a model's answer.
 */
export function sizingCaller() {
  const calls = [];
  return {
    model: "flow-sizing-model",
    calls,
    async call(tool, input, options = {}) {
      const prompt = tool.render(input);
      calls.push({ tool: tool.name, prompt });
      const raw =
        tool.name === "draft_spec"
          ? SIZING.draft
          : tool.name === "size_bounty"
            ? {
                complexity: SIZING.complexity,
                confidence: "high",
                rationale: "One function's formula and its three cases.",
              }
            : undefined;
      if (raw === undefined)
        throw new Error(
          `The flow's sizing model has no answer for ${tool.name}.`,
        );
      const parsed = tool.parse(raw);
      if (!parsed.ok)
        throw new Error(
          `${tool.name} refused the scripted answer: ${parsed.problem}`,
        );
      const usage = { inputTokens: 100, outputTokens: 50 };
      options.onReply?.({ model: this.model, usage });
      return { result: parsed.value, actualModel: this.model, usage };
    },
  };
}

let callIds = 0;
const call = (name, input) => ({
  type: "tool_use",
  id: `flow-${name}-${(callIds += 1)}`,
  name,
  input,
});
const turn = (content, stopReason = "tool_use") => ({
  content,
  stopReason,
  usage: {
    inputTokens: 200,
    outputTokens: 80,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
});
const textOf = (content) =>
  typeof content === "string"
    ? content
    : content.map((block) => block.text ?? block.content ?? "").join("\n");

/**
 * The files a prompt quotes as `--- path\n<text>`, by path; the prompt's
 * sections after the last one quoted (`hiddenTestsSection`) are cut off.
 */
function quotedFiles(prompt) {
  const files = new Map();
  const parts = prompt.split(/\n--- (\S+)\n/);
  for (let index = 1; index + 1 < parts.length; index += 2)
    files.set(
      parts[index],
      parts[index + 1]
        .split(
          /\n\n(?:Not quoted, for want of room|A file per scenario, drafted by rule)/,
        )[0]
        .replace(/\s+$/, "\n"),
    );
  return files;
}

/**
 * One model for every agent of the flow, each told apart by the submit tool
 * it is given. The scope agent checks a slice and submits the fee module;
 * the hidden-tests agent reads the generated project from its prompt and
 * writes one test per scenario at the scaffold's paths, in the names the
 * build gave the code; the reference agent fixes the fee in those names.
 * Any other agent, or a turn past a script's end, ends the agent with no
 * answer, and is recorded in `unexpected`.
 */
export function scriptedAgents() {
  const learned = { feesPath: null, feesText: null, fn: null };
  const unexpected = [];
  const errors = [];
  const agents = [];
  const scripts = {
    submit_scope: () => {
      const request = {
        entryPoints: [FIXTURE.feeModule],
        maxFiles: 2,
        maxDepth: 3,
        includeInferred: false,
      };
      return [
        turn([call("check_scope", request)]),
        turn([
          call("submit_scope", {
            entryPoints: [
              { path: FIXTURE.feeModule, reason: "The fee is computed here." },
            ],
            maxFiles: request.maxFiles,
            maxDepth: request.maxDepth,
            includeInferred: false,
            seams: [
              {
                module: FIXTURE.ledgerModule,
                kind: "other",
                reason: "Only the entry type is read from the ledger.",
              },
            ],
            summary:
              "The developer changes how the fee module charges a debit. The ledger stays a stub.",
            risks: ["Rounding of half cents."],
            pattern: null,
          }),
        ]),
      ];
    },
    submit_hidden_tests: (prompt) => {
      const files = quotedFiles(prompt);
      const fees = [...files].find(
        ([path]) => path.startsWith("src/") && path.endsWith("/fees.ts"),
      );
      if (fees === undefined)
        throw new Error("The hidden-tests prompt quotes no fee module.");
      const [feesPath, feesText] = fees;
      const fn = /export function (\w+)\(/.exec(feesText)?.[1];
      if (fn === undefined)
        throw new Error(`${feesPath} exports no function the tests can call.`);
      Object.assign(learned, { feesPath, feesText, fn });
      const scaffold = [...files.keys()].filter((path) =>
        /^tests\/private\/s\d+-.*\.test\.ts$/.test(path),
      );
      const pathFor = (id, fallback) =>
        scaffold.find((path) => path.startsWith(`tests/private/${id}-`)) ??
        `tests/private/${id}-${fallback}.test.ts`;
      const specifier = `../../${feesPath.replace(/\.ts$/, ".js")}`;
      const test = (id, slug, body, expectedBaseline) => ({
        path: pathFor(id, slug),
        text: `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${fn} } from "${specifier}";\n\n${body}\n`,
        expectedBaseline,
      });
      const tests = [
        test(
          "s1",
          "a-credit-is-free",
          `test("a credit is free", () => {\n  assert.equal(${fn}({ amountCents: 10000, kind: "credit" }), 0);\n});`,
          "pass",
        ),
        test(
          "s2",
          "a-debit-pays-one-percent-rounded",
          `test("a debit pays one percent, rounded", () => {\n  assert.equal(${fn}({ amountCents: 10000, kind: "debit" }), 100);\n  assert.equal(${fn}({ amountCents: 4250, kind: "debit" }), 43);\n});`,
          "fail",
        ),
        test(
          "s3",
          "a-small-debit-pays-the-25-cent-minimum",
          `test("a small debit pays the 25 cent minimum", () => {\n  assert.equal(${fn}({ amountCents: 100, kind: "debit" }), 25);\n});`,
          "pass",
        ),
      ];
      return [
        turn([
          call("submit_hidden_tests", {
            tests,
            summary:
              "One test per scenario: credits, the percentage and the minimum.",
          }),
        ]),
      ];
    },
    submit_reference: () => {
      if (learned.feesText === null)
        throw new Error(
          "The reference ran before the hidden tests were written.",
        );
      const fixed = learned.feesText.replace(
        /return (\w+)\.kind === "debit" \? (\w+) : 0;/,
        'return $1.kind === "debit"\n    ? Math.max($2, Math.round($1.amountCents / 100))\n    : 0;',
      );
      if (fixed === learned.feesText)
        throw new Error(
          `${learned.feesPath} is not the fee the reference fixes.`,
        );
      return [
        turn([
          call("submit_reference", {
            files: [{ path: learned.feesPath, text: fixed }],
            summary:
              "Charges one percent, rounded, with the flat charge as the minimum.\nnone",
          }),
        ]),
      ];
    },
  };
  const running = new Map();
  return {
    model: "flow-agent-model",
    learned,
    unexpected,
    errors,
    agents,
    async turn(request) {
      const submit = request.tools
        .map((tool) => tool.name)
        .find((name) => name.startsWith("submit_"));
      const first = request.messages.length === 1;
      if (!first) {
        const last = request.messages.at(-1);
        for (const block of Array.isArray(last?.content) ? last.content : [])
          if (block.is_error === true)
            errors.push(
              `${submit}: ${textOf(block.content ?? "")}`.slice(0, 2_000),
            );
      }
      if (first) {
        const script = scripts[submit];
        if (script === undefined) {
          unexpected.push(submit ?? "(no submit tool)");
          return turn([{ type: "text", text: "No answer." }], "end_turn");
        }
        agents.push(submit);
        running.set(submit, script(textOf(request.messages[0].content)));
      }
      const next = running.get(submit)?.shift();
      if (next !== undefined) return next;
      unexpected.push(`${submit} asked past its script`);
      return turn([{ type: "text", text: "No answer." }], "end_turn");
    },
  };
}
