import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { GithubAnalysisClient } from "@sandbox-factory/client";
import type {
  ArtifactDto,
  SliceBoundarySummaryDto,
} from "@sandbox-factory/shared";
import { SliceBoundary, SliceEntryPicker } from "../src/SliceBuilder";
import { RepositoryAnalysis } from "../src/RepositoryAnalysis";
import type { GithubRepoDto, AnalysisRunDto } from "@sandbox-factory/shared";

const stamp = "2026-10-01T00:00:00.000Z";
const entry = (path: string) => ({
  path,
  type: "blob" as const,
  mode: "100644",
  sha: "c",
  size: 1,
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the picker pages a snapshot's files under a directory and collects entry points", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const page = url.includes("cursor=")
        ? { entries: [entry("src/z.ts")], nextCursor: null, truncated: false }
        : url.includes("prefix=lib")
          ? { entries: [entry("lib/a.ts")], nextCursor: null, truncated: false }
          : {
              entries: [
                entry("src/a.ts"),
                entry("src/b.ts"),
                { ...entry("sub"), type: "commit" },
              ],
              nextCursor: "src/b.ts",
              truncated: false,
            };
      return new Response(JSON.stringify(page));
    }),
  );
  const onChange = vi.fn();
  function Harness() {
    return (
      <SliceEntryPicker
        client={new GithubAnalysisClient({ baseUrl: "" })}
        organizationId="org_1"
        snapshotId="rsn_1"
        selected={["src/b.ts"]}
        onChange={onChange}
      />
    );
  }
  render(<Harness />);
  await screen.findByText("src/a.ts");
  expect(screen.queryByText("sub")).toBe(null);
  expect((screen.getByLabelText("src/b.ts") as HTMLInputElement).checked).toBe(
    true,
  );
  fireEvent.click(screen.getByLabelText("src/a.ts"));
  expect(onChange).toHaveBeenLastCalledWith(["src/a.ts", "src/b.ts"]);
  fireEvent.click(screen.getByRole("button", { name: "Remove src/b.ts" }));
  expect(onChange).toHaveBeenLastCalledWith([]);
  fireEvent.click(screen.getByRole("button", { name: "Load more files" }));
  await screen.findByText("src/z.ts");
  expect(calls.at(-1)).toMatch(/cursor=src%2Fb.ts/);
  fireEvent.change(screen.getByLabelText("Directory filter"), {
    target: { value: "lib" },
  });
  await screen.findByText("lib/a.ts");
  expect(calls.at(-1)).toMatch(/prefix=lib/);
  expect(screen.getByText(/1 of 50 entry points chosen/)).toBeTruthy();
});

test("a page that answers an older listing is dropped, and the filter keeps what is typed", async () => {
  const calls: string[] = [];
  let release: () => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("cursor=")) {
        // The second page of the old listing answers late.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return new Response(
          JSON.stringify({
            entries: [entry("src/late.ts")],
            nextCursor: "src/late.ts",
            truncated: false,
          }),
        );
      }
      const page = url.includes("prefix=lib")
        ? { entries: [entry("lib/a.ts")], nextCursor: null, truncated: false }
        : {
            entries: [entry("src/a.ts")],
            nextCursor: "src/a.ts",
            truncated: false,
          };
      return new Response(JSON.stringify(page));
    }),
  );
  render(
    <SliceEntryPicker
      client={new GithubAnalysisClient({ baseUrl: "" })}
      organizationId="org_1"
      snapshotId="rsn_1"
      selected={[]}
      onChange={() => {}}
    />,
  );
  await screen.findByText("src/a.ts");
  fireEvent.click(screen.getByRole("button", { name: "Load more files" }));
  const filter = screen.getByLabelText("Directory filter") as HTMLInputElement;
  fireEvent.change(filter, { target: { value: "lib " } });
  // Typed text stays as typed; the request uses it trimmed.
  expect(filter.value).toBe("lib ");
  await screen.findByText("lib/a.ts");
  expect(calls.at(-1)).toMatch(/prefix=lib&/);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText("src/late.ts")).toBe(null);
  expect(screen.getByText("lib/a.ts")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more files" })).toBe(null);
});

