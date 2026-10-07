import { cleanup, render, screen, waitFor, within } from "./render";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  fileTree,
  firstFile,
  foldersOf,
  linkedFile,
  sizeLabel,
} from "../src/features/sandbox/file-tree";
import {
  fileIconName,
  folderIconName,
  languageOf,
} from "../src/features/sandbox/file-types";
import { parseFeature, scenarioCount } from "../src/features/sandbox/gherkin";
import { formatJson } from "../src/features/sandbox/json-format";
import {
  isTestFile,
  searchLines,
  testCases,
} from "../src/features/sandbox/outline";
import { SandboxFilesPage } from "../src/features/sandbox/SandboxFiles";
import { sandboxFilesForPath, sandboxFilesPath } from "../src/routes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const stamp = "2026-10-03T00:00:00.000Z";
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
const version = {
  id: "sbv_1",
  sandboxId: "sbx_1",
  version: 2,
  title: "Invitations are not sent",
  specSummary: "Sends one email.",
  complexity: "M",
  tags: [],
  testSummary: [],
  publicBaseCommitSha: null,
  readme: null,
  languages: null,
  frozenAt: null,
  createdAt: stamp,
};
const FEATURE = [
  "@email",
  "Feature: Invitations are sent",
  "  An owner invites a teammate, once.",
  "",
  "  Background:",
  '    Given a workspace "Acme"',
  "",
  "  @smoke",
  "  Scenario: The invitee gets one email",
  '    When the owner invites "ada@example.com"',
  "    Then exactly 1 email is sent",
  "",
  "  Scenario Outline: Bad addresses are refused",
  '    When the owner invites "<address>"',
  "    Then the form refuses it",
  "",
  "    Examples:",
  "      | address |",
  "      | ada@    |",
  "",
  "  Scenario: The body",
  "    Then the body reads:",
  '      """',
  "      You were invited.",
  '      """',
].join("\n");
const fileOf = (path: string, sizeBytes = 10) => ({
  path,
  sizeBytes,
  sha256: "f".repeat(64),
});
const built = {
  run: { id: "arn_build", status: "succeeded" },
  files: [
    fileOf("build-manifest.json"),
    fileOf("project/README.md"),
    fileOf("project/src/invite.ts"),
    fileOf("project/logo.png"),
    fileOf("private/hidden.test.ts"),
    fileOf("project/tests/invite.feature"),
  ],
};
const contents: Record<string, unknown> = {
  "build-manifest.json": {
    text: '{"run":"arn_build","tests":[1.0,{"a b":"x\\"}"}],"none":{}}\n',
    omitted: null,
  },
  "project/README.md": {
    text: "# Invitations\n\nStart at `src/invite.ts`; see [the hidden tests](../private).\n",
    omitted: null,
  },
  "project/src/invite.ts": {
    text: "export function invite() {\n  return 1;\n}\n",
    omitted: null,
  },
  "project/logo.png": { text: null, omitted: "binary" },
  "private/hidden.test.ts": {
    text: "describe('invites', () => {\n  test('sends');\n  it(\"retries\");\n});\n",
    omitted: null,
  },
  "project/tests/invite.feature": { text: FEATURE, omitted: null },
};

const draft = {
  feature: "Invitations are sent",
  background: ["a workspace with one owner"],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "The invitee gets one email",
      steps: [
        { keyword: "When", text: "the owner invites a teammate" },
        { keyword: "Then", text: "exactly 1 email is sent" },
      ],
      origin: "draft",
      weight: "light",
      weightReason: "one more assertion",
    },
    {
      id: "s2",
      kind: "unhappy",
      title: "A bad address is refused",
      steps: [{ keyword: "Then", text: "the form refuses it" }],
      origin: "reviewer",
      weight: "moderate",
    },
  ],
  openQuestions: ["Is a second invite allowed?"],
  assumptions: ["Email is the only channel."],
};
/** What owners and admins read of a version: its frozen task, with `spec`. */
const sourceWith = (
  spec: typeof draft | null,
  aliasRules: readonly object[] = [],
) => ({
  sandboxVersionId: "sbv_1",
  origin: aliasRules.length === 0 ? "starter" : "slice",
  sourceSnapshotId: null,
  sourceCommitSha: null,
  sliceRunId: null,
  manifestSha256: null,
  contractSha256: null,
  starterRunId: "arn_starter",
  starterSha256: null,
  transformConfigSha256: "t".repeat(64),
  approvedTaskSha256: "a".repeat(64),
  proposalVersion: 1,
  aliasRules,
  dependencyChoices: {},
  acceptanceTests: [],
  fixtures: null,
  approvedTask: {
    schemaVersion: 3,
    title: "Invitations are not sent",
    summary: "Sends one email.",
    spec:
      spec === null
        ? null
        : {
            proposalId: "prp_1",
            specRevision: 1,
            specHash: "h".repeat(64),
            draft: spec,
          },
    pricing: null,
    selectedBy: "user_1",
    selectedAt: stamp,
    bountyId: "bty_7",
  },
  scope: {
    editablePaths: [],
    generatedPaths: [],
    permittedOperations: ["edit"],
    dependencies: [],
    blockers: [],
  },
  harnessSha256: null,
  toolchainDigest: null,
  buildRunId: "arn_build",
  roundTripRunId: null,
  disclosureRunId: null,
  approvedBy: null,
  approvedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
});

