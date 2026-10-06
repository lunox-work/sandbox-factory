/**
 * A repository's own page: the context builders and what they built.
 *
 * What it must get right: an owner can start each builder on the chosen
 * snapshot and sees the card follow the run; a member can read and open
 * artifacts but start nothing; each builder's result is drawn from the
 * summary its artifacts carry; the runs a bounty made are still readable
 * here, with nothing left that would make one; and a failed read is said
 * rather than shown as an empty history.
 *
 * The server is faked at `fetch`, routed by method and path suffix.
 */

import { CONTEXT_BUILDERS } from "sandbox-factory";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AnalysisRunDto,
  ArtifactDto,
  DeepwikiSummaryDto,
  DependencyCruiserSummaryDto,
  GithubRepoDto,
  ScopeProposalDto,
  SliceBoundarySummaryDto,
} from "@sandbox-factory/shared";

import { RepositoryPage } from "../src/Repository";
import { cleanup, fireEvent, render, screen, waitFor, within } from "./render";

const stamp = "2026-10-01T00:00:00.000Z";
const repo: GithubRepoDto = {
  id: "ghr_1",
  connectionId: "ghc_1",
  role: "source",
  externalId: "1",
  fullName: "acme/widgets",
  defaultBranch: "main",
  isPrivate: true,
  sizeKb: 1,
  headSha: "a".repeat(40),
  pushedAt: stamp,
  lastSyncedAt: stamp,
  syncStatus: "ok",
  syncError: null,
  stack: null,
  createdAt: stamp,
};
const snapshot = {
  id: "rsn_1",
  repoId: repo.id,
  commitSha: repo.headSha,
  ref: "refs/heads/main",
  treeSha: "b".repeat(40),
  treeTruncated: false,
  fileCount: 10,
  totalBytes: 1024,
  languages: { TypeScript: 1024 },
  createdAt: stamp,
};
const graphRun: AnalysisRunDto = {
  id: "arn_1",
  snapshotId: snapshot.id,
  repoId: repo.id,
  tool: "graphify",
  toolVersion: "test",
  params: { deadlineMinutes: 30 },
  status: "succeeded",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  startedAt: stamp,
  finishedAt: stamp,
  deadlineAt: stamp,
  createdAt: stamp,
};
/** A fresh run of a builder, as the API answers a POST. */
function queuedRun(tool: AnalysisRunDto["tool"]): AnalysisRunDto {
  const base = {
    ...graphRun,
    id: `arn_${tool}`,
    status: "queued" as const,
    startedAt: null,
    finishedAt: null,
  };
  switch (tool) {
    case "dependency_cruiser":
      return { ...base, tool, params: { deadlineMinutes: 30, builder: tool } };
    case "deepwiki":
      return { ...base, tool, params: { deadlineMinutes: 30, builder: tool } };
    default:
      return { ...base, tool: "graphify", params: { deadlineMinutes: 30 } };
  }
}
const artifact = (
  runId: string,
  path: string,
  kind: ArtifactDto["kind"],
  meta: Record<string, unknown> | null = null,
  id = `art_${path.replace(/[^a-z0-9]+/gi, "_")}`,
): ArtifactDto => ({
  id,
  runId,
  kind,
  path,
  contentType: "application/octet-stream",
  sizeBytes: 2048,
  sha256: "c".repeat(64),
  meta,
  createdAt: stamp,
});

interface Server {
  runs: AnalysisRunDto[];
  artifacts?: Record<string, ArtifactDto[]>;
  repositories?: GithubRepoDto[];
}

