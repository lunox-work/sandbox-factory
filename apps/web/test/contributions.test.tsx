/**
 * An invited contributor's side of the app: the invite link signed out and
 * signed in, the shell for someone in no workspace, and the contribution
 * page (the task, its download and commands, the folder upload with its
 * preview, and each verdict). The server is faked at `fetch` and the auth
 * client, as in `app.test.tsx`.
 */

import type { ContributionSubmissionDto } from "@sandbox-factory/shared";

import { render, screen, waitFor, within } from "./render";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const useSession = vi.fn();

vi.mock("../src/auth", () => ({
  useSession: () => useSession(),
  signOut: vi.fn(),
  authClient: {
    listAccounts: () => Promise.resolve({ data: [] }),
    unlinkAccount: vi.fn(),
    linkSocial: vi.fn(),
    organization: { setActive: () => Promise.resolve({}) },
  },
  PROVIDERS: [{ id: "google", label: "Continue with Google" }],
  signInWith: vi.fn(),
}));

const stamp = "2026-11-15T00:00:00.000Z";
const TOKEN = `lnxinv_${"a".repeat(40)}`;
const contribution = {
  assignmentId: "cas_1",
  versionId: "sbv_1",
  version: 2,
  root: "sbx_1-v2",
  title: "Statement fees",
  specSummary: "Each debit line shows the fee it paid.",
  complexity: "S",
  tags: ["typescript"],
  commands: {
    install: "npm ci",
    build: "npm run build",
    test: "npm test",
    dev: "npm run dev",
  },
  editablePaths: ["src/fees.ts"],
  nodeRange: ">=22.12.0",
  open: true,
  closesAt: "2026-12-31T00:00:00.000Z",
  joinedAt: stamp,
};
const submission = (overrides: object = {}): ContributionSubmissionDto =>
  ({
    id: "sbm_1",
    sandboxVersionId: "sbv_1",
    status: "failed",
    errorCode: null,
    verdict: "overfit",
    public: { passed: 3, total: 3 },
    hidden: { passed: 2, total: 3 },
    failedScenarios: ["s3"],
    refused: [],
    retryOf: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  }) as ContributionSubmissionDto;
const preview = (overrides: object = {}) => ({
  files: [{ path: "src/fees.ts", change: "changed" }],
  ignored: [".vscode/settings.json"],
  skipped: 12,
  missing: [],
  refused: [],
  ...overrides,
});

const contributorToken = {
  id: "ctk_1",
  name: "Cursor",
  prefix: "lnxc_ssssssss",
  createdAt: stamp,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};

/** What the fake API answers, per test. */
let contributorTokens: unknown[] = [];
let organizations: unknown[] = [];
let claim: () => Response = () =>
  Response.json({ contribution }, { status: 201 });
let submissions: unknown[] = [];
let dryRun: () => Response = () => Response.json({ preview: preview() });
const calls: { method: string; url: string; body: unknown }[] = [];

const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, url, body: init?.body });
  if (url.includes("/api/v1/me/orgs"))
    return Promise.resolve(Response.json({ organizations }));
  if (url.endsWith("/api/v1/invites/claim")) return Promise.resolve(claim());
  if (url.endsWith("/api/v1/contributions"))
    return Promise.resolve(Response.json({ contributions: [contribution] }));
  if (url.endsWith("/api/v1/me/contributor-tokens"))
    return Promise.resolve(
      method === "POST"
        ? Response.json(
            {
              token: contributorToken,
              secret: `lnxc_${"s".repeat(40)}`,
            },
            { status: 201 },
          )
        : Response.json({ tokens: contributorTokens }),
    );
  if (url.includes("/api/v1/me/contributor-tokens/"))
    return Promise.resolve(
      Response.json({ token: { ...contributorToken, revokedAt: stamp } }),
    );
  if (url.endsWith("/api/v1/me/contributor-grants"))
    return Promise.resolve(Response.json({ grants: [] }));
  if (url.includes("/submissions/zip") || url.includes("/retry/zip"))
    return Promise.resolve(
      url.includes("dryRun")
        ? dryRun()
        : Response.json(
            { submission: submission({ status: "queued", verdict: null }) },
            { status: 202 },
          ),
    );
  if (url.endsWith("/regrade"))
    return Promise.resolve(
      Response.json({ submission: submission({ status: "queued" }) }),
    );
  if (url.endsWith("/contributions/sbv_1/submissions"))
    return Promise.resolve(Response.json({ submissions }));
  if (url.endsWith("/contributions/sbv_1"))
    return Promise.resolve(Response.json({ contribution }));
  return Promise.resolve(Response.json({}));
});
vi.stubGlobal("fetch", fetchMock);