function server(
  input: {
    role?: string;
    files?: () => unknown;
    versionStatus?: number;
    /** The version's frozen spec; left out, the version carries no source. */
    spec?: typeof draft | null;
    /** The version's name table, with a source. */
    aliasRules?: readonly object[];
  } = {},
) {
  const calls: string[] = [];
  const fetchMock = vi.fn((url: string) => {
    calls.push(url);
    if (url.endsWith("/api/v1/me/orgs"))
      return json({
        organizations: [
          {
            id: "org_1",
            name: "Acme",
            slug: "acme",
            kind: "team",
            role: input.role ?? "owner",
          },
        ],
      });
    if (url.includes("/files/content?")) {
      const path = new URL(url, "http://x").searchParams.get("path") ?? "";
      return json({ path, sizeBytes: 10, ...(contents[path] as object) });
    }
    if (url.endsWith("/sandboxes/versions/sbv_1/files"))
      return json(input.files?.() ?? built);
    if (url.endsWith("/sandboxes/versions/sbv_1"))
      return input.versionStatus === undefined
        ? json(
            input.spec === undefined
              ? { version }
              : {
                  version,
                  source: sourceWith(input.spec, input.aliasRules),
                },
          )
        : json({ error: "Not found." }, input.versionStatus);
    return json({ error: "Not found." }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function open(path = "/sandboxes/acme/sbv_1") {
  window.history.replaceState(null, "", path);
  const address = sandboxFilesForPath(window.location.pathname);
  if (address === undefined) throw new Error(`not a files path: ${path}`);
  render(<SandboxFilesPage address={address} />);
}

test("a version's files are addressed by workspace and version, with the open file in the query", () => {
  expect(sandboxFilesPath({ workspace: "acme", versionId: "sbv_1" })).toBe(
    "/sandboxes/acme/sbv_1",
  );
  expect(
    sandboxFilesPath(
      { workspace: "acme", versionId: "sbv_1" },
      "project/src/a b.ts",
    ),
  ).toBe("/sandboxes/acme/sbv_1?path=project%2Fsrc%2Fa+b.ts");
  expect(sandboxFilesForPath("/sandboxes/acme/sbv_1/")).toEqual({
    workspace: "acme",
    versionId: "sbv_1",
  });
  expect(sandboxFilesForPath("/sandboxes/acme")).toBeUndefined();
  expect(sandboxFilesForPath("/sandboxes/acme/sbv_1/more")).toBeUndefined();
  expect(sandboxFilesForPath("/bounties/acme/sbv_1")).toBeUndefined();
  expect(sandboxFilesForPath("/sandboxes/%E0/sbv_1")).toBeUndefined();
});

test("a flat file list becomes folders first, each level by name", () => {
  const tree = fileTree(built.files);
  expect(tree.map((node) => node.name)).toEqual([
    "private",
    "project",
    "build-manifest.json",
  ]);
  const project = tree[1];
  expect(
    project?.kind === "folder" && project.children.map((node) => node.path),
  ).toEqual([
    "project/src",
    "project/tests",
    "project/logo.png",
    "project/README.md",
  ]);
  expect(foldersOf("project/src/invite.ts")).toEqual([
    "project",
    "project/src",
  ]);
  expect(firstFile(built.files.map(({ path }) => path))).toBe(
    "project/README.md",
  );
  expect(firstFile(["project/a.ts", "z.json"])).toBe("project/a.ts");
  expect(firstFile(["z.json"])).toBe("z.json");
  expect(firstFile([])).toBeUndefined();
  expect([sizeLabel(812), sizeLabel(4_200), sizeLabel(1_300_000)]).toEqual([
    "812 B",
    "4.2 KB",
    "1.3 MB",
  ]);
});

test("an admin browses the private sandbox: the explorer beside the open file, read-only", async () => {
  server();
  open();
  expect(
    await screen.findByRole("heading", {
      name: "Invitations are not sent",
    }),
  ).toBeDefined();
  // The way home, and whose it is, either side of it.
  const titleBar = screen.getByRole("banner");
  expect(
    within(titleBar)
      .getByRole("link", { name: "Lunox home" })
      .getAttribute("href"),
  ).toBe("/");
  expect(titleBar.lastElementChild?.textContent).toBe("Acme");
  // The version at the bottom right, and the workspace only at the top.
  const statusBar = screen.getByRole("contentinfo");
  expect(statusBar.lastElementChild?.lastElementChild?.textContent).toBe(
    "Version 2",
  );
  expect(statusBar.textContent).not.toContain("Acme");
  // The README opens first, as a document.
  const viewer = await screen.findByRole("region", {
    name: "project/README.md",
  });
  expect(
    within(viewer).getByRole("heading", { level: 1, name: "Invitations" }),
  ).toBeDefined();
  const files = screen.getByRole("navigation", { name: "Files" });
  // The hidden tests are marked as such.
  expect(
    within(files).getByLabelText("hidden from contributors"),
  ).toBeDefined();

  await userEvent.click(within(files).getByRole("button", { name: "src" }));
  await userEvent.click(within(files).getByRole("link", { name: "invite.ts" }));
  expect(window.location.search).toBe("?path=project%2Fsrc%2Finvite.ts");
  const source = await screen.findByRole("region", {
    name: "project/src/invite.ts",
  });
  expect((await within(source).findByTestId("file-source")).textContent).toBe(
    "export function invite() {\n  return 1;\n}",
  );
  expect(
    within(files)
      .getByRole("link", { name: "invite.ts" })
      .getAttribute("aria-current"),
  ).toBe("page");

  // A folder closes and opens again.
  const project = within(files).getByRole("button", { name: "project" });
  expect(project.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(project);
  expect(within(files).queryByRole("link", { name: "README.md" })).toBeNull();
});

test("a file named in the address opens with its folders, and one that is not text says so", async () => {
  server();
  open("/sandboxes/acme/sbv_1?path=project%2Flogo.png");
  const viewer = await screen.findByRole("region", {
    name: "project/logo.png",
  });
  expect(
    await within(viewer).findByText(
      "This file is not text, so it is not shown here.",
    ),
  ).toBeDefined();
  cleanup();

  server();
  open("/sandboxes/acme/sbv_1?path=private%2Fhidden.test.ts");
  const hidden = await screen.findByRole("region", {
    name: "private/hidden.test.ts",
  });
  expect((await within(hidden).findByTestId("file-source")).textContent).toBe(
    "describe('invites', () => {\n  test('sends');\n  it(\"retries\");\n});",
  );
  cleanup();

  server();
  open("/sandboxes/acme/sbv_1?path=project%2Fgone.ts");
  expect(await screen.findByText(/This version has no file at/)).toBeDefined();
});

test("members are told it is for owners and admins, and nothing is read", async () => {
  const { calls } = server({ role: "member" });
  open();
  expect(await screen.findByText("Owners and admins only")).toBeDefined();
  expect(calls.some((url) => url.includes("/sandboxes/"))).toBe(false);
});

test("a version not built yet, still building, or not in the workspace says so", async () => {
  server({ files: () => ({ run: null, files: [] }) });
  open();
  expect(
    await screen.findByText(
      "This version has not been built yet, so it has no files.",
    ),
  ).toBeDefined();
  cleanup();

  let status = "running";
  server({
    files: () => ({
      run: { id: "arn_build", status },
      files: status === "running" ? [] : built.files,
    }),
  });
  open();
  expect(
    await screen.findByText(
      "Its build is still running; its files appear when it finishes.",
    ),
  ).toBeDefined();
  status = "succeeded";
  await waitFor(
    () =>
      expect(screen.getByRole("navigation", { name: "Files" })).toBeDefined(),
    { timeout: 5_000 },
  );
  cleanup();

  server({ versionStatus: 404 });
  open("/sandboxes/acme/sbv_1");
  expect(
    await screen.findByText("This version does not exist in Acme."),
  ).toBeDefined();
  cleanup();

  server();
  open("/sandboxes/elsewhere/sbv_1");
  expect(await screen.findByText("Workspace unavailable")).toBeDefined();
});

test("a file's name picks its icon and its language, as the editor's would", () => {
  expect(
    [
      "invite.ts",
      "invite.test.ts",
      "App.tsx",
      "package.json",
      "tsconfig.build.json",
      ".env.local",
      "sandbox.env",
      "Dockerfile",
      "erd.mmd",
      "dependency-cruiser.dot",
      "notes",
    ].map(fileIconName),
  ).toEqual([
    "file-type-typescript",
    "file-type-testts",
    "file-type-reactts",
    "file-type-npm",
    "file-type-tsconfig",
    "file-type-dotenv",
    "file-type-dotenv",
    "file-type-docker",
    "file-type-mermaid",
    "file-type-graphviz",
    "default-file",
  ]);
  expect(folderIconName("src", false)).toBe("folder-type-src");
  expect(folderIconName("tests", true)).toBe("folder-type-test-opened");
  expect(folderIconName("sandbox", true)).toBe("default-folder-opened");
  expect(languageOf("project/src/invite.ts")).toEqual({
    id: "typescript",
    label: "TypeScript",
  });
  expect(languageOf("project/sandbox.env").id).toBe("dotenv");
  expect(languageOf("Makefile").id).toBe("make");
  expect(languageOf("data-model/erd.mmd")).toEqual({
    id: "mermaid",
    label: "Mermaid",
  });
  expect(languageOf("project/.nvmrc")).toEqual({
    id: "text",
    label: "Plain Text",
  });
});

test("each file opened gets a tab, and closing the open one moves to its neighbour", async () => {
  server();
  open();
  const files = await screen.findByRole("navigation", { name: "Files" });
  const tabs = screen.getByRole("navigation", { name: "Open editors" });

  await userEvent.click(within(files).getByRole("button", { name: "src" }));
  await userEvent.click(within(files).getByRole("link", { name: "invite.ts" }));
  expect(
    within(tabs)
      .getAllByRole("link")
      .map((tab) => tab.textContent),
  ).toEqual(["README.md", "invite.ts"]);
  expect(
    within(tabs)
      .getByRole("link", { name: "invite.ts" })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(screen.getByRole("contentinfo").textContent).toContain("TypeScript");

  await userEvent.click(
    within(tabs).getByRole("button", { name: "Close invite.ts" }),
  );
  expect(window.location.search).toBe("?path=project%2FREADME.md");
  expect(
    within(tabs)
      .getAllByRole("link")
      .map((tab) => tab.textContent),
  ).toEqual(["README.md"]);
  // Opening another file left the folders around it open.
  expect(
    within(files)
      .getByRole("button", { name: "src" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("the explorer hides and shows from the activity bar, and its folders collapse at once", async () => {
  server();
  open("/sandboxes/acme/sbv_1?path=project%2Fsrc%2Finvite.ts");
  const files = await screen.findByRole("navigation", { name: "Files" });
  // The folders around the file the address names open with it.
  expect(within(files).getByRole("link", { name: "invite.ts" })).toBeDefined();

  await userEvent.click(
    screen.getByRole("button", { name: "Collapse folders" }),
  );
  expect(within(files).queryByRole("link", { name: "README.md" })).toBeNull();
  expect(
    within(files)
      .getByRole("button", { name: "project" })
      .getAttribute("aria-expanded"),
  ).toBe("false");

  const explorer = screen.getByRole("button", { name: "Explorer" });
  await userEvent.click(explorer);
  expect(explorer.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("navigation", { name: "Files" })).toBeNull();
  await userEvent.click(explorer);
  expect(screen.getByRole("navigation", { name: "Files" })).toBeDefined();
});

test("JSON is laid out one member per line, its values exactly as written", () => {
  expect(
    formatJson('{"a":[1.0,12345678901234567890,{}],"b":{"c":"x,\\"{"},"d":[]}'),
  ).toBe(
    [
      "{",
      '  "a": [',
      "    1.0,",
      "    12345678901234567890,",
      "    {}",
      "  ],",
      '  "b": {',
      '    "c": "x,\\"{"',
      "  },",
      '  "d": []',
      "}",
    ].join("\n"),
  );
  expect(formatJson("[]")).toBe("[]");
  expect(formatJson("{not json")).toBeUndefined();
});

test("a JSON file opens formatted, and can be shown as written", async () => {
  server();
  open("/sandboxes/acme/sbv_1?path=build-manifest.json");
  const viewer = await screen.findByRole("region", {
    name: "build-manifest.json",
  });
  await waitFor(() =>
    expect(within(viewer).getByTestId("file-source").textContent).toBe(
      [
        "{",
        '  "run": "arn_build",',
        '  "tests": [',
        "    1.0,",
        "    {",
        '      "a b": "x\\"}"',
        "    }",
        "  ],",
        '  "none": {}',
        "}",
      ].join("\n"),
    ),
  );
  const format = within(viewer).getByRole("button", { name: "Format JSON" });
  expect(format.getAttribute("aria-pressed")).toBe("true");

  await userEvent.click(format);
  expect(format.getAttribute("aria-pressed")).toBe("false");
  expect(within(viewer).getByTestId("file-source").textContent).toBe(
    '{"run":"arn_build","tests":[1.0,{"a b":"x\\"}"}],"none":{}}',
  );
});

test("a Markdown file reads as a document whose links open the sandbox's files", async () => {
  server();
  open();
  const viewer = await screen.findByRole("region", {
    name: "project/README.md",
  });
  const preview = await within(viewer).findByRole("button", {
    name: "Preview",
  });
  expect(preview.getAttribute("aria-pressed")).toBe("true");
  expect(
    within(viewer).queryByRole("button", { name: "Format JSON" }),
  ).toBeNull();
  // A link to a folder opens its first file.
  expect(
    within(viewer)
      .getByRole("link", { name: "the hidden tests" })
      .getAttribute("href"),
  ).toBe("/sandboxes/acme/sbv_1?path=private%2Fhidden.test.ts");

  // As written, it is the source.
  await userEvent.click(preview);
  expect(within(viewer).getByTestId("file-source").textContent).toBe(
    "# Invitations\n\nStart at `src/invite.ts`; see [the hidden tests](../private).",
  );
  await userEvent.click(preview);

  // Inline code naming a file opens it.
  await userEvent.click(
    within(viewer).getByRole("link", { name: "src/invite.ts" }),
  );
  expect(window.location.search).toBe("?path=project%2Fsrc%2Finvite.ts");
  expect(
    await screen.findByRole("region", { name: "project/src/invite.ts" }),
  ).toBeDefined();
});

test("closing the last tab leaves the editor empty until a file is opened", async () => {
  server();
  open();
  const files = await screen.findByRole("navigation", { name: "Files" });
  await screen.findByRole("region", { name: "project/README.md" });
  await userEvent.click(
    screen.getByRole("button", { name: "Close README.md" }),
  );
  expect(window.location.search).toBe("");
  expect(
    screen.getByText("Open a file from the explorer to read it."),
  ).toBeDefined();
  expect(screen.queryByRole("navigation", { name: "Open editors" })).toBeNull();
  expect(
    within(files)
      .getByRole("link", { name: "README.md" })
      .getAttribute("aria-current"),
  ).toBeNull();

  await userEvent.click(within(files).getByRole("link", { name: "README.md" }));
  expect(
    await screen.findByRole("region", { name: "project/README.md" }),
  ).toBeDefined();
});

test("a link resolves from its file's folder to a file, or a folder's first", () => {
  const paths = [
    "project/README.md",
    "project/src/app.ts",
    "project/docs/README.md",
    "project/docs/a.md",
    "private/b.test.ts",
  ];
  const from = "project/README.md";
  expect(linkedFile(paths, from, "src/app.ts")).toBe("project/src/app.ts");
  expect(linkedFile(paths, from, "./src/app.ts#L3")).toBe("project/src/app.ts");
  expect(linkedFile(paths, from, "docs")).toBe("project/docs/README.md");
  expect(linkedFile(paths, from, "../private")).toBe("private/b.test.ts");
  expect(linkedFile(paths, from, "/project/src/app.ts")).toBe(
    "project/src/app.ts",
  );
  expect(linkedFile(paths, from, "../../etc")).toBeUndefined();
  expect(linkedFile(paths, from, "https://example.com")).toBeUndefined();
  expect(linkedFile(paths, from, "#usage")).toBeUndefined();
  expect(linkedFile(paths, from, "missing.ts")).toBeUndefined();
});

test("a feature file reads into its feature, background, scenarios and their parts", () => {
  const feature = parseFeature(FEATURE);
  expect(feature.name).toBe("Invitations are sent");
  expect(feature.description).toBe("An owner invites a teammate, once.");
  expect(feature.tags).toEqual(["@email"]);
  expect(
    feature.scenarios.map(({ kind, name, tags }) => [kind, name, tags]),
  ).toEqual([
    ["background", "", []],
    ["scenario", "The invitee gets one email", ["@smoke"]],
    ["outline", "Bad addresses are refused", []],
    ["scenario", "The body", []],
  ]);
  expect(scenarioCount(feature)).toBe(3);
  const [, first, outline, body] = feature.scenarios;
  expect(first?.steps.map(({ keyword, line }) => [keyword, line])).toEqual([
    ["When", 10],
    ["Then", 11],
  ]);
  expect(outline?.examples).toEqual([
    { name: "", table: [["address"], ["ada@"]] },
  ]);
  expect(body?.steps[0]?.docString).toBe("      You were invited.");
});

test("tests and search lines are found in a file's text", () => {
  expect(
    ["a.test.ts", "b.spec.mjs", "c.steps.ts", "d.feature", "e.ts"].map(
      isTestFile,
    ),
  ).toEqual([true, true, true, true, false]);
  expect(
    testCases(
      "describe('invites', () => {\n  test('sends');\n  it.skip(\"it's late\");\n});",
    ),
  ).toEqual([
    { name: "invites", line: 1, group: true },
    { name: "sends", line: 2, group: false },
    { name: "it's late", line: 3, group: false },
  ]);
  expect(searchLines("  Run it\nrun\nnone", "run", false)).toEqual([
    { line: 1, text: "Run it", start: 0, end: 3 },
    { line: 2, text: "run", start: 0, end: 3 },
  ]);
  expect(searchLines("Run\nrun", "run", true).map(({ line }) => line)).toEqual([
    2,
  ]);
  expect(searchLines("text", "", false)).toEqual([]);
});

test("a feature file opens laid out as scenarios, a line of it as written", async () => {
  server();
  open("/sandboxes/acme/sbv_1?path=project%2Ftests%2Finvite.feature");
  const viewer = await screen.findByRole("region", {
    name: "project/tests/invite.feature",
  });
  await within(viewer).findByTestId("gherkin-document");
  expect(
    within(viewer).getByRole("heading", {
      level: 1,
      name: "Invitations are sent",
    }),
  ).toBeDefined();
  expect(within(viewer).getByText("3 scenarios · 6 steps")).toBeDefined();
  const scenario = within(viewer).getByRole("region", {
    name: "The invitee gets one email",
  });
  expect(within(scenario).getByText("@smoke")).toBeDefined();

  await userEvent.click(
    within(scenario).getByRole("button", { name: /Line 9/ }),
  );
  expect(window.location.hash).toBe("#L9");
  expect(within(viewer).getByTestId("revealed-line")).toBeDefined();
  // Back to the scenarios, which have no lines to point at.
  await userEvent.click(
    within(viewer).getByRole("button", { name: "Preview" }),
  );
  expect(window.location.hash).toBe("");
  expect(within(viewer).getByTestId("gherkin-document")).toBeDefined();
});

test("search finds a query across the files and opens a match at its line", async () => {
  server();
  open();
  await screen.findByRole("navigation", { name: "Files" });
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(screen.queryByRole("navigation", { name: "Files" })).toBeNull();
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Search" }),
    "RETRIES",
  );
  const results = screen.getByRole("list", { name: "Search results" });
  await waitFor(() =>
    expect(
      within(results).getByRole("link", { name: /retries/ }),
    ).toBeDefined(),
  );
  expect(screen.getByRole("status").textContent).toBe("1 result in 1 file");

  await userEvent.click(screen.getByRole("button", { name: "Match case" }));
  expect(screen.getByRole("status").textContent).toBe("No results found.");
  await userEvent.click(screen.getByRole("button", { name: "Match case" }));

  await userEvent.click(within(results).getByRole("link", { name: /retries/ }));
  expect(window.location.search).toBe("?path=private%2Fhidden.test.ts");
  expect(window.location.hash).toBe("#L3");
  const viewer = await screen.findByRole("region", {
    name: "private/hidden.test.ts",
  });
  expect(await within(viewer).findByTestId("revealed-line")).toBeDefined();
});

test("the tests view lists each file's cases, hidden ones apart, and opens one at its line", async () => {
  server();
  open();
  await screen.findByRole("navigation", { name: "Files" });
  await userEvent.click(screen.getByRole("button", { name: "Tests" }));
  const hidden = screen.getByRole("region", { name: "Hidden" });
  expect(
    within(hidden).getByLabelText("hidden from contributors"),
  ).toBeDefined();
  expect(await within(hidden).findByText("2 tests")).toBeDefined();
  await userEvent.click(within(hidden).getByRole("link", { name: "retries" }));
  expect(window.location.hash).toBe("#L3");

  const features = screen.getByRole("region", { name: "project/tests" });
  expect(
    await within(features).findByRole("link", {
      name: "The invitee gets one email",
    }),
  ).toBeDefined();
});

test("the docs view lists features by title and documents by folder", async () => {
  server();
  open();
  await screen.findByRole("navigation", { name: "Files" });
  await userEvent.click(screen.getByRole("button", { name: "Docs" }));
  const features = screen.getByRole("region", { name: "Features" });
  expect(
    await within(features).findByRole("link", {
      name: /Invitations are sent\s*3 scenarios/,
    }),
  ).toBeDefined();
  const project = screen.getByRole("region", { name: "project" });
  await userEvent.click(
    within(project).getByRole("link", { name: "README.md" }),
  );
  expect(window.location.search).toBe("?path=project%2FREADME.md");
});

test("the docs view lists the version's frozen scenarios after its documents and opens them as a document", async () => {
  server({ spec: draft });
  open();
  await screen.findByRole("navigation", { name: "Files" });
  // The bounty, opened from beside the title and atop the docs.
  expect(
    within(screen.getByRole("banner"))
      .getByRole("link", { name: "Open the bounty" })
      .getAttribute("href"),
  ).toBe("/bounties/acme/bty_7?tab=bounty");
  // No view of their own: the scenarios are the first of the docs.
  expect(screen.queryByRole("button", { name: "Scenarios" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Docs" }));
  const docs = screen.getByRole("complementary", { name: "Docs" });
  const outline = await within(docs).findByRole("region", {
    name: "Bounty scenarios",
  });
  const bounty = within(docs).getByRole("region", { name: "Bounty" });
  // What it pays and its size; this version froze no price.
  expect(bounty.textContent).toBe("BountyUnpricedSizeM");
  expect(within(bounty).getByRole("link").getAttribute("href")).toBe(
    "/bounties/acme/bty_7?tab=bounty",
  );
  // Documents first, then the scenarios, beside the features.
  expect(
    within(docs)
      .getAllByRole("region")
      .filter((region) => region.parentElement === outline.parentElement)
      .map((region) => region.getAttribute("aria-label")),
  ).toEqual(["Bounty", "project", "Bounty scenarios", "Features"]);
  expect(outline.textContent).toContain("3 pts");
  // Each under its kind, with its weight beside it; the whole of it in the
  // tooltip, since the row cuts a long title short.
  const invitee = within(outline).getByRole("link", {
    name: /The invitee gets one email/,
  });
  expect(invitee.textContent).toContain("Light · 1 pt");
  expect(invitee.getAttribute("title")).toMatch(/Happy path · Light · 1 pt$/);
  expect(
    invitee.closest("li")?.parentElement?.closest("li")?.textContent,
  ).toMatch(/^Happy path/);
  const refusedRow = within(outline).getByRole("link", {
    name: /A bad address is refused/,
  });
  expect(refusedRow.textContent).toContain("Moderate · 2 pts");
  expect(
    refusedRow.closest("li")?.parentElement?.closest("li")?.textContent,
  ).toMatch(/^Unhappy path/);

  await userEvent.click(
    within(outline).getByRole("link", { name: /A bad address is refused/ }),
  );
  expect(window.location.search).toBe("?doc=scenarios");
  expect(window.location.hash).toBe("#scenario-s2");
  const tabs = screen.getByRole("navigation", { name: "Open editors" });
  expect(
    within(tabs)
      .getByRole("link", { name: "Scenarios" })
      .getAttribute("aria-current"),
  ).toBe("page");

  // One part at a time: that scenario alone, and the parts either side.
  const document = screen.getByRole("region", { name: "Scenarios" });
  const refused = within(document).getByRole("region", {
    name: "A bad address is refused",
  });
  expect(within(refused).getByText("Reviewer")).toBeDefined();
  expect(within(refused).getByText("Moderate · 2 pts")).toBeDefined();
  expect(
    within(document).queryByRole("region", {
      name: "The invitee gets one email",
    }),
  ).toBeNull();
  expect(
    within(document).queryByRole("region", { name: "Open questions" }),
  ).toBeNull();
  expect(document.textContent).toContain("3 of 5");
  expect(
    within(document).getByRole("link", {
      name: "Previous: The invitee gets one email",
    }),
  ).toBeDefined();
  await userEvent.click(
    within(document).getByRole("link", { name: "Next: Open questions" }),
  );
  expect(window.location.hash).toBe("#open-questions");
  expect(
    within(document).getByRole("region", { name: "Open questions" })
      .textContent,
  ).toContain("Is a second invite allowed?");

  // With no part named, an overview of them all to pick from.
  await userEvent.click(
    within(document).getByRole("link", { name: "Bounty scenarios" }),
  );
  expect(window.location.hash).toBe("");
  expect(
    within(document).getByRole("heading", {
      level: 1,
      name: "Invitations are sent",
    }),
  ).toBeDefined();
  expect(document.textContent).toContain("2 scenarios · 3 steps · 3 points");
  expect(
    within(document)
      .getByRole("link", { name: /Open bounty/ })
      .getAttribute("href"),
  ).toBe("/bounties/acme/bty_7?tab=bounty");
  expect(
    within(document)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.includes("#"))
      .map((link) => link.getAttribute("href")?.split("#")[1]),
  ).toEqual([
    "background",
    "scenario-s1",
    "scenario-s2",
    "open-questions",
    "assumptions",
  ]);
  await userEvent.click(
    within(document).getByRole("link", { name: /The invitee gets one email/ }),
  );
  expect(
    within(document).getByRole("region", { name: "The invitee gets one email" })
      .textContent,
  ).toContain("one more assertion");

  // Open questions and assumptions are a card each in the outline.
  const notes = within(outline).getByRole("list", { name: "Notes" });
  expect(
    within(notes)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual(["Open questions1", "Assumptions1"]);
  await userEvent.click(
    within(notes).getByRole("link", { name: /Assumptions/ }),
  );
  expect(window.location.hash).toBe("#assumptions");
  expect(
    within(document).getByRole("region", { name: "Assumptions" }).textContent,
  ).toContain("Email is the only channel.");

  // The parts loop: after the last comes the first, before the first the last.
  await userEvent.click(
    within(document).getByRole("link", {
      name: "Next: What every scenario starts from",
    }),
  );
  expect(window.location.hash).toBe("#background");
  expect(
    within(document).getByRole("link", { name: "Previous: Assumptions" }),
  ).toBeDefined();

  // A file opened beside it, the scenarios keep their tab.
  await userEvent.click(within(tabs).getByRole("link", { name: "README.md" }));
  expect(window.location.search).toBe("?path=project%2FREADME.md");
  expect(within(tabs).getByRole("link", { name: "Scenarios" })).toBeDefined();
});

test("the scenarios open straight from the address, and a version without a spec says so", async () => {
  server({ spec: draft });
  open("/sandboxes/acme/sbv_1?doc=scenarios");
  expect(
    await screen.findByRole("heading", {
      level: 1,
      name: "Invitations are sent",
    }),
  ).toBeDefined();
  cleanup();

  server({ spec: null });
  open("/sandboxes/acme/sbv_1?doc=scenarios");
  const document = await screen.findByRole("region", { name: "Scenarios" });
  expect(
    await within(document).findByText(
      "This version was approved without a spec, so it has no scenarios.",
    ),
  ).toBeDefined();
});

test("the pill switches to the public sandbox, which is the project alone, and back", async () => {
  server({ spec: draft });
  open("/sandboxes/acme/sbv_1?path=private%2Fhidden.test.ts");
  const titleBar = await screen.findByRole("banner");
  const pill = within(titleBar).getByRole("button", {
    name: "Private sandbox",
  });
  const files = await screen.findByRole("navigation", { name: "Files" });
  expect(within(files).getByRole("button", { name: /^private/ })).toBeDefined();
  expect(
    within(files).getByRole("link", { name: "pseudonym.lunox" }),
  ).toBeDefined();

  // A hidden test is not in the public sandbox: its first file opens instead.
  await userEvent.click(pill);
  expect(window.location.search).toBe("?side=public");
  expect(
    await screen.findByRole("region", { name: "project/README.md" }),
  ).toBeDefined();
  expect(within(files).queryByRole("button", { name: /^private/ })).toBeNull();
  expect(
    within(files).queryByRole("link", { name: "pseudonym.lunox" }),
  ).toBeNull();
  expect(
    within(files).queryByRole("link", { name: "build-manifest.json" }),
  ).toBeNull();
  // Moving through files stays on the public side.
  await userEvent.click(within(files).getByRole("button", { name: "src" }));
  await userEvent.click(within(files).getByRole("link", { name: "invite.ts" }));
  expect(window.location.search).toBe(
    "?path=project%2Fsrc%2Finvite.ts&side=public",
  );

  // Back on the private side, on the same file.
  await userEvent.click(
    within(titleBar).getByRole("button", { name: "Public sandbox" }),
  );
  expect(window.location.search).toBe("?path=project%2Fsrc%2Finvite.ts");
  expect(
    within(titleBar).getByRole("button", { name: "Private sandbox" }),
  ).toBeDefined();
  expect(within(files).getByRole("button", { name: /^private/ })).toBeDefined();
});

test("pseudonym.lunox lists each private name beside its public one, in the private folder", async () => {
  server({
    spec: draft,
    aliasRules: [
      {
        before: "InviteMailer",
        after: "MessageSender",
        kind: "identifier",
        paths: [],
      },
      {
        before: "src/mailer",
        after: "src/sender",
        kind: "path",
        paths: ["src"],
      },
    ],
  });
  open();
  const files = await screen.findByRole("navigation", { name: "Files" });
  await userEvent.click(
    await within(files).findByRole("link", { name: "pseudonym.lunox" }),
  );
  expect(window.location.search).toBe("?path=private%2Fpseudonym.lunox");
  const document = await screen.findByRole("region", {
    name: "private/pseudonym.lunox",
  });
  const table = await within(document).findByRole("table");
  const rows = within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );
  expect(rows).toEqual([
    ["1", "Identifier", "InviteMailer", "MessageSender", "Every file"],
    ["2", "Path", "src/mailer", "src/sender", "src"],
  ]);
  expect(
    within(document).getByText("2 rules: 1 identifier, 1 path"),
  ).toBeDefined();
  cleanup();

  // A generated version from before starters had pseudonyms says so.
  server({ spec: draft });
  open("/sandboxes/acme/sbv_1?path=private%2Fpseudonym.lunox");
  expect(
    await screen.findByText(
      /written before starters had pseudonyms; generate it again/,
    ),
  ).toBeDefined();
  cleanup();

  // The public sandbox never shows it.
  server({ spec: draft });
  open("/sandboxes/acme/sbv_1?path=private%2Fpseudonym.lunox&side=public");
  expect(
    await screen.findByText(/Pseudonyms are never shown to contributors/),
  ).toBeDefined();
});

test("the private sandbox reads the stored, public files back in their private names", async () => {
  server({
    spec: draft,
    aliasRules: [
      { before: "summon", after: "invite", kind: "identifier", paths: [] },
    ],
    files: () => ({
      ...built,
      files: [...built.files, fileOf("private/pseudonym.lunox")],
    }),
  });
  open("/sandboxes/acme/sbv_1?path=project%2Fsrc%2Finvite.ts");
  const source = async () =>
    (
      await within(
        await screen.findByRole("region", { name: "project/src/invite.ts" }),
      ).findByTestId("file-source")
    ).textContent;
  await waitFor(async () =>
    expect(await source()).toBe("export function summon() {\n  return 1;\n}"),
  );
  // A build's own pseudonym.lunox is listed once.
  const files = screen.getByRole("navigation", { name: "Files" });
  expect(
    within(files).getAllByRole("link", { name: "pseudonym.lunox" }),
  ).toHaveLength(1);

  // The public sandbox is the files as stored.
  await userEvent.click(
    within(screen.getByRole("banner")).getByRole("button", {
      name: "Private sandbox",
    }),
  );
  await waitFor(async () =>
    expect(await source()).toBe("export function invite() {\n  return 1;\n}"),
  );
});

test("a version that cannot be read says so, with a retry, not that it has no spec", async () => {
  server({ versionStatus: 500 });
  open();
  expect(
    await screen.findByText("This version could not be read."),
  ).toBeDefined();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  expect(screen.queryByText(/approved without a spec/)).toBeNull();
});