/** A fake API, routed by method and the end of the path. */
function server(options: Server) {
  const calls: string[] = [];
  const posts: unknown[] = [];
  let runs = options.runs;
  const repositories = options.repositories ?? [repo];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    let body: unknown;
    if (method === "DELETE" && url.endsWith("/github/repositories/ghr_1")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/github/repositories")) body = { repositories };
    else if (url.endsWith("/snapshots")) body = { snapshots: [snapshot] };
    else if (url.endsWith("/repositories/ghr_1/runs")) {
      if (method === "POST") {
        const input = JSON.parse(String(init?.body)) as {
          tool: AnalysisRunDto["tool"];
        };
        posts.push(input);
        const run = queuedRun(input.tool);
        runs = [run, ...runs];
        body = { run };
      } else body = { runs };
    } else if (url.endsWith("/artifacts")) {
      const id = url.split("/runs/")[1]?.split("/")[0] ?? "";
      body = { artifacts: options.artifacts?.[id] ?? [] };
    } else if (url.endsWith("/url"))
      body = { url: "https://objects.test/signed" };
    else if (url.includes("/runs/")) {
      const id = url.split("/runs/")[1] ?? "";
      const found = runs.find((run) => run.id === id);
      if (found === undefined)
        return new Response('{"error":"Not found"}', { status: 404 });
      body = { run: found };
    } else return new Response('{"error":"Not found"}', { status: 404 });
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, posts };
}

function renderPage(role = "owner") {
  const onName = vi.fn();
  const onRemoved = vi.fn();
  render(
    <RepositoryPage
      organizationId="org_1"
      organizationSlug="acme"
      repoId="ghr_1"
      role={role}
      onName={onName}
      onRemoved={onRemoved}
    />,
  );
  return { onName, onRemoved };
}

function builderCard(name: string) {
  return screen.getByRole("region", { name: `${name} builder` });
}

/** A new tab, as `window.open` answers it, with what the page sets on it. */
function spyOnOpen() {
  const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  return tab;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the page names the repository, and owners see a card per builder", async () => {
  server({ runs: [] });
  const { onName } = renderPage();
  expect(
    await screen.findByRole("heading", { name: "acme/widgets", level: 1 }),
  ).toBeTruthy();
  await waitFor(() => expect(onName).toHaveBeenCalledWith("acme/widgets"));
  await screen.findByText(/10 files/);
  expect(screen.getByText("Private")).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: /github\.com\/acme\/widgets/ })
      .getAttribute("href"),
  ).toBe("https://github.com/acme/widgets");
  const names = ["Graphify", "Dependency Cruiser", "DeepWiki Open"];
  const cards = screen.getAllByRole("region", { name: / builder$/ });
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(
    names.map((name) => `${name} builder`),
  );
  for (const name of names) {
    expect(within(builderCard(name)).getByText("Not built")).toBeTruthy();
    expect(
      within(builderCard(name)).getByRole("button", { name: "Build" }),
    ).toBeTruthy();
  }
  expect(screen.getByText("No runs yet.")).toBeTruthy();
});