test("a failing file list is reported and can be reloaded", async () => {
  let failures = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      failures-- > 0
        ? new Response('{"error":"Tree is gone"}', { status: 502 })
        : new Response(
            JSON.stringify({ entries: [], nextCursor: null, truncated: false }),
          ),
    ),
  );
  render(
    <SliceEntryPicker
      client={new GithubAnalysisClient({ baseUrl: "" })}
      organizationId="org_1"
      snapshotId="rsn_1"
      selected={[]}
      onChange={() => {}}
    />,
  );
  await screen.findByText("Tree is gone");
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await screen.findByText("No files under this directory.");
});

const summary: SliceBoundarySummaryDto = {
  schemaVersion: 1,
  language: "typescript",
  stubCoverage: "partial",
  ready: false,
  counts: {
    includedFiles: 2,
    includedBytes: 10,
    outboundModules: 1,
    inboundModules: 1,
    stubs: 2,
    publicSymbols: 1,
    externals: 2,
    blockers: 1,
  },
  included: ["src/app.ts", "src/local.ts"],
  outbound: [
    {
      module: "lib/service.ts",
      symbols: ["Service", "createService"],
      importedBy: ["src/app.ts"],
      truncated: true,
    },
  ],
  inbound: [
    {
      module: "src/app.ts",
      symbols: [],
      importedBy: ["consumers/cli.ts"],
      truncated: false,
    },
  ],
  externals: {
    packages: [{ specifier: "pg", service: "postgres" }],
    environment: ["DATABASE_URL"],
  },
  blockers: [
    {
      code: "unresolved_import",
      file: "src/app.ts",
      location: "L4",
      detail: "x does not resolve.",
    },
  ],
  truncated: true,
};
const artifact = (
  path: string,
  kind: ArtifactDto["kind"],
  meta: ArtifactDto["meta"] = null,
): ArtifactDto => ({
  id: `art_${path}`,
  runId: "arn_slice",
  kind,
  path,
  contentType: "text/plain",
  sizeBytes: 1,
  sha256: "c".repeat(64),
  meta,
  createdAt: stamp,
});

