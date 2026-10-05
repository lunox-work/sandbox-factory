import { userEvent } from "@testing-library/user-event";
import { openCombobox } from "./combobox";
import { render, screen, fireEvent, waitFor, within } from "./render";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AnalysisRunDto,
  ArtifactDto,
  FixtureSetDto,
  GithubRepoDto,
  ScopeProposalDto,
} from "@sandbox-factory/shared";
import { RepositoryAnalysis } from "../src/RepositoryAnalysis";

const stamp = "2026-10-03T00:00:00.000Z";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
const task = { proposalId: "bpr_1", specRevision: 2, specHash: "h" };
const scopeRun: AnalysisRunDto = {
  ...graphRun,
  id: "arn_scope",
  tool: "scope",
  createdAt: "2026-10-03T01:00:00.000Z",
  params: { deadlineMinutes: 30, agent: "scope", graphRunId: "arn_1", ...task },
};
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
const fixturesRun: AnalysisRunDto = {
  ...graphRun,
  id: "arn_fixtures",
  tool: "fixtures",
  createdAt: "2026-10-03T03:00:00.000Z",
  params: {
    deadlineMinutes: 30,
    agent: "fixtures",
    sliceRunId: "arn_slice",
    ...task,
  },
};
const usage = {
  model: "claude-opus-5-5",
  turns: 6,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 9000,
  cacheWriteTokens: 300,
};
const proposal: ScopeProposalDto = {
  schemaVersion: 1,
  toolVersion: "scope@1",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_1",
  proposalId: "bpr_1",
  specRevision: 2,
  entryPoints: [
    { path: "src/rules.ts", reason: "the discount rule changes here" },
    { path: "src/app.ts", reason: "calls the rule" },
  ],
  budget: { maxFiles: 8, maxDepth: 0 },
  includeInferred: true,
  seams: [{ module: "lib/db.ts", kind: "database", reason: "queries orders" }],
  summary: "The developer changes how discounts stack.",
  risks: ["The price cache is mocked."],
  check: {
    stubCoverage: "full",
    ready: true,
    includedFiles: 2,
    outboundModules: 1,
    blockers: 0,
  },
  usage,
};
const fixtureSet: FixtureSetDto = {
  schemaVersion: 1,
  toolVersion: "fixtures@1",
  sliceRunId: "arn_slice",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  proposalId: "bpr_1",
  specRevision: 2,
  fixtures: [
    {
      module: "lib/db.ts",
      symbol: "db",
      member: "orders.find",
      call: "call",
      implementation: "async (id) => ({ id, total: 40 })",
      reason: "an order to discount",
    },
    {
      module: "lib/db.ts",
      symbol: "Client",
      member: null,
      call: "construct",
      implementation: "() => ({ open: true })",
      reason: "a client",
    },
  ],
  scenario: 'import { run } from "../src/app.js";\nconsole.log(run());\n',
  summary: "Walks a discounted order.",
  usage,
};
const artifact = (
  runId: string,
  path: string,
  kind: ArtifactDto["kind"],
  meta: Record<string, unknown>,
): ArtifactDto => ({
  id: `art_${path}`,
  runId,
  kind,
  path,
  contentType: "application/json",
  sizeBytes: 1,
  sha256: "c".repeat(64),
  meta,
  createdAt: stamp,
});
const proposals = [
  {
    id: "bpr_1",
    issueKey: "SHOP-7",
    title: "Stack discounts",
    status: "approved",
    specRevision: 2,
    boardId: "jbd_1",
    boardName: "Shop",
    createdAt: stamp,
  },
  {
    id: "bpr_2",
    issueKey: "SHOP-8",
    title: null,
    status: "proposed",
    specRevision: 1,
    boardId: "jbd_1",
    boardName: "Shop",
    createdAt: stamp,
  },
];

