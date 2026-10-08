/**
 * A repository's own page: the context builders and what they built.
 *
 * What it must get right: an owner starts every builder on the chosen
 * snapshot at once and sees each card follow its run; a member can read and open
 * artifacts but start nothing; each builder's result is drawn from the
 * summary its artifacts carry; the runs a bounty made are still readable
 * here, with nothing left that would make one; and a failed read is said
 * rather than shown as an empty history.
 *
 * The server is faked at `fetch`, routed by method and path suffix.
 */

import { CONTEXT_BUILDERS, toolVersionOf } from "sandbox-factory";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AnalysisRunDto,
  ArtifactDto,
  DependencyCruiserSummaryDto,
  GithubRepoDto,
} from "@sandbox-factory/shared";

import { RepositoryPage } from "../src/Repository";
import { chooseOption } from "./combobox";
import { cleanup, fireEvent, render, screen, waitFor, within } from "./render";

/*
  Mermaid measures text and Graphviz is WebAssembly in a worker; neither
  runs in jsdom. A diagram is drawn as a picture naming its kind, and one
  whose text says `broken` fails as a parse error does. What the page does
  with the drawing, making it safe and showing it, is the real code.
*/
vi.mock("../src/features/sandbox/diagrams", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/features/sandbox/diagrams")>();
  return {
    ...actual,
    renderDiagram: async (kind: string, source: string) => {
      if (source.includes("broken"))
        throw new Error("Parse error on line 1:\nbroken\n^");
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text>${kind} drawn</text><script>steal()</script></svg>`;
    },
  };
});

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
  toolVersion: toolVersionOf("graphify"),
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
    toolVersion: toolVersionOf(tool),
    status: "queued" as const,
    startedAt: null,
    finishedAt: null,
  };
  switch (tool) {
    case "dependency_cruiser":
      return { ...base, tool, params: { deadlineMinutes: 30, builder: tool } };
    case "deepwiki":
      return { ...base, tool, params: { deadlineMinutes: 30, builder: tool } };
    case "abstractions":
    case "data_model":
      return {
        ...base,
        tool,
        params: { deadlineMinutes: 30, builder: tool, graphRunId: graphRun.id },
      } as AnalysisRunDto;
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
  /** Artifact text by id; one not named here is too large to show. */
  contents?: Record<string, string>;
  /** Run logs by run id; a run not named here kept none. */
  logs?: Record<string, string>;
  repositories?: GithubRepoDto[];
  /** The repository's branches; main at the head alone when unsaid. */
  branches?: { name: string; headSha: string; isDefault: boolean }[];
  /**
   * How a pull of a branch is answered: the snapshot already taken, or one
   * that lands on the next read of the list.
   */
  pulls?: Record<
    string,
    { taken: typeof snapshot } | { lands: typeof snapshot }
  >;
}

/** A fake API, routed by method and the end of the path. */
function server(options: Server) {
  const calls: string[] = [];
  const posts: unknown[] = [];
  let runs = options.runs;
  let snapshots = [snapshot];
  const repositories = options.repositories ?? [repo];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    let body: unknown;
    if (method === "DELETE" && url.endsWith("/github/repositories/ghr_1")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/github/repositories")) body = { repositories };
    else if (url.endsWith("/snapshots") && method === "POST") {
      const { branch } = JSON.parse(String(init?.body)) as { branch: string };
      posts.push({ branch });
      const pull = options.pulls?.[branch];
      if (pull === undefined)
        return new Response('{"error":"Not found"}', { status: 404 });
      if ("taken" in pull)
        body = { commitSha: pull.taken.commitSha, snapshot: pull.taken };
      else {
        snapshots = [pull.lands, ...snapshots];
        return new Response(
          JSON.stringify({ commitSha: pull.lands.commitSha, snapshot: null }),
          { status: 202 },
        );
      }
    } else if (url.endsWith("/snapshots")) body = { snapshots };
    else if (url.endsWith("/branches"))
      body = {
        branches: options.branches ?? [
          { name: "main", headSha: "a".repeat(40), isDefault: true },
        ],
        truncated: false,
      };
    else if (url.endsWith("/repositories/ghr_1/builds") && method === "POST") {
      posts.push(JSON.parse(String(init?.body)));
      // As the API does: a builder already built at its version, or queued,
      // is answered as is; the rest are queued.
      const queued = CONTEXT_BUILDERS.filter(
        (tool) =>
          !runs.some(
            (run) =>
              run.tool === tool &&
              run.status !== "failed" &&
              run.toolVersion === toolVersionOf(tool),
          ),
      ).map(queuedRun);
      runs = [...queued, ...runs];
      return new Response(JSON.stringify({ runs: queued }), { status: 202 });
    } else if (/\/repositories\/ghr_1\/runs(\?|$)/.test(url)) {
      // As the API does: one snapshot's runs when the query names it.
      const onSnapshot = new URL(url, "http://localhost").searchParams.get(
        "snapshotId",
      );
      if (method === "POST") {
        const input = JSON.parse(String(init?.body)) as {
          tool: AnalysisRunDto["tool"];
        };
        posts.push(input);
        const run = queuedRun(input.tool);
        runs = [run, ...runs];
        body = { run };
      } else
        body = {
          // The repository's newest page, capped as the API caps it.
          runs:
            onSnapshot === null
              ? runs.slice(0, 25)
              : runs.filter((run) => run.snapshotId === onSnapshot),
        };
    } else if (url.endsWith("/artifacts")) {
      const id = url.split("/runs/")[1]?.split("/")[0] ?? "";
      body = { artifacts: options.artifacts?.[id] ?? [] };
    } else if (url.endsWith("/log/content")) {
      const id = url.split("/runs/")[1]?.split("/")[0] ?? "";
      const text = options.logs?.[id];
      if (text === undefined)
        return new Response('{"error":"No log is available."}', {
          status: 404,
        });
      body = { sizeBytes: text.length, text, omitted: null };
    } else if (url.endsWith("/content")) {
      const id = url.split("/artifacts/")[1]?.split("/")[0] ?? "";
      const text = options.contents?.[id];
      body = {
        path: id,
        sizeBytes: 2048,
        text: text ?? null,
        omitted: text === undefined ? "too_large" : null,
      };
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

/** The run history, the builders' footer: its count, and the way to the logs. */
async function history(count: RegExp) {
  const footer = await screen.findByRole("region", { name: "Run history" });
  await within(footer).findByText(count);
  // It lists nothing: the runs are listed in the logs dialog.
  expect(within(footer).queryByRole("list")).toBe(null);
  return footer;
}

function viewFiles() {
  return screen.getByRole("button", {
    name: "View files",
  }) as HTMLButtonElement;
}

function buildAll() {
  return screen.getByRole("button", { name: "Build all" }) as HTMLButtonElement;
}

function builderCard(name: string) {
  return screen.getByRole("region", { name: `${name} builder` });
}

/** The frame a web page runs in, once there is one. */
function frameIn(dialog: HTMLElement) {
  return waitFor(() => {
    const frame = dialog.querySelector("iframe");
    expect(frame).not.toBeNull();
    return frame as HTMLIFrameElement;
  });
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
      .getByRole("link", { name: "github.com/acme/widgets" })
      .getAttribute("href"),
  ).toBe("https://github.com/acme/widgets");
  const names = [
    "Graphify",
    "Dependency Cruiser",
    "DeepWiki Open",
    "Abstractions",
    "Data model",
  ];
  const cards = screen.getAllByRole("region", { name: / builder$/ });
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(
    names.map((name) => `${name} builder`),
  );
  for (const name of names) {
    expect(within(builderCard(name)).getByText("Not built")).toBeTruthy();
    // Builders are started together, from the block, not one by one.
    expect(within(builderCard(name)).queryByRole("button")).toBe(null);
  }
  expect(buildAll().disabled).toBe(false);
  // One action at a time: there is nothing built yet to view.
  expect(screen.queryByRole("button", { name: "View files" })).toBe(null);
  expect(
    within(screen.getByRole("region", { name: "Run history" })).getByText(
      /No runs yet/,
    ),
  ).toBeTruthy();
});

test("Build all posts the snapshot once, and every card follows its run", async () => {
  const f = server({ runs: [] });
  renderPage();
  await screen.findByText(/10 files/);
  fireEvent.click(buildAll());
  for (const name of [
    "Graphify",
    "Dependency Cruiser",
    "DeepWiki Open",
    "Abstractions",
    "Data model",
  ])
    await within(builderCard(name)).findByText("Queued");
  expect(f.posts).toEqual([{ snapshotId: "rsn_1" }]);
  expect(f.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  // Nothing is left to start while they are queued.
  // Nothing is left to start while they are queued: the block offers
  // their files instead, held until one is built.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Build all" })).toBe(null),
  );
  expect(viewFiles().disabled).toBe(true);
});

test("View files takes Build all's place once every builder has built", async () => {
  server({
    runs: CONTEXT_BUILDERS.map(
      (tool) => ({ ...queuedRun(tool), status: "succeeded" }) as AnalysisRunDto,
    ),
  });
  renderPage();
  await within(
    await screen.findByRole("region", { name: "Data model builder" }),
  ).findByText("Built");
  await waitFor(() => expect(viewFiles().disabled).toBe(false));
  expect(screen.queryByRole("button", { name: "Build all" })).toBe(null);
});

test("a member opens a build's files but cannot build or read logs", async () => {
  const f = server({
    runs: [graphRun],
    artifacts: { arn_1: [artifact("arn_1", "graph.html", "graph_html")] },
  });
  const tab = spyOnOpen();
  renderPage("member");
  await screen.findByText(/10 files/);
  expect(
    await within(builderCard("Graphify")).findByText("Built"),
  ).toBeTruthy();
  // The one "View" is the block's, not the row's.
  expect(
    within(builderCard("Graphify")).queryByRole("button", {
      name: "View files",
    }),
  ).toBe(null);
  // Enabled once the snapshot's own runs have been read.
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "View files" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "View files" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "graph.html" }),
  );
  // It runs in the viewer; the bar opens it in a tab of its own.
  fireEvent.click(
    await within(dialog).findByRole("button", {
      name: "Open graph.html in a new tab",
    }),
  );
  await waitFor(() =>
    expect(tab.location.href).toBe("https://objects.test/signed"),
  );
  expect(tab.opener).toBe(null);
  expect(f.calls.some((c) => c.endsWith("/artifacts/art_graph_html/url"))).toBe(
    true,
  );
  expect(screen.queryByRole("button", { name: "Build all" })).toBe(null);
  expect(screen.queryByRole("button", { name: "View logs" })).toBe(null);
  expect(screen.queryByRole("button", { name: /Remove/ })).toBe(null);
});

test("View is disabled until a builder has built on the snapshot", async () => {
  server({ runs: [] });
  // A member: an owner is offered Build all instead.
  renderPage("member");
  await screen.findByText(/10 files/);
  expect(
    (screen.getByRole("button", { name: "View files" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("a build older than the repository's newest page of runs is still shown built", async () => {
  // Thirty runs on another snapshot since: the build on this one fell off
  // the repository's page of runs and read as never built.
  const newer = Array.from({ length: 30 }, (_, index) => ({
    ...graphRun,
    id: `arn_other_${index}`,
    snapshotId: "rsn_other",
  }));
  server({ runs: [...newer, graphRun] });
  // A member: an owner with builders left to start is offered Build all.
  renderPage("member");
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "View files" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

test("View opens every build in one explorer, a folder per builder, and reads a file", async () => {
  const wiki: AnalysisRunDto = {
    ...queuedRun("deepwiki"),
    status: "succeeded",
    startedAt: stamp,
    finishedAt: stamp,
  };
  const f = server({
    runs: [wiki, graphRun],
    artifacts: {
      arn_1: [
        artifact("arn_1", "graph.json", "graph_json"),
        artifact("arn_1", "graph.html", "graph_html"),
      ],
      [wiki.id]: [
        artifact(wiki.id, "pages/intro.md", "manifest"),
        artifact(wiki.id, "pages/export.csv", "other"),
      ],
    },
    contents: {
      art_pages_intro_md: "# Intro\n\nSee [the map](../graph.json).",
      art_graph_json: '{"nodes":1}',
    },
  });
  const tab = spyOnOpen();
  // A member: an owner with builders left to start is offered Build all.
  renderPage("member");
  await screen.findByText(/10 files/);
  // Enabled once the snapshot's own runs have been read.
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "View files" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "View files" }));
  const dialog = await screen.findByRole("dialog");
  const files = within(dialog).getByRole("navigation", { name: "Files" });
  // A folder per build, in the builders' order, open from the start.
  const folders = within(files)
    .getAllByRole("button", { expanded: true })
    .map((folder) => folder.textContent);
  expect(folders).toEqual(["Graphify", "DeepWiki Open", "pages"]);
  // The first document opens rendered.
  expect(
    await within(dialog).findByRole("heading", { name: "Intro" }),
  ).toBeTruthy();
  expect(
    within(files)
      .getByRole("button", { name: "intro.md" })
      .getAttribute("aria-current"),
  ).toBe("true");
  // Another file is read through the API, not its signed link.
  fireEvent.click(within(files).getByRole("button", { name: "graph.json" }));
  await within(dialog).findByText(/"nodes"/);
  expect(
    f.calls.some((c) => c.endsWith("/artifacts/art_graph_json/content")),
  ).toBe(true);
  // A web page too large to read as text runs from its signed link, in a
  // frame that may run scripts and nothing more.
  fireEvent.click(within(files).getByRole("button", { name: "graph.html" }));
  const frame = await frameIn(dialog);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  await waitFor(() =>
    expect(frame.getAttribute("src")).toBe("https://objects.test/signed"),
  );
  // Covered until the page's own scripts have run and it has loaded.
  expect(within(dialog).getByText("Drawing graph.html…")).toBeTruthy();
  fireEvent.load(frame);
  expect(within(dialog).queryByText("Drawing graph.html…")).toBeNull();
  expect(within(dialog).queryByText(/too large to show here/)).toBeNull();
  // Any other file too large to show opens in a new tab instead.
  fireEvent.click(within(files).getByRole("button", { name: "export.csv" }));
  await within(dialog).findByText(/too large to show here/);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Open in a new tab" }),
  );
  await waitFor(() =>
    expect(tab.location.href).toBe("https://objects.test/signed"),
  );
  expect(
    f.calls.some((c) => c.endsWith("/artifacts/art_pages_export_csv/url")),
  ).toBe(true);
});

test("what can be seen is shown: diagrams drawn, pages run, wiki links followed", async () => {
  const model: AnalysisRunDto = {
    ...queuedRun("data_model"),
    status: "succeeded",
    startedAt: stamp,
    finishedAt: stamp,
  };
  server({
    runs: [model, graphRun],
    artifacts: {
      arn_1: [
        artifact("arn_1", "GRAPH_REPORT.md", "report_md"),
        artifact("arn_1", "wiki/Community_0.md", "wiki_page"),
        artifact("arn_1", "page.html", "graph_html"),
      ],
      [model.id]: [
        artifact(model.id, "erd.mmd", "erd_mermaid"),
        artifact(model.id, "deps.dot", "other"),
      ],
    },
    contents: {
      art_GRAPH_REPORT_md: [
        "# Report",
        "",
        "- [[_COMMUNITY_Community 0|Community 0]]",
        "",
        "```mermaid",
        "graph LR; a --> b",
        "```",
        "",
        "```mermaid",
        "broken",
        "```",
      ].join("\n"),
      art_wiki_Community_0_md: "# Community 0\n\nBack to [[index]].",
      art_page_html: "<!doctype html><title>Graph</title><p>graph</p>",
      art_erd_mmd: "erDiagram\n  user ||--o{ session : has",
      art_deps_dot: 'digraph { "a" -> "b" }',
    },
  });
  // A member: an owner with builders left to start is offered Build all.
  renderPage("member");
  await screen.findByText(/10 files/);
  // Enabled once the snapshot's own runs have been read.
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "View files" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "View files" }));
  const dialog = await screen.findByRole("dialog");
  const files = within(dialog).getByRole("navigation", { name: "Files" });

  // A Mermaid fence is drawn where it stands, with nothing in it that runs.
  await within(dialog).findByRole("heading", { name: "Report" });
  const figure = await within(dialog).findByRole("figure", {
    name: "Mermaid diagram",
  });
  await within(figure).findByText("mermaid drawn");
  expect(figure.querySelector("script")).toBeNull();
  // Read as written, and back.
  fireEvent.click(within(figure).getByRole("button", { name: "Source" }));
  expect(within(figure).getByText(/a --> b/)).toBeTruthy();
  fireEvent.click(within(figure).getByRole("button", { name: "Diagram" }));
  await within(figure).findByText("mermaid drawn");
  // One that cannot be drawn reads as written, with why.
  await within(dialog).findByText("Not drawn: Parse error on line 1:");
  expect(within(dialog).getByText("broken")).toBeTruthy();

  // A wiki link opens the note it names.
  fireEvent.click(within(dialog).getByRole("link", { name: "Community 0" }));
  await within(dialog).findByRole("heading", { name: "Community 0" });
  // One that names nothing reads as its label.
  expect(within(dialog).getByText(/Back to index\./)).toBeTruthy();

  // A Mermaid file opens drawn on a canvas, with its text a toggle away.
  fireEvent.click(within(files).getByRole("button", { name: "erd.mmd" }));
  const canvas = await within(dialog).findByRole("group", { name: "erd.mmd" });
  await within(canvas).findByText("mermaid drawn");
  // Scrolling zooms rather than scrolls: a wheel's notch toward the
  // reader zooms in, away zooms back out.
  const zoom = within(dialog).getByRole("toolbar", { name: "Zoom" });
  expect(within(zoom).getByText("100%")).toBeTruthy();
  fireEvent.wheel(canvas, { deltaY: -100 });
  expect(within(zoom).getByText("122%")).toBeTruthy();
  fireEvent.wheel(canvas, { deltaY: 100 });
  expect(within(zoom).getByText("100%")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  expect(within(dialog).getByTestId("file-source").textContent).toContain(
    "erDiagram",
  );

  // A Graphviz file the same.
  fireEvent.click(within(files).getByRole("button", { name: "deps.dot" }));
  await within(
    await within(dialog).findByRole("group", { name: "deps.dot" }),
  ).findByText("dot drawn");

  // A small web page runs from its text, sandboxed.
  fireEvent.click(within(files).getByRole("button", { name: "page.html" }));
  const frame = await frameIn(dialog);
  expect(frame.getAttribute("title")).toBe("page.html");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("srcdoc")).toContain("<title>Graph</title>");
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  expect(within(dialog).getByTestId("file-source").textContent).toContain(
    "<title>Graph</title>",
  );
});