test("the boundary view renders coverage, blockers, modules and externals from the summary", () => {
  const onOpen = vi.fn();
  render(
    <SliceBoundary
      summary={summary}
      artifacts={[
        artifact("boundary.md", "boundary_md"),
        artifact("abstract.md", "abstract_md"),
      ]}
      onOpen={onOpen}
    />,
  );
  expect(screen.getByText("Diagnostic only")).toBeTruthy();
  expect(screen.getByText("coverage: partial")).toBeTruthy();
  expect(screen.getByText(/summary truncated/)).toBeTruthy();
  expect(screen.getByText(/x does not resolve/)).toBeTruthy();
  expect(screen.getByText("Service, createService …")).toBeTruthy();
  expect(screen.getByText("Whole module")).toBeTruthy();
  expect(screen.getByText(/Imported by consumers\/cli.ts/)).toBeTruthy();
  expect(screen.getByText("DATABASE_URL")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open boundary.md" }));
  expect(onOpen).toHaveBeenCalledWith("art_boundary.md");
  expect(screen.queryByRole("button", { name: "Open public-surface.md" })).toBe(
    null,
  );
  render(
    <SliceBoundary
      summary={{
        ...summary,
        ready: true,
        blockers: [],
        outbound: [],
        inbound: [],
        externals: { packages: [], environment: [] },
        truncated: false,
      }}
      artifacts={[]}
      onOpen={onOpen}
    />,
  );
  expect(screen.getByText("Ready for the sandbox gates")).toBeTruthy();
  expect(
    screen.getByText("The slice imports nothing outside itself."),
  ).toBeTruthy();
  expect(
    screen.getByText("No service SDKs or environment reads were detected."),
  ).toBeTruthy();
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
const sliceRun: AnalysisRunDto = {
  ...graphRun,
  id: "arn_slice",
  tool: "slice",
  params: {
    deadlineMinutes: 30,
    graphRunId: graphRun.id,
    entryPoints: ["src/app.ts"],
    budget: { maxFiles: 5, maxDepth: 3 },
    includeInferred: false,
  },
};

test("owners pick entry points, start a slice and read its boundary beside the run", async () => {
  let runs: AnalysisRunDto[] = [graphRun];
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      let body: unknown;
      if (url.includes("/tree"))
        body = {
          entries: [entry("src/app.ts"), entry("src/b.ts")],
          nextCursor: null,
          truncated: false,
        };
      else if (url.endsWith("/snapshots")) body = { snapshots: [snapshot] };
      else if (url.endsWith("/slices")) {
        posts.push(JSON.parse(String(init?.body)));
        runs = [sliceRun, graphRun];
        body = { run: sliceRun, graphRun };
      } else if (url.endsWith("/repositories/ghr_1/runs")) body = { runs };
      else if (url.endsWith("/runs/arn_slice")) body = { run: sliceRun };
      else if (url.endsWith("/runs/arn_1")) body = { run: graphRun };
      else if (url.endsWith("/artifacts"))
        body = {
          artifacts: url.includes("arn_slice")
            ? [
                artifact(
                  "boundary-contract.json",
                  "boundary_contract",
                  summary as unknown as Record<string, unknown>,
                ),
                artifact("boundary.md", "boundary_md"),
              ]
            : [artifact("graph.html", "graph_html")],
        };
      else if (url.endsWith("/url"))
        body = { url: "https://objects.test/signed" };
      else return new Response('{"error":"Not found"}', { status: 404 });
      return new Response(JSON.stringify(body));
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
  expect(
    screen.getByRole("button", { name: "View existing analysis" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Choose entry points" }));
  await screen.findByText("src/app.ts");
  expect(
    (screen.getByRole("button", { name: "Slice now" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText("src/app.ts"));
  // Out-of-range budgets are held inside the API's bounds as typed.
  const maxFiles = screen.getByLabelText("Max files") as HTMLInputElement;
  const maxDepth = screen.getByLabelText("Max depth") as HTMLInputElement;
  fireEvent.change(maxFiles, { target: { value: "500" } });
  expect(maxFiles.value).toBe("200");
  fireEvent.change(maxDepth, { target: { value: "-3" } });
  expect(maxDepth.value).toBe("0");
  fireEvent.change(maxDepth, { target: { value: "3" } });
  fireEvent.change(maxFiles, {
    target: { value: "5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Slice now" }));
  await screen.findByText(/Slice \(1 entry point\)/);
  expect(posts).toEqual([
    {
      snapshotId: "rsn_1",
      entryPoints: ["src/app.ts"],
      budget: { maxFiles: 5, maxDepth: 3 },
      includeInferred: false,
    },
  ]);
  await screen.findByText("Diagnostic only");
  expect(screen.getByText(/x does not resolve/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open boundary.md" })).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "View existing analysis" }),
    ).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: "Slice now" })).toBe(null);
});

test("a slice whose graph run failed explains the error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/snapshots")
        ? { snapshots: [snapshot] }
        : url.endsWith("/repositories/ghr_1/runs")
          ? {
              runs: [
                {
                  ...sliceRun,
                  status: "failed",
                  errorCode: "graph_unavailable",
                },
              ],
            }
          : { artifacts: [] };
      return new Response(JSON.stringify(body));
    }),
  );
  render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable={false}
      onClose={() => {}}
    />,
  );
  await screen.findByText(
    /structure analysis this slice needs did not succeed/,
  );
  expect(screen.queryByRole("button", { name: "Choose entry points" })).toBe(
    null,
  );
});

test("switching snapshots clears entry points chosen from the old one", async () => {
  const older = { ...snapshot, id: "rsn_0", commitSha: "0".repeat(40) };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.includes("/tree")
        ? { entries: [entry("src/app.ts")], nextCursor: null, truncated: false }
        : url.endsWith("/snapshots")
          ? { snapshots: [snapshot, older] }
          : url.endsWith("/repositories/ghr_1/runs")
            ? { runs: [graphRun] }
            : { artifacts: [] };
      return new Response(JSON.stringify(body));
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
  fireEvent.click(screen.getByRole("button", { name: "Choose entry points" }));
  fireEvent.click(await screen.findByLabelText("src/app.ts"));
  const slice = () =>
    (screen.getByRole("button", { name: "Slice now" }) as HTMLButtonElement)
      .disabled;
  expect(slice()).toBe(false);
  fireEvent.change(screen.getByLabelText("Source snapshot"), {
    target: { value: "rsn_0" },
  });
  await waitFor(() => expect(slice()).toBe(true));
  expect(screen.queryByRole("button", { name: "Remove src/app.ts" })).toBe(
    null,
  );
});