/** A fake API: the given runs, their artifacts, and the agent endpoints. */
function server(options: {
  runs: () => AnalysisRunDto[];
  onScope?: (body: unknown) => void;
  onFixtures?: (url: string, body: unknown) => void;
  onSlice?: (body: unknown) => void;
  proposals?: unknown;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown;
    if (url.endsWith("/snapshots")) body = { snapshots: [snapshot] };
    else if (url.endsWith("/proposals")) {
      if (options.proposals === "fail")
        return new Response('{"error":"Proposals are down"}', { status: 502 });
      body = { proposals: options.proposals ?? proposals };
    } else if (url.endsWith("/scope")) {
      options.onScope?.(JSON.parse(String(init?.body)));
      body = { run: scopeRun, graphRun };
    } else if (url.endsWith("/fixtures")) {
      options.onFixtures?.(url, JSON.parse(String(init?.body)));
      body = { run: fixturesRun };
    } else if (url.endsWith("/slices")) {
      options.onSlice?.(JSON.parse(String(init?.body)));
      body = { run: sliceRun, graphRun };
    } else if (url.includes("/tree"))
      body = { entries: [], nextCursor: null, truncated: false };
    else if (url.endsWith("/repositories/ghr_1/runs"))
      body = { runs: options.runs() };
    else if (url.endsWith("/artifacts"))
      body = {
        artifacts: url.includes("arn_scope")
          ? [
              artifact(
                "arn_scope",
                "scope-proposal.json",
                "scope_proposal",
                proposal as unknown as Record<string, unknown>,
              ),
            ]
          : url.includes("arn_fixtures")
            ? [
                artifact(
                  "arn_fixtures",
                  "fixture-set.json",
                  "fixture_set",
                  fixtureSet as unknown as Record<string, unknown>,
                ),
              ]
            : [],
      };
    else {
      const id = url.split("/runs/")[1];
      const found = options.runs().find((run) => run.id === id);
      if (found === undefined)
        return new Response('{"error":"Not found"}', { status: 404 });
      body = { run: found };
    }
    return new Response(JSON.stringify(body));
  });
}

