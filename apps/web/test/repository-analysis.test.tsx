import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RepositoryAnalysis } from "../src/RepositoryAnalysis";
import type { GithubRepoDto, AnalysisRunDto } from "@sandbox-factory/shared";
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
const run: AnalysisRunDto = {
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
function server(runs: AnalysisRunDto[] = []) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    let body: unknown;
    if (url.endsWith("/snapshots")) body = { snapshots: [snapshot] };
    else if (url.endsWith("/repositories/ghr_1/runs")) {
      if (init?.method === "POST")
        runs = [
          { ...run, status: "queued", startedAt: null, finishedAt: null },
        ];
      body = init?.method === "POST" ? { run: runs[0] } : { runs };
    } else if (url.endsWith("/runs/arn_1")) body = { run: runs[0] };
    else if (url.endsWith("/artifacts"))
      body = {
        artifacts:
          runs[0]?.status === "succeeded"
            ? [
                {
                  id: "art_1",
                  runId: run.id,
                  path: "graph.html",
                  kind: "graph_html",
                  contentType: "text/html",
                  sizeBytes: 2048,
                  sha256: "c".repeat(64),
                  meta: null,
                  createdAt: stamp,
                },
              ]
            : [],
      };
    else if (url.endsWith("/url"))
      body = { url: "https://objects.test/signed" };
    else return new Response('{"error":"Not found"}', { status: 404 });
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fetch);
  return { calls };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
test("owners enqueue the selected snapshot and the active run disables analysis", async () => {
  const f = server();
  render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable
      onClose={() => {}}
    />,
  );
  await screen.findByText(/10 files/);
  fireEvent.click(screen.getByRole("button", { name: "Analyse now" }));
  await screen.findByText("queued");
  expect(
    (
      screen.getByRole("button", {
        name: "Analysis in progress",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(f.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
});
test("members can open artifacts through a signed URL but cannot start runs or read logs", async () => {
  const f = server([run]);
  const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable={false}
      onClose={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "graph.html" }));
  await waitFor(() =>
    expect(tab.location.href).toBe("https://objects.test/signed"),
  );
  expect(tab.opener).toBe(null);
  expect(f.calls.some((c) => c.endsWith("/artifacts/art_1/url"))).toBe(true);
  expect(screen.queryByRole("button", { name: "Analyse now" })).toBe(null);
  expect(screen.queryByRole("button", { name: "Open run log" })).toBe(null);
  expect(screen.getByText(/SHA-256/)).toBeTruthy();
});
test("failed runs show the error and retry cap; admins can open logs", async () => {
  server([{ ...run, status: "failed", attempt: 2, errorCode: "too_large" }]);
  const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable
      onClose={() => {}}
    />,
  );
  await screen.findByText(/source size limit/);
  expect(
    (
      screen.getByRole("button", {
        name: "Retry limit reached",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open run log" }));
  await waitFor(() =>
    expect(tab.location.href).toBe("https://objects.test/signed"),
  );
});
test("loading failures are visible and never rendered as empty history", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response('{"error":"Analysis unavailable"}', { status: 503 }),
    ),
  );
  render(
    <RepositoryAnalysis
      organizationId="org_1"
      repo={repo}
      manageable
      onClose={() => {}}
    />,
  );
  await screen.findByText("Analysis unavailable");
  expect(screen.queryByText("No analysis runs yet.")).toBe(null);
});

test("a cached run outside the history page opens its artifacts", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = url.endsWith("/snapshots")
        ? { snapshots: [snapshot] }
        : url.endsWith("/repositories/ghr_1/runs")
          ? init?.method === "POST"
            ? { run }
            : { runs: [] }
          : url.endsWith("/runs/arn_1")
            ? { run }
            : {
                artifacts: [
                  {
                    id: "art_1",
                    runId: run.id,
                    path: "graph.html",
                    kind: "graph_html",
                    contentType: "text/html",
                    sizeBytes: 2,
                    sha256: "c".repeat(64),
                    meta: null,
                    createdAt: stamp,
                  },
                ],
              };
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
  fireEvent.click(await screen.findByRole("button", { name: "Analyse now" }));
  await screen.findByRole("button", { name: "graph.html" });
  expect(screen.getByText("succeeded")).toBeTruthy();
});