const { App } = await import("../src/App");
const { ContributionPage, nextStep } =
  await import("../src/features/contributions/ContributionPage");
const { crc32, zipEntries, folderProblem, pickedEntries } =
  await import("../src/features/contributions/folder-zip");
const { inviteTokenOf } =
  await import("../src/features/contributions/InvitePage");

function session(user: { id: string; name: string } | null) {
  useSession.mockReturnValue({ data: user === null ? null : { user } });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  organizations = [];
  contributorTokens = [];
  submissions = [];
  claim = () => Response.json({ contribution }, { status: 201 });
  dryRun = () => Response.json({ preview: preview() });
  calls.length = 0;
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

test("signed out, an invite link keeps its secret out of the address while signing in", async () => {
  window.history.replaceState(null, "", `/invite#${TOKEN}`);
  session(null);
  render(<App />);
  expect(
    screen.getByText(
      "Sign in to accept your invite. You will land on the task.",
    ),
  ).toBeTruthy();
  // Out of the address, so the sign-in's callback never carries it.
  await waitFor(() => expect(window.location.hash).toBe(""));
  expect(window.location.pathname).toBe("/invite");
  expect(window.sessionStorage.getItem("lunox:invite")).toBe(TOKEN);
});

test("signed in, the invite is claimed once and lands on the task", async () => {
  // Back from the provider: the stash, no fragment.
  window.sessionStorage.setItem("lunox:invite", TOKEN);
  window.history.replaceState(null, "", "/invite");
  session({ id: "user_c", name: "Grace" });
  render(<App />);
  expect(
    await screen.findByRole("heading", { name: "Statement fees", level: 1 }),
  ).toBeTruthy();
  expect(window.location.pathname).toBe("/contributions/sbv_1");
  const claims = calls.filter((call) => call.url.endsWith("/invites/claim"));
  expect(claims.length).toBeGreaterThanOrEqual(1);
  expect(JSON.parse(String(claims[0]?.body))).toEqual({ token: TOKEN });
  expect(window.sessionStorage.getItem("lunox:invite")).toBeNull();
  // The rail offers the contributor's work, and the trail names the task.
  const rail = screen.getByRole("navigation", { name: "Main" });
  expect(
    within(rail).getByRole("link", { name: "Contributions" }),
  ).toBeTruthy();
  const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(trail).getByText("Statement fees")).toBeTruthy();
});

test("an invite no longer valid, or for a member, says so plainly", async () => {
  claim = () =>
    Response.json(
      { error: "This invite is not valid.", code: "invite_unavailable" },
      { status: 404 },
    );
  window.history.replaceState(null, "", `/invite#${TOKEN}`);
  session({ id: "user_c", name: "Grace" });
  const { unmount } = render(<App />);
  expect(
    await screen.findByRole("heading", {
      name: "This invite is no longer valid",
    }),
  ).toBeTruthy();
  expect(window.location.hash).toBe("");
  unmount();

  claim = () =>
    Response.json(
      { error: "You are a member.", code: "already_member" },
      { status: 409 },
    );
  window.history.replaceState(null, "", `/invite#${TOKEN}`);
  render(<App />);
  expect(
    await screen.findByRole("heading", {
      name: "You are already in this workspace",
    }),
  ).toBeTruthy();
});

test("a link without a secret claims nothing", async () => {
  window.history.replaceState(null, "", "/invite");
  session({ id: "user_c", name: "Grace" });
  render(<App />);
  expect(
    await screen.findByRole("heading", {
      name: "This link has no invite in it",
    }),
  ).toBeTruthy();
  expect(calls.some((call) => call.url.endsWith("/invites/claim"))).toBe(false);
  expect(inviteTokenOf("#lnxinv_short")).toBeNull();
  expect(inviteTokenOf(`#${TOKEN}`)).toBe(TOKEN);
});

test("in no workspace at all, home is the contributor's tasks", async () => {
  session({ id: "user_c", name: "Grace" });
  render(<App />);
  expect(
    await screen.findByRole("heading", { name: "Contributions", level: 1 }),
  ).toBeTruthy();
  const link = await screen.findByRole("link", { name: /Statement fees/ });
  expect(link.getAttribute("href")).toBe("/contributions/sbv_1");
  expect(screen.queryByText("You are not in a workspace yet.")).toBeNull();
  const rail = screen.getByRole("navigation", { name: "Main" });
  expect(
    within(rail).getByRole("link", { name: "Contributions" }),
  ).toBeTruthy();
});