test("an owner asks the agent for a scope, reviews it, and slices exactly that request", async () => {
  let runs: AnalysisRunDto[] = [graphRun];
  const scopes: unknown[] = [];
  const slices: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    server({
      runs: () => runs,
      onScope: (body) => {
        scopes.push(body);
        runs = [scopeRun, graphRun];
      },
      onSlice: (body) => slices.push(body),
    }),
  );
  render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable
      onClose={() => {}}
    />,
  );
  await screen.findByText(/10 files/);
  fireEvent.click(screen.getByRole("button", { name: "Suggest with agent" }));
  const picker = await screen.findByRole("combobox", { name: "Bounty" });
  expect(picker.textContent).toBe("SHOP-7 · Stack discounts");
  // The list says where each one stands.
  const list = await openCombobox(picker);
  expect(
    within(list).getByRole("option", { name: /SHOP-8 · Untitled/ }).textContent,
  ).toContain("proposed, Shop");
  await userEvent.keyboard("{Escape}");
  expect(screen.getByText(/Nothing is sliced until you review/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Suggest scope" }));
  await screen.findByText("Scope suggestion");
  expect(scopes).toEqual([{ proposalId: "bpr_1", snapshotId: "rsn_1" }]);
  await screen.findByText("The developer changes how discounts stack.");
  expect(screen.getByText("Slices cleanly")).toBeTruthy();
  expect(screen.getByText("the discount rule changes here")).toBeTruthy();
  expect(screen.getByText("queries orders")).toBeTruthy();
  expect(screen.getByText("The price cache is mocked.")).toBeTruthy();
  expect(
    screen.getByText(/6 turns · 10,500 tokens \(9,000 cached\)/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use this scope" }));
  // The picker opens on the proposal's request, for review.
  await screen.findByRole("button", { name: "Remove src/app.ts" });
  expect(
    screen.getByRole("button", { name: "Remove src/rules.ts" }),
  ).toBeTruthy();
  expect((screen.getByLabelText("Max files") as HTMLInputElement).value).toBe(
    "8",
  );
  expect((screen.getByLabelText("Max depth") as HTMLInputElement).value).toBe(
    "0",
  );
  expect(screen.getByText("Follows inferred relations")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Slice now" }));
  await waitFor(() => expect(slices).toHaveLength(1));
  expect(slices[0]).toEqual({
    snapshotId: "rsn_1",
    entryPoints: ["src/app.ts", "src/rules.ts"],
    budget: { maxFiles: 8, maxDepth: 0 },
    includeInferred: true,
  });
});

test("a succeeded slice gets fake data written for a bounty, shown for review", async () => {
  let runs: AnalysisRunDto[] = [sliceRun, graphRun];
  const requests: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    server({
      runs: () => runs,
      onFixtures: (url, body) => {
        requests.push({ url, body });
        runs = [fixturesRun, sliceRun, graphRun];
      },
    }),
  );
  render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable
      onClose={() => {}}
    />,
  );
  await screen.findByText(/Slice \(1 entry point\)/);
  fireEvent.click(screen.getByRole("button", { name: "Write fake data" }));
  const bounty = await screen.findByRole("combobox", { name: "Bounty" });
  expect(bounty.textContent).toBe("SHOP-7 · Stack discounts");
  // Found by its status, which only the list shows beside it.
  const list = await openCombobox(bounty);
  await userEvent.type(
    within(document.body).getByRole("combobox", { name: "Search bounty" }),
    "proposed",
  );
  expect(within(list).getAllByRole("option")).toHaveLength(1);
  await userEvent.keyboard("{Enter}");
  expect(bounty.textContent).toBe("SHOP-8 · Untitled");
  fireEvent.click(screen.getByRole("button", { name: "Write fake data" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.url).toMatch(/\/runs\/arn_slice\/fixtures$/);
  expect(requests[0]?.body).toEqual({ proposalId: "bpr_2" });
  await screen.findByText("Walks a discounted order.");
  expect(screen.getByText("lib/db.ts · db.orders.find")).toBeTruthy();
  expect(screen.getByText("lib/db.ts · new Client")).toBeTruthy();
  expect(screen.getByText("async (id) => ({ id, total: 40 })")).toBeTruthy();
  expect(screen.getByText(/console\.log\(run\(\)\);/)).toBeTruthy();
  expect(screen.getByText(/Fixtures \(2\)/)).toBeTruthy();
});

test("the bounty picker explains an empty list and reports a failed one; members only read", async () => {
  vi.stubGlobal("fetch", server({ runs: () => [graphRun], proposals: [] }));
  const { unmount } = render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable
      onClose={() => {}}
    />,
  );
  await screen.findByText(/10 files/);
  fireEvent.click(screen.getByRole("button", { name: "Suggest with agent" }));
  await screen.findByText(/No proposal with a spec is on a board linked/);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("button", { name: "Suggest with agent" }),
  ).toBeTruthy();
  unmount();
  vi.stubGlobal("fetch", server({ runs: () => [graphRun], proposals: "fail" }));
  const second = render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable
      onClose={() => {}}
    />,
  );
  await screen.findByText(/10 files/);
  fireEvent.click(screen.getByRole("button", { name: "Suggest with agent" }));
  await screen.findByText("Proposals are down");
  second.unmount();
  // A member sees a finished proposal, but cannot use it or ask for more.
  vi.stubGlobal("fetch", server({ runs: () => [scopeRun, graphRun] }));
  render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable={false}
      onClose={() => {}}
    />,
  );
  await screen.findByText("The developer changes how discounts stack.");
  expect(screen.queryByRole("button", { name: "Use this scope" })).toBe(null);
  expect(screen.queryByRole("button", { name: "Suggest with agent" })).toBe(
    null,
  );
});

test("agent failures and every run kind read plainly in the history", async () => {
  const failed: AnalysisRunDto = {
    ...scopeRun,
    status: "failed",
    errorCode: "agent_incomplete",
  };
  const unavailable: AnalysisRunDto = {
    ...fixturesRun,
    status: "failed",
    errorCode: "agent_unavailable",
  };
  const build: AnalysisRunDto = {
    ...graphRun,
    id: "arn_build",
    tool: "sandbox_build",
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
  vi.stubGlobal(
    "fetch",
    server({ runs: () => [failed, unavailable, build, graphRun] }),
  );
  render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable
      onClose={() => {}}
    />,
  );
  await screen.findByText(/The agent stopped without an answer/);
  expect(screen.getByText(/No agent model is configured/)).toBeTruthy();
  expect(screen.getByText(/Scope suggestion ·/)).toBeTruthy();
  expect(screen.getByText(/Fake data ·/)).toBeTruthy();
  expect(screen.getByText(/Sandbox build ·/)).toBeTruthy();
});