test("a run an older builder made stays on view, says so, and Build all builds it again", async () => {
  const f = server({
    runs: CONTEXT_BUILDERS.map(
      (tool) =>
        ({
          ...queuedRun(tool),
          status: "succeeded",
          toolVersion:
            tool === "graphify" ? "graphifyy@0.1" : toolVersionOf(tool),
        }) as AnalysisRunDto,
    ),
  });
  renderPage();
  const card = await screen.findByRole("region", { name: "Graphify builder" });
  const outdated = await within(card).findByText("Outdated");
  expect(outdated.getAttribute("title")).toMatch(/^Built by graphifyy@0\.1;/);
  expect(within(card).getByText("Built")).toBeTruthy();
  await waitFor(() => expect(buildAll().disabled).toBe(false));
  fireEvent.click(buildAll());
  await waitFor(() =>
    expect(
      f.calls.some((c) => c.startsWith("POST ") && c.endsWith("/builds")),
    ).toBe(true),
  );
});

test("a failed run shows its error and the retry cap; admins open the log", async () => {
  const f = server({
    runs: [
      { ...graphRun, status: "failed", attempt: 2, errorCode: "too_large" },
    ],
    logs: { arn_1: "Cloning…\nSource exceeds the size limit." },
  });
  const tab = spyOnOpen();
  renderPage();
  const card = await screen.findByRole("region", { name: "Graphify builder" });
  await within(card).findByText(/source size limit/);
  expect(within(card).getByText("Failed")).toBeTruthy();
  expect(within(card).getByText(/Retry limit reached/)).toBeTruthy();
  expect(within(card).queryByRole("button", { name: /Build/ })).toBe(null);
  // The footer opens its log, read through the API, printed as a terminal
  // does and ending in how it exited. Failures are not counted there.
  const footer = await history(/1 run$/);
  fireEvent.click(within(footer).getByRole("button", { name: "View logs" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Source exceeds the size limit.");
  expect(
    within(dialog).getByText(/✗ Failed: .*source size limit/),
  ).toBeTruthy();
  expect(f.calls.some((c) => c.endsWith("/runs/arn_1/log/content"))).toBe(true);
  // And still opens raw, in a new tab, from there.
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Open the log in a new tab" }),
  );
  await waitFor(() =>
    expect(tab.location.href).toBe("https://objects.test/signed"),
  );
});

test("Logs lists every run down the side; each opens its own log", async () => {
  const queued = {
    ...queuedRun("deepwiki"),
    createdAt: "2026-10-02T00:00:00.000Z",
  };
  const older: AnalysisRunDto = {
    ...graphRun,
    id: "arn_old",
    createdAt: "2026-09-30T00:00:00.000Z",
  };
  server({
    runs: [queued, graphRun, older],
    logs: { arn_1: "Graph built." },
  });
  renderPage();
  const footer = await history(/3 runs/);
  fireEvent.click(within(footer).getByRole("button", { name: "View logs" }));
  const dialog = await screen.findByRole("dialog");
  const list = within(dialog).getByRole("navigation", { name: "Runs" });
  expect(within(list).getAllByRole("button")).toHaveLength(3);
  // It opens on the newest run, which is queued: no log yet.
  await within(dialog).findByText(/its log is written when it finishes/);
  const [, graph, old] = within(list).getAllByRole("button");
  fireEvent.click(graph as HTMLElement);
  await within(dialog).findByText("Graph built.");
  expect(graph?.getAttribute("aria-current")).toBe("true");
  fireEvent.click(old as HTMLElement);
  await within(dialog).findByText("No log was kept for this run.");
});

test("a member has no logs to open", async () => {
  server({ runs: [graphRun] });
  renderPage("member");
  const footer = await history(/1 run$/);
  expect(within(footer).queryByRole("button")).toBe(null);
});

test("a failed run with retries left is built again by Build all, and says why it failed", async () => {
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
  expect(buildAll().disabled).toBe(false);
});

test("a graph out of retries leaves nothing for its readers to build", async () => {
  server({
    runs: [
      { ...graphRun, status: "failed", attempt: 2, errorCode: "too_large" },
      ...(["dependency_cruiser", "deepwiki"] as const).map(
        (tool) =>
          ({ ...queuedRun(tool), status: "succeeded" }) as AnalysisRunDto,
      ),
    ],
  });
  renderPage();
  const card = await screen.findByRole("region", {
    name: "DeepWiki Open builder",
  });
  await within(card).findByText("Built");
  await waitFor(() => expect(viewFiles().disabled).toBe(false));
  expect(screen.queryByRole("button", { name: "Build all" })).toBe(null);
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
  fireEvent.click(buildAll());
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

test("each built row carries the headline figures of its own build", async () => {
  const run: AnalysisRunDto = {
    ...queuedRun("dependency_cruiser"),
    status: "succeeded",
    startedAt: stamp,
    finishedAt: stamp,
  };
  server({
    runs: [run, graphRun],
    artifacts: {
      [run.id]: [
        artifact(
          run.id,
          "manifest.json",
          "manifest",
          cruise as unknown as Record<string, unknown>,
        ),
      ],
      arn_1: [
        artifact("arn_1", "graph.json", "graph_json", {
          nodes: 40,
          edges: 55,
          unresolved: 2,
          visualizationNodes: 40,
        }),
      ],
    },
  });
  renderPage();
  await screen.findByText(/10 files/);
  const figure = (name: string, label: string) =>
    within(builderCard(name)).getByText(label).previousElementSibling
      ?.textContent;
  await within(builderCard("Dependency Cruiser")).findByText("modules");
  expect(figure("Dependency Cruiser", "modules")).toBe("12");
  expect(figure("Dependency Cruiser", "cycles")).toBe("1");
  await within(builderCard("Graphify")).findByText("nodes");
  expect(figure("Graphify", "edges")).toBe("55");
  // A builder not built has none.
  expect(within(builderCard("Abstractions")).queryByText("modules")).toBe(null);
});

test("runs a bounty made are listed with the rest in the logs, with nothing here that would make one", async () => {
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
  server({ runs: [sliceRun, scopeRun, fixturesRun, graphRun] });
  renderPage();
  const footer = await history(/4 runs/);
  fireEvent.click(within(footer).getByRole("button", { name: "View logs" }));
  const runs = within(await screen.findByRole("dialog")).getByRole(
    "navigation",
    { name: "Runs" },
  );
  expect(within(runs).getByText("Slice (1 entry point)")).toBeTruthy();
  expect(within(runs).getByText("Scope suggestion")).toBeTruthy();
  const fixtures = within(runs).getByText("Fake data").closest("button");
  expect(within(fixtures as HTMLElement).getByLabelText("Failed")).toBeTruthy();
  expect(screen.queryByText("Use this scope")).toBe(null);
  expect(screen.queryByText("Choose entry points")).toBe(null);
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
  const history = screen.getByRole("region", { name: "Run history" });
  expect(history.textContent).toMatch(/Unavailable/);
  expect(history.textContent).not.toMatch(/No runs yet/);
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

test("choosing a branch shows its snapshots, and pulling it takes its head", async () => {
  const feature = {
    ...snapshot,
    id: "rsn_2",
    commitSha: "d".repeat(40),
    ref: "refs/heads/feature/x",
    fileCount: 12,
  };
  const f = server({
    runs: [],
    branches: [
      { name: "main", headSha: "a".repeat(40), isDefault: true },
      { name: "feature/x", headSha: feature.commitSha, isDefault: false },
    ],
    pulls: { "feature/x": { lands: feature } },
  });
  renderPage();
  await screen.findByText(/10 files/);
  expect(
    screen.getByRole("combobox", { name: "Source snapshot" }).textContent,
  ).toContain("Latest");

  await chooseOption(
    screen.getByRole("combobox", { name: "Branch" }),
    /feature\/x/,
  );
  // Main's snapshot is not this branch's: there is nothing to build on.
  await screen.findByText("No snapshot of feature/x yet. Pull it to take one.");
  expect(screen.queryByRole("combobox", { name: "Source snapshot" })).toBe(
    null,
  );
  expect(buildAll().hasAttribute("disabled")).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Pull latest" }));
  await screen.findByText(/Taking a snapshot of/);
  expect(f.posts).toContainEqual({ branch: "feature/x" });
  // The list is read again until the snapshot lands, and it is chosen.
  await screen.findByText(/12 files/, {}, { timeout: 5000 });
  // The description names the branch and the commit it is of.
  expect(screen.getByText(/12 files/).textContent).toMatch(
    /^feature\/x@ddddddd · /,
  );
  const trigger = screen.getByRole("combobox", { name: "Source snapshot" });
  expect(trigger.textContent).toContain("ddddddd");
  expect(trigger.textContent).toContain("Latest");
  expect(screen.getByRole("button", { name: "Pull latest" })).toBeTruthy();
});

test("pulling a branch with nothing new says it is up to date", async () => {
  server({ runs: [], pulls: { main: { taken: snapshot } } });
  renderPage();
  await screen.findByText(/10 files/);

  fireEvent.click(screen.getByRole("button", { name: "Pull latest" }));

  await screen.findByRole("button", { name: "Up to date" });
  expect(
    screen.getByRole("combobox", { name: "Source snapshot" }).textContent,
  ).toContain("aaaaaaa");
});

test("a member chooses a branch but cannot pull one", async () => {
  server({ runs: [] });
  renderPage("member");
  await screen.findByText(/10 files/);
  expect(screen.getByRole("combobox", { name: "Branch" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Pull latest" })).toBe(null);
});