test("the task page shows the project, its commands, and each verdict plainly", async () => {
  submissions = [
    submission({
      id: "sbm_2",
      retryOf: "sbm_1",
      status: "errored",
      errorCode: "grading_timed_out",
      verdict: null,
      public: null,
      hidden: null,
      failedScenarios: [],
    }),
    submission(),
  ];
  render(<ContributionPage versionId="sbv_1" />);
  expect(
    await screen.findByRole("heading", { name: "Statement fees" }),
  ).toBeTruthy();
  expect(
    screen.getByText("Each debit line shows the fee it paid."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download project" })).toBeTruthy();
  for (const command of ["npm ci", "npm test", "npm run build", "npm run dev"])
    expect(screen.getByText(command)).toBeTruthy();
  expect(screen.getByText("src/fees.ts")).toBeTruthy();
  expect(screen.getByText(/one retry/)).toBeTruthy();
  const list = await screen.findByTestId("contribution-submissions");
  expect(within(list).getByText("Overfit")).toBeTruthy();
  expect(within(list).getByText("s3")).toBeTruthy();
  expect(within(list).getByText("Not graded")).toBeTruthy();
  expect(within(list).getByText(/Grading ran out of time/)).toBeTruthy();
  // Not graded: grading again, which keeps the retry, is the next step.
  expect(screen.getByText(/could not be graded\. Grade it again/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Grade again" }));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.url.endsWith("/contributions/sbv_1/submissions/sbm_2/regrade"),
      ),
    ).toBe(true),
  );
});

test("a refused submission names each file and why", async () => {
  submissions = [
    submission({
      verdict: "refused",
      public: null,
      hidden: null,
      failedScenarios: [],
      refused: [{ path: "src/x.ts", reason: "Task code must import modules." }],
    }),
  ];
  render(<ContributionPage versionId="sbv_1" />);
  const list = await screen.findByTestId("contribution-submissions");
  expect(within(list).getByText("Refused")).toBeTruthy();
  expect(within(list).getByText("src/x.ts")).toBeTruthy();
  expect(within(list).getByText("Task code must import modules.")).toBeTruthy();
});

test("a zipped folder is previewed, then submitted; its first verdict leaves one retry", async () => {
  render(<ContributionPage versionId="sbv_1" />);
  await screen.findByTestId("folder-drop");
  const zip = new File([new Uint8Array([80, 75, 5, 6])], "sbx_1-v2.zip", {
    type: "application/zip",
  });
  await userEvent.upload(screen.getByLabelText("Project .zip"), zip);
  const shown = await screen.findByTestId("folder-preview");
  expect(within(shown).getByText("src/fees.ts")).toBeTruthy();
  expect(within(shown).getByText("Changed")).toBeTruthy();
  expect(within(shown).getByText(".vscode/settings.json")).toBeTruthy();
  expect(within(shown).getByText(/12 files skipped/)).toBeTruthy();
  const dry = calls.find((call) => call.url.includes("dryRun=1"));
  expect(dry?.url).toBe("/api/v1/contributions/sbv_1/submissions/zip?dryRun=1");
  expect(dry?.body).toBe(zip);
  submissions = [submission()];
  await userEvent.click(screen.getByRole("button", { name: "Submit 1 file" }));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.url === "/api/v1/contributions/sbv_1/submissions/zip",
      ),
    ).toBe(true),
  );
  // Read again: overfit, so the one retry is offered, against the first.
  expect(await screen.findByText(/You have one retry left/)).toBeTruthy();
  await userEvent.upload(screen.getByLabelText("Project .zip"), zip);
  await screen.findByTestId("folder-preview");
  expect(
    calls.some((call) =>
      call.url.endsWith("/submissions/sbm_1/retry/zip?dryRun=1"),
    ),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Submit retry (1 file)" }),
  ).toBeTruthy();
});