test("Build on Graphify posts the builder and the snapshot, and the card follows the run", async () => {
  const f = server({ runs: [] });
  renderPage();
  await screen.findByText(/10 files/);
  fireEvent.click(
    within(builderCard("Graphify")).getByRole("button", { name: "Build" }),
  );
  await within(builderCard("Graphify")).findByText("Building…");
  expect(f.posts).toEqual([{ tool: "graphify", snapshotId: "rsn_1" }]);
  await within(builderCard("Graphify")).findByText("Queued");
  expect(
    (
      within(builderCard("Graphify")).getByRole("button", {
        name: "Building…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  // The other builders are untouched.
  expect(
    within(builderCard("Dependency Cruiser")).getByRole("button", {
      name: "Build",
    }),
  ).toBeTruthy();
  expect(f.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
});

test.each(CONTEXT_BUILDERS)(
  "Build on %s posts that builder",
  async (builder) => {
    const f = server({ runs: [] });
    renderPage();
    await screen.findByText(/10 files/);
    const names = {
      graphify: "Graphify",
      dependency_cruiser: "Dependency Cruiser",
      deepwiki: "DeepWiki Open",
    };
    fireEvent.click(
      within(builderCard(names[builder])).getByRole("button", {
        name: "Build",
      }),
    );
    await within(builderCard(names[builder])).findByText("Queued");
    expect(f.posts).toEqual([{ tool: builder, snapshotId: "rsn_1" }]);
  },
);

test("a member opens artifacts through a signed URL but cannot build or read logs", async () => {
  const f = server({
    runs: [graphRun],
    artifacts: { arn_1: [artifact("arn_1", "graph.html", "graph_html")] },
  });
  const tab = spyOnOpen();
  renderPage("member");
  fireEvent.click(await screen.findByRole("button", { name: "graph.html" }));
  await waitFor(() =>
    expect(tab.location.href).toBe("https://objects.test/signed"),
  );
  expect(tab.opener).toBe(null);
  expect(f.calls.some((c) => c.endsWith("/artifacts/art_graph_html/url"))).toBe(
    true,
  );
  expect(screen.queryByRole("button", { name: "Build" })).toBe(null);
  expect(screen.queryByRole("button", { name: "Building…" })).toBe(null);
  expect(screen.queryByRole("button", { name: "Open run log" })).toBe(null);
  expect(screen.queryByRole("button", { name: /Remove/ })).toBe(null);
  // Built, so there is something to view; "Open graph" opens the same artifact.
  expect(within(builderCard("Graphify")).getByText("Built")).toBeTruthy();
  expect(
    within(builderCard("Graphify")).getByRole("button", { name: "View" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open graph" })).toBeTruthy();
  expect(screen.getByText(/SHA-256/)).toBeTruthy();
});

test("a failed run shows its error and the retry cap; admins open the log", async () => {
  server({
    runs: [
      { ...graphRun, status: "failed", attempt: 2, errorCode: "too_large" },
    ],
  });
  const tab = spyOnOpen();
  renderPage();
  const card = await screen.findByRole("region", { name: "Graphify builder" });
  await within(card).findByText(/source size limit/);
  expect(within(card).getByText("Failed")).toBeTruthy();
  expect(
    (
      within(card).getByRole("button", {
        name: "Retry limit reached",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open run log" }));
  await waitFor(() =>
    expect(tab.location.href).toBe("https://objects.test/signed"),
  );
});

test("a failed run with retries left offers Build again, and says why it failed", async () => {
  server({
    runs: [
      {
        ...queuedRun("deepwiki"),
        status: "failed",
        attempt: 0,
        errorCode: "builder_unavailable",
      },
    ],
  });
  renderPage();
  const card = await screen.findByRole("region", {
    name: "DeepWiki Open builder",
  });
  await within(card).findByText(
    "This builder is not configured on the worker.",
  );
  expect(within(card).getByRole("button", { name: "Build" })).toBeTruthy();
});

test("the API's refusal of a build is shown on the page", async () => {
  server({ runs: [] });
  renderPage();
  await screen.findByText(/10 files/);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(
            '{"error":"The active analysis limit has been reached."}',
            { status: 409 },
          )
        : new Response(
            JSON.stringify(
              url.endsWith("/snapshots")
                ? { snapshots: [snapshot] }
                : url.endsWith("/github/repositories")
                  ? { repositories: [repo] }
                  : { runs: [] },
            ),
          ),
    ),
  );
  fireEvent.click(
    within(builderCard("Dependency Cruiser")).getByRole("button", {
      name: "Build",
    }),
  );
  await screen.findByText("The active analysis limit has been reached.");
});

const cruise: DependencyCruiserSummaryDto = {
  schemaVersion: 1,
  toolVersion: "dependency-cruiser@18",
  counts: {
    modules: 12,
    dependencies: 30,
    circular: 1,
    orphans: 2,
    unresolved: 1,
    external: 4,
  },
  modules: [
    { source: "src/app.ts", dependents: 3, dependencies: 2 },
    { source: "src/lib/db.ts", dependents: 1, dependencies: 1 },
  ],
  cycles: [["src/a.ts", "src/b.ts"]],
  orphans: ["src/unused.ts", "src/old.ts"],
  unresolved: [{ from: "src/app.ts", module: "./missing" }],
  truncated: true,
};

test("a Dependency Cruiser run draws its counts, the busiest modules and the cycles", async () => {
  const run: AnalysisRunDto = {
    ...queuedRun("dependency_cruiser"),
    status: "succeeded",
    startedAt: stamp,
    finishedAt: stamp,
  };
  const f = server({
    runs: [run],
    artifacts: {
      [run.id]: [
        artifact(
          run.id,
          "manifest.json",
          "manifest",
          cruise as unknown as Record<string, unknown>,
        ),
        artifact(run.id, "dependency-cruiser.json", "dependency_graph"),
        artifact(run.id, "dependency-cruiser.dot", "dependency_dot"),
      ],
    },
  });
  const tab = spyOnOpen();
  renderPage();
  await screen.findByText("Most connected modules");
  // The tiles, label over value.
  const tile = (label: string) =>
    screen.getByText(label, { selector: "dt" }).parentElement?.textContent;
  expect(tile("Modules")).toBe("Modules12");
  expect(tile("Cycles")).toBe("Cycles1");
  // Bars are sized against the busiest module.
  const bars = screen.getAllByTestId("module-bar");
  expect(bars.map((bar) => bar.style.width)).toEqual(["100%", "40%"]);
  expect(screen.getByText("3 in · 2 out")).toBeTruthy();
  expect(screen.getByText("src/a.ts → src/b.ts → src/a.ts")).toBeTruthy();
  expect(screen.getByText("src/unused.ts")).toBeTruthy();
  expect(screen.getByText(/summary was truncated/)).toBeTruthy();
  // The card carries the headline figures of the selected run.
  const card = builderCard("Dependency Cruiser");
  expect(within(card).getByText("Built")).toBeTruthy();
  expect(
    within(card).getByText("modules").previousElementSibling?.textContent,
  ).toBe("12");
  fireEvent.click(screen.getByRole("button", { name: "Open DOT" }));
  await waitFor(() =>
    expect(tab.location.href).toBe("https://objects.test/signed"),
  );
  expect(
    f.calls.some((c) =>
      c.endsWith("/artifacts/art_dependency_cruiser_dot/url"),
    ),
  ).toBe(true);
});

const wiki: DeepwikiSummaryDto = {
  schemaVersion: 1,
  toolVersion: "deepwiki-open@driver-1",
  title: "Widgets",
  description: "How widgets are made.",
  provider: "openai",
  model: "gpt-5",
  repositoryUrl: "https://github.com/acme/widgets",
  requestedCommitSha: "a".repeat(40),
  pages: [
    {
      id: "overview",
      title: "Overview",
      importance: "high",
      filePaths: ["README.md", "src/index.ts"],
      relatedPages: ["api"],
      path: "wiki/overview.md",
    },
    {
      id: "api",
      title: "API",
      importance: "low",
      filePaths: [],
      relatedPages: [],
      path: "wiki/api.md",
    },
  ],
  sections: [{ id: "s1", title: "Getting started", pages: ["overview"] }],
};

test("a DeepWiki run groups its pages by importance, and Open page opens that page", async () => {
  const run: AnalysisRunDto = {
    ...queuedRun("deepwiki"),
    status: "succeeded",
    startedAt: stamp,
    finishedAt: stamp,
  };
  const f = server({
    runs: [run],
    artifacts: {
      [run.id]: [
        artifact(
          run.id,
          "wiki-structure.json",
          "wiki_structure",
          wiki as unknown as Record<string, unknown>,
        ),
        artifact(run.id, "wiki/overview.md", "wiki_page", null, "art_overview"),
        artifact(run.id, "wiki/api.md", "wiki_page", null, "art_api"),
      ],
    },
  });
  const tab = spyOnOpen();
  renderPage("member");
  const key = await screen.findByRole("list", { name: "Key pages" });
  expect(within(key).getByText("Overview")).toBeTruthy();
  expect(within(key).getByText("README.md")).toBeTruthy();
  expect(within(key).getByText("1 related page")).toBeTruthy();
  expect(
    within(screen.getByRole("list", { name: "Reference pages" })).getByText(
      "API",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Supporting pages" })).toBe(null);
  expect(screen.getByText("openai · gpt-5")).toBeTruthy();
  expect(screen.getByText(/default branch at run time/).textContent).toContain(
    "asked for aaaaaaa",
  );
  expect(screen.getByText("Getting started")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open page API" }));
  await waitFor(() =>
    expect(tab.location.href).toBe("https://objects.test/signed"),
  );
  expect(f.calls.some((c) => c.endsWith("/artifacts/art_api/url"))).toBe(true);
});

const boundary: SliceBoundarySummaryDto = {
  schemaVersion: 1,
  language: "typescript",
  stubCoverage: "partial",
  ready: false,
  counts: {
    includedFiles: 2,
    includedBytes: 10,
    outboundModules: 1,
    inboundModules: 0,
    stubs: 2,
    publicSymbols: 1,
    externals: 0,
    blockers: 0,
  },
  included: ["src/app.ts"],
  outbound: [],
  inbound: [],
  externals: { packages: [], environment: [] },
  blockers: [],
  truncated: false,
};
const usage = {
  model: "test-model",
  turns: 6,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 9000,
  cacheWriteTokens: 300,
};
const proposal: ScopeProposalDto = {
  schemaVersion: 1,
  toolVersion: "scope@2",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_1",
  proposalId: "bpr_1",
  specRevision: 2,
  entryPoints: [{ path: "src/rules.ts", reason: "the rule changes here" }],
  budget: { maxFiles: 8, maxDepth: 0 },
  includeInferred: false,
  seams: [],
  summary: "The developer changes how discounts stack.",
  risks: [],
  check: {
    stubCoverage: "full",
    ready: true,
    includedFiles: 2,
    outboundModules: 1,
    blockers: 0,
  },
  usage,
};

test("runs a bounty made are readable, with nothing here that would make one", async () => {
  const task = { proposalId: "bpr_1", specRevision: 2, specHash: "h" };
  const sliceRun: AnalysisRunDto = {
    ...graphRun,
    id: "arn_slice",
    tool: "slice",
    createdAt: "2026-10-03T02:00:00.000Z",
    params: {
      deadlineMinutes: 30,
      graphRunId: "arn_1",
      entryPoints: ["src/app.ts"],
      budget: { maxFiles: 5, maxDepth: 0 },
      includeInferred: false,
    },
  };
  const scopeRun: AnalysisRunDto = {
    ...graphRun,
    id: "arn_scope",
    tool: "scope",
    createdAt: "2026-10-03T01:00:00.000Z",
    params: {
      deadlineMinutes: 30,
      agent: "scope",
      graphRunId: "arn_1",
      ...task,
    },
  };
  const fixturesRun: AnalysisRunDto = {
    ...graphRun,
    id: "arn_fixtures",
    tool: "fixtures",
    status: "failed",
    errorCode: "agent_incomplete",
    createdAt: "2026-10-03T00:30:00.000Z",
    params: {
      deadlineMinutes: 30,
      agent: "fixtures",
      sliceRunId: "arn_slice",
      ...task,
    },
  };
  const build: AnalysisRunDto = {
    ...graphRun,
    id: "arn_build",
    tool: "sandbox_build",
    createdAt: "2026-10-03T00:15:00.000Z",
    params: {
      deadlineMinutes: 30,
      sliceRunId: "arn_slice",
      sandboxVersionId: "sbv_1",
      manifestSha256: "1".repeat(64),
      contractSha256: "2".repeat(64),
      transformConfigSha256: "3".repeat(64),
      approvedTaskSha256: "4".repeat(64),
    },
  };
  server({
    runs: [sliceRun, scopeRun, fixturesRun, build, graphRun],
    artifacts: {
      arn_slice: [
        artifact(
          "arn_slice",
          "boundary-contract.json",
          "boundary_contract",
          boundary as unknown as Record<string, unknown>,
        ),
        artifact("arn_slice", "boundary.md", "boundary_md"),
      ],
      arn_scope: [
        artifact(
          "arn_scope",
          "scope-proposal.json",
          "scope_proposal",
          proposal as unknown as Record<string, unknown>,
        ),
      ],
    },
  });
  renderPage();
  // The newest run is selected: the slice, with its boundary.
  await screen.findByText("Diagnostic only");
  expect(screen.getByRole("button", { name: "Open boundary.md" })).toBeTruthy();
  // Every kind reads plainly in the history, failures included.
  const history = screen.getByRole("region", { name: "Run history" });
  expect(within(history).getByText("Slice (1 entry point)")).toBeTruthy();
  expect(within(history).getByText("Scope suggestion")).toBeTruthy();
  expect(within(history).getByText("Fake data")).toBeTruthy();
  expect(within(history).getByText("Sandbox build")).toBeTruthy();
  expect(
    within(history).getByText(/The agent stopped without an answer/),
  ).toBeTruthy();
  fireEvent.click(
    within(history).getByRole("button", { name: /Scope suggestion/ }),
  );
  await screen.findByText("The developer changes how discounts stack.");
  expect(screen.getByText("the rule changes here")).toBeTruthy();
  expect(
    screen.getByText(/6 turns · 10,500 tokens \(9,000 cached\)/),
  ).toBeTruthy();
  // Nothing on the page starts a slice, a suggestion or fake data.
  expect(screen.queryByText("Use this scope")).toBe(null);
  expect(screen.queryByText("Choose entry points")).toBe(null);
  expect(screen.queryByText("Suggest with agent")).toBe(null);
  expect(screen.queryByText("Write fake data")).toBe(null);
  expect(screen.queryByLabelText("Directory filter")).toBe(null);
});

test("loading failures are visible and never rendered as an empty history", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/github/repositories")
        ? new Response(JSON.stringify({ repositories: [repo] }))
        : new Response('{"error":"Analysis unavailable"}', { status: 503 }),
    ),
  );
  renderPage();
  await screen.findByText("Analysis unavailable");
  expect(screen.queryByText("No runs yet.")).toBe(null);
});

test("a repository that failed to sync shows the reason", async () => {
  server({
    runs: [],
    repositories: [
      {
        ...repo,
        syncStatus: "error",
        syncError: "The repository has no commits yet.",
        headSha: null,
        lastSyncedAt: null,
      },
    ],
  });
  renderPage();
  expect(
    await screen.findByText("The repository has no commits yet."),
  ).toBeTruthy();
});

test("the page shows the stack detected in the repository", async () => {
  // Not read yet: the page says it is on the way.
  server({ runs: [] });
  renderPage();
  const reading = await screen.findByTestId("repository-stack");
  expect(within(reading).getByText(/Reading the repository/)).toBeTruthy();
  cleanup();

  server({
    runs: [],
    repositories: [
      { ...repo, stack: ["TypeScript", "PostgreSQL", "Amazon Cognito"] },
    ],
  });
  renderPage();
  const detected = await screen.findByRole("list", { name: "Tech stack" });
  expect(
    within(detected)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["TypeScript", "PostgreSQL", "Amazon Cognito"]);
});

test("an empty stack says nothing was detected", async () => {
  server({ runs: [], repositories: [{ ...repo, stack: [] }] });
  renderPage();
  expect(
    await screen.findByText("Nothing detected at the latest commit."),
  ).toBeTruthy();
});

test("removing asks first, then leaves the page", async () => {
  const f = server({ runs: [] });
  const { onRemoved } = renderPage();
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove acme/widgets" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  expect(f.calls).toContain(
    "DELETE /api/v1/orgs/org_1/github/repositories/ghr_1",
  );
});

test("a repository that is not registered here says so", async () => {
  server({ runs: [], repositories: [] });
  const { onRemoved } = renderPage();
  await screen.findByRole("heading", { name: "Repository unavailable" });
  const link = screen.getByRole("link", {
    name: "View the registered repositories",
  });
  expect(link.getAttribute("href")).toBe("/o/acme/settings?connection=github");
  fireEvent.click(link);
  expect(onRemoved).toHaveBeenCalled();
});