test("a folder changing read-only files cannot be submitted, and says which to revert", async () => {
  dryRun = () =>
    Response.json({
      preview: preview({
        refused: [
          {
            path: "package.json",
            reason:
              "package.json is the version's. Revert it to the version's text.",
          },
        ],
      }),
    });
  render(<ContributionPage versionId="sbv_1" />);
  await screen.findByTestId("folder-drop");
  await userEvent.upload(
    screen.getByLabelText("Project .zip"),
    new File([new Uint8Array([1])], "mine.zip", { type: "application/zip" }),
  );
  const shown = await screen.findByTestId("folder-preview");
  expect(within(shown).getByRole("alert").textContent).toMatch(
    /One file stops this folder from being submitted/,
  );
  expect(within(shown).getByText("package.json")).toBeTruthy();
  expect(
    (within(shown).getByRole("button", { name: /Submit/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("a folder the API cannot take says why, and can be dismissed", async () => {
  dryRun = () =>
    Response.json(
      {
        error: "None of the version's files is in this folder.",
        code: "not_the_project",
      },
      { status: 422 },
    );
  render(<ContributionPage versionId="sbv_1" />);
  await screen.findByTestId("folder-drop");
  await userEvent.upload(
    screen.getByLabelText("Project .zip"),
    new File([new Uint8Array([1])], "other.zip", { type: "application/zip" }),
  );
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /other\.zip: None of the version's files is in this folder\./,
  );
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the retry rule: one submission, one retry if it did not pass", () => {
  const first = submission();
  expect(nextStep(true, []).kind).toBe("submit");
  expect(nextStep(true, [first]).kind).toBe("retry");
  expect(
    nextStep(true, [submission({ id: "sbm_2", retryOf: "sbm_1" }), first]).kind,
  ).toBe("spent");
  expect(
    nextStep(true, [submission({ status: "passed", verdict: "passed" })]).kind,
  ).toBe("passed");
  expect(nextStep(true, [submission({ status: "queued" })]).kind).toBe(
    "grading",
  );
  expect(nextStep(false, []).kind).toBe("closed");
  expect(nextStep(false, [first]).kind).toBe("closed");
});

test("a picked folder is zipped in the browser, node_modules left unread", async () => {
  const file = (path: string, text: string) =>
    Object.assign(new File([text], path.split("/").at(-1) ?? path), {
      webkitRelativePath: path,
    });
  const picked = pickedEntries([
    file("sbx-v2/src/fees.ts", "export const fee = 25;\n"),
    file("sbx-v2/node_modules/typescript/package.json", "{}"),
    file("sbx-v2/.git/HEAD", "ref"),
  ]);
  expect(picked.map((entry) => entry.path)).toEqual(["sbx-v2/src/fees.ts"]);
  expect(folderProblem([])).toMatch(/no files/);
  expect(folderProblem(picked)).toBeNull();
  // The entries as plain blobs, read as the browser reads them.
  const text = "export const fee = 25;\n";
  const bytes = new TextEncoder().encode(text);
  const blob = await zipEntries([
    {
      path: "sbx-v2/src/fees.ts",
      file: { arrayBuffer: async () => bytes.buffer } as unknown as Blob,
    },
  ]);
  expect(blob.type).toBe("application/zip");
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
});

test("a contributor's addresses name their screens", async () => {
  const {
    contributionForPath,
    contributionPath,
    pathForScreen,
    screenForPath,
  } = await import("../src/routes");
  expect(screenForPath("/invite")).toBe("invite");
  expect(screenForPath("/contributions")).toBe("contributions");
  expect(screenForPath("/contributions/sbv_1")).toBe("contribution");
  expect(screenForPath("/contributions/sbv_1/x")).toBe("not-found");
  expect(contributionForPath("/contributions/sbv%201/")).toBe("sbv 1");
  expect(contributionForPath("/contributions/%E0%A4%A")).toBeUndefined();
  expect(contributionPath("sbv 1")).toBe("/contributions/sbv%201");
  expect(pathForScreen("contributions")).toBe("/contributions");
  expect(pathForScreen("contribution", undefined, "sbv_1")).toBe(
    "/contributions/sbv_1",
  );
  expect(pathForScreen("invite")).toBe("/invite");
});

test("the contributions page makes a token for an editor or agent, shown once", async () => {
  session({ id: "user_c", name: "Grace" });
  render(<App />);
  const section = await screen.findByRole("region", {
    name: "Tokens for your editor or agent",
  });
  expect(
    await within(section).findByText(
      /claude mcp add --transport http lunox-contribute .*\/mcp\/contribute$/,
    ),
  ).toBeTruthy();
  expect(await within(section).findByText("No tokens yet.")).toBeTruthy();
  const user = userEvent.setup();
  await user.click(within(section).getByRole("button", { name: "New token" }));
  await user.type(within(section).getByLabelText("Name"), "Cursor");
  await user.click(within(section).getByRole("button", { name: "Make token" }));
  expect((await screen.findByTestId("token-secret")).textContent).toBe(
    `lnxc_${"s".repeat(40)}`,
  );
  const made = calls.find(
    (call) =>
      call.method === "POST" &&
      call.url.endsWith("/api/v1/me/contributor-tokens"),
  );
  expect(JSON.parse(String(made?.body))).toEqual({
    name: "Cursor",
    expiresInDays: 90,
  });
  // Listed by its prefix alone once dismissed.
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByTestId("token-secret")).toBeNull();
  expect(within(section).getByText("lnxc_ssssssss…")).toBeTruthy();
});
