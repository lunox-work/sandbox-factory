/**
 * Home: one page that changes with what a workspace has connected.
 *
 * The properties that matter. Each stage shows something of value with no
 * model call — the six kinds of work, a board's backlog scan, a repository's
 * x-ray — and offers the next step as one action. Nothing is sized until
 * someone presses Size, and then only the ticket pressed. A tool the server
 * does not offer, or a person who may not use it, is never offered a button
 * that would be refused.
 *
 * The server is faked at the `fetch` boundary, per route, as elsewhere.
 */

import { resolveCategories } from "sandbox-factory";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { completeBountyFixture } from "./api-fixtures";
import { render, screen, waitFor, within } from "./render";

import { Home, firstName, greeting } from "../src/Home";

const owner = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team" as const,
  role: "owner" as const,
};

const stamp = "2026-10-01T00:00:00.000Z";

const jiraSite = {
  id: "jrc_1",
  cloudId: "cloud-1",
  siteUrl: "https://acme.atlassian.net",
  siteName: "Acme",
  email: null,
  healthy: true,
  scopes: [],
  resourceScopes: [],
  writeGranted: true,
  createdAt: stamp,
};

const board = {
  id: "jrb_1",
  connectionId: "jrc_1",
  externalId: "42",
  name: "Mobile",
  boardType: "scrum",
  projectKey: "ACME",
  selection: { unassignedOnly: false, categories: {} },
  createdAt: stamp,
};

const githubAccount = {
  id: "ghc_1",
  installationId: "9",
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "all",
  healthy: true,
  suspendedAt: null,
  uninstalledAt: null,
  settingsUrl: "https://github.com/organizations/acme/settings/installations/9",
  createdAt: stamp,
};

const widgets = {
  id: "ghr_1",
  connectionId: "ghc_1",
  role: "source",
  externalId: "1296269",
  fullName: "acme/widgets",
  defaultBranch: "main",
  isPrivate: true,
  sizeKb: 120,
  headSha: "a".repeat(40),
  pushedAt: null,
  lastSyncedAt: null,
  syncStatus: "ok",
  syncError: null,
  stack: ["TypeScript", "React"],
  contextSnapshotId: null,
  createdAt: stamp,
};

const snapshot = {
  id: "rsn_1",
  repoId: "ghr_1",
  commitSha: "a".repeat(40),
  ref: "refs/heads/main",
  treeSha: "b".repeat(40),
  treeTruncated: false,
  fileCount: 240,
  totalBytes: 900_000,
  languages: { TypeScript: 800_000 },
  createdAt: stamp,
};

const facts = {
  version: 1,
  fileCount: 240,
  totalBytes: 900_000,
  truncated: false,
  testFiles: 48,
  modules: [
    { path: ".", files: 6, bytes: 1_000, testFiles: 0, extensions: {} },
    { path: "docs", files: 30, bytes: 1_000, testFiles: 0, extensions: {} },
    {
      path: "packages/billing",
      files: 40,
      bytes: 1_000,
      testFiles: 12,
      extensions: {},
    },
    {
      path: "apps/web",
      files: 160,
      bytes: 1_000,
      testFiles: 36,
      extensions: {},
    },
  ],
  extensions: { ".ts": 200 },
  lockfiles: ["package-lock.json"],
  migrationDirectories: ["packages/db/drizzle"],
  infraDirectories: [".github/workflows"],
};

function ticket(n: number, category: { id: string; label: string }) {
  return {
    id: String(1000 + n),
    key: `ACME-${n}`,
    summary: `Ticket ${n}`,
    status: "To Do",
    statusCategory: "new",
    assignee: null,
    priority: null,
    issueType: "Task",
    labels: [],
    projectKey: "ACME",
    parentKey: null,
    created: "2025-01-01T00:00:00.000Z",
    updated: "2025-01-01T00:00:00.000Z",
    dueDate: null,
    url: `https://acme.atlassian.net/browse/ACME-${n}`,
    categories: [{ ...category, reason: `Reason for ${n}` }],
  };
}

const leftBehind = { id: "left-behind", label: "Left behind" };
const paperCuts = { id: "paper-cuts", label: "Paper cuts" };

function preview() {
  return {
    boardId: "jrb_1",
    jql: "project = ACME",
    categories: resolveCategories(),
    issues: [
      ticket(7, leftBehind),
      ticket(8, leftBehind),
      ticket(9, paperCuts),
    ],
    matched: { "left-behind": 2, "paper-cuts": 1 },
    unmatched: 40,
    candidatesScanned: 43,
    skippedLive: 0,
    scanLimitReached: false,
    ticketCapReached: false,
  };
}

interface World {
  /** Null: the server has no Jira at all. */
  jira: (typeof jiraSite)[] | null;
  boards: (typeof board)[];
  /** Null: the server has no GitHub App. */
  github: (typeof githubAccount)[] | null;
  repositories: (typeof widgets)[];
  installationRepositories: {
    externalId: string;
    fullName: string;
    defaultBranch: string;
    isPrivate: boolean;
    registeredId: string | null;
  }[];
  proposals: number;
  /** Bounties written, sized or not. */
  bounties: number;
  /** The board's backlog scan, when not the usual three candidates. */
  scan?: ReturnType<typeof preview> & { fallback?: boolean };
}

let world: World;
let requests: { method: string; url: string; body: unknown }[];

function emptyWorld(): World {
  return {
    jira: [],
    boards: [],
    github: [],
    repositories: [],
    installationRepositories: [],
    proposals: 0,
    bounties: 0,
  };
}

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(completeBountyFixture(body)), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  world = emptyWorld();
  requests = [];
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        method,
        url,
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const base = "/api/v1/orgs/org_1";
      const path = url.startsWith(base) ? url.slice(base.length) : url;

      if (path.startsWith("/jira/") && world.jira === null)
        return json({ error: "Not found" }, 404);
      if (path.startsWith("/github/") && world.github === null)
        return json(
          { error: "GitHub is not set up.", code: "unconfigured" },
          503,
        );

      if (path === "/jira/connections")
        return json({ connections: world.jira });
      if (path === "/jira/boards") return json({ boards: world.boards });
      if (path === "/jira/boards/jrb_1/backlog-preview")
        return json(world.scan ?? preview());
      if (path === "/jira/boards/jrb_1/runs")
        return json({ runs: [], sizingAvailable: true });
      if (method === "POST" && path === "/jira/boards/jrb_1/issues")
        return json({ run: { id: "brn_9", kind: "issue" } }, 202);
      if (path === "/runs/brn_9")
        return json({
          run: {
            id: "brn_9",
            kind: "issue",
            status: "succeeded",
            outcomes: [
              {
                externalIssueId: "1007",
                issueKey: "ACME-7",
                status: "proposed",
                proposalId: "bpr_1",
              },
            ],
          },
        });
      if (path === "/github/connections")
        return json({ connections: world.github });
      if (path === "/github/repositories")
        return json({ repositories: world.repositories });
      if (path === "/github/connections/ghc_1/repositories") {
        if (method === "POST") {
          world.repositories = [widgets];
          return json({ repository: widgets }, 201);
        }
        return json({ repositories: world.installationRepositories });
      }
      if (path === "/github/repositories/ghr_1/snapshots")
        return json({ snapshots: [snapshot] });
      if (path === "/github/snapshots/rsn_1")
        return json({
          snapshot: { ...snapshot, repoFullName: "acme/widgets", facts },
        });
      if (
        path.startsWith("/proposal-categories") ||
        path.endsWith("/proposal-categories")
      )
        return json({
          total: world.proposals,
          uncategorized: world.proposals,
          categories: [],
        });
      if (path.startsWith("/bounties?"))
        return json({
          bounties: Array.from({ length: world.bounties }, (_, index) => ({
            id: `bty_${index}`,
            organizationId: "org_1",
            title: "Written by hand",
            origin: "manual",
            stack: [],
            revision: 1,
            version: 1,
            approval: null,
            jira: null,
            proposal: null,
            sandbox: null,
            createdAt: stamp,
            updatedAt: stamp,
          })),
          nextCursor: null,
        });
      if (path.startsWith("/proposals?"))
        return json({ proposals: [], nextCursor: null });
      if (path === "/rate-card") return json({ rateCard: null });
      return json({ error: "Not found" }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function show(role: "owner" | "member" = "owner") {
  const handlers = {
    onBoardName: vi.fn(),
    onOpenBoard: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenRepository: vi.fn(),
    onWriteBounty: vi.fn(),
    onOpenBounties: vi.fn(),
  };
  const view = render(
    <Home
      userId="user_1"
      name="Ada Example"
      organization={{ ...owner, role }}
      {...handlers}
    />,
  );
  return { ...view, ...handlers };
}

/* -------------------------------------------------------------------------- */
/* Nothing connected                                                          */
/* -------------------------------------------------------------------------- */

test("with nothing connected, home offers three ways in, Jira first, over the six kinds of work", async () => {
  show();

  const paths = await screen.findByTestId("path-cards");
  expect(
    within(paths)
      .getAllByRole("listitem")
      .map((item) => item.getAttribute("data-path")),
  ).toEqual(["jira", "github", "write"]);
  expect(
    within(paths).getByRole("button", { name: /connect jira/i }),
  ).toBeTruthy();
  // Trying it is said to cost nothing, before anyone is asked to connect.
  expect(within(paths).getByText(/runs no AI/)).toBeTruthy();

  const showcase = screen.getByTestId("category-showcase");
  expect(within(showcase).getAllByRole("listitem")).toHaveLength(6);
  expect(within(showcase).getByText("Left behind")).toBeTruthy();

  // The cards are the steps here; a checklist over them would repeat them.
  expect(screen.queryByTestId("setup-checklist")).toBeNull();
});

test("writing a bounty needs nothing connected", async () => {
  const { onWriteBounty } = show();
  const paths = await screen.findByTestId("path-cards");
  await userEvent.click(
    within(paths).getByRole("button", { name: /write a bounty/i }),
  );
  // A bounty names no repository, so none is carried to the form.
  expect(onWriteBounty).toHaveBeenCalledWith();
});

test("bounties written and none sized point at sizing them, not at writing more", async () => {
  world.bounties = 1;
  const { onOpenBounties } = show();
  const paths = await screen.findByTestId("path-cards");
  await userEvent.click(
    within(paths).getByRole("button", { name: /open bounties/i }),
  );
  expect(onOpenBounties).toHaveBeenCalled();
  expect(
    within(paths).queryByRole("button", { name: /write a bounty/i }),
  ).toBeNull();
});

test("a member is told who can connect, not shown buttons that would be refused", async () => {
  show("member");
  const paths = await screen.findByTestId("path-cards");
  expect(within(paths).queryByRole("button", { name: /connect/i })).toBeNull();
  expect(within(paths).getAllByText(/owner or admin/i)).toHaveLength(2);
  // Writing a bounty is still theirs to do.
  expect(
    within(paths).getByRole("button", { name: /write a bounty/i }),
  ).toBeTruthy();
});

test("a server without Jira leaves Jira out of home, not as a failure", async () => {
  world.jira = null;
  show();
  const paths = await screen.findByTestId("path-cards");
  expect(
    within(paths)
      .getAllByRole("listitem")
      .map((item) => item.getAttribute("data-path")),
  ).toEqual(["github", "write"]);
  expect(screen.queryByText(/could not be read/i)).toBeNull();
});

test("a cancelled Jira consent is reported where it started", async () => {
  window.history.replaceState(null, "", "/?jira=cancelled");
  show();
  expect((await screen.findByTestId("jira-outcome")).textContent).toMatch(
    /cancelled/i,
  );
  // Read once: a reload must not announce it again.
  expect(window.location.search).toBe("");
});

test("a GitHub flow that could not be tied to a workspace still says so here", async () => {
  window.history.replaceState(null, "", "/?github=state");
  show();
  expect(await screen.findByTestId("github-outcome")).toBeTruthy();
});

test("a GitHub flow that needs an account picked carries on where the picker is", async () => {
  window.history.replaceState(null, "", "/?github=pick");
  show();
  await waitFor(() =>
    expect(window.location.pathname + window.location.search).toBe(
      "/o/acme/settings?connection=github&github=pick",
    ),
  );
  window.history.replaceState(null, "", "/");
});

/* -------------------------------------------------------------------------- */
/* Jira                                                                       */
/* -------------------------------------------------------------------------- */

test("with Jira connected, home opens on the board's backlog scan, sizing nothing", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  show();

  const scan = await screen.findByTestId("backlog-scan");
  expect(
    await within(scan).findByRole("heading", {
      name: /3 tickets worth outsourcing/,
    }),
  ).toBeTruthy();
  expect(within(scan).getByText(/no AI, nothing stored/)).toBeTruthy();
  // The six, always: an empty one is shown, not pressable.
  const tiles = within(scan).getByTestId("scan-categories");
  expect(within(tiles).getAllByRole("button")).toHaveLength(6);
  expect(
    within(tiles).getByRole("button", { name: "Holding others up, 0 tickets" }),
  ).toHaveProperty("disabled", true);

  // The ticket in focus, as the bounty it would become: the range from the
  // rate card in force, the size and spec left for sizing to fill.
  const teaser = await within(scan).findByTestId("teaser-bounty");
  expect(teaser.textContent).toMatch(/ACME-7/);
  expect(await within(teaser).findByText(/\$58.\$153/)).toBeTruthy();
  expect(
    within(teaser).getByRole("button", { name: "Size ACME-7" }),
  ).toBeTruthy();

  // The checklist has moved on to GitHub.
  const checklist = screen.getByTestId("setup-checklist");
  expect(
    checklist.querySelector("[aria-current='step']")?.getAttribute("data-step"),
  ).toBe("github");

  // Looking is free: nothing asked for sizing.
  expect(requests.filter(({ method }) => method === "POST")).toEqual([]);
});

test("a category shows its own tickets, and the teaser follows the one chosen", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  show();

  const scan = await screen.findByTestId("backlog-scan");
  await userEvent.click(
    await within(scan).findByRole("button", { name: "Paper cuts, 1 ticket" }),
  );
  const list = within(scan).getByTestId("scan-candidates");
  expect(within(list).getAllByRole("button")).toHaveLength(1);
  expect(within(list).getByText("Ticket 9")).toBeTruthy();
  expect(within(scan).getByTestId("scan-why").textContent).toMatch(
    /Paper cuts\./,
  );
  expect(within(scan).getByTestId("teaser-bounty").textContent).toMatch(
    /ACME-9/,
  );
});

test("sizing from the scan is one call for that ticket, and opens its proposal", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  show();

  const teaser = await screen.findByTestId("teaser-bounty");
  await userEvent.click(
    await within(teaser).findByRole("button", { name: "Size ACME-7" }),
  );

  const posts = requests.filter(({ method }) => method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]?.url).toBe("/api/v1/orgs/org_1/jira/boards/jrb_1/issues");
  expect(posts[0]?.body).toMatchObject({ issueId: "1007" });

  // Followed until the proposal lands, then opened over the list.
  await waitFor(
    () =>
      expect(new URLSearchParams(window.location.search).get("proposal")).toBe(
        "bpr_1",
      ),
    { timeout: 4_000 },
  );
});

test("while a ticket is being sized, the list holds it in focus", async () => {
  // Its teaser follows the run and opens the proposal when it lands; a row
  // tapped meanwhile would take it off screen and lose that.
  world.jira = [jiraSite];
  world.boards = [board];
  show();

  const scan = await screen.findByTestId("backlog-scan");
  await userEvent.click(
    await within(scan).findByRole("button", { name: "Size ACME-7" }),
  );
  const other = within(within(scan).getByTestId("scan-candidates"))
    .getByText("Ticket 8")
    .closest("button");
  await waitFor(() => expect(other?.disabled).toBe(true));
  expect(within(scan).getByTestId("teaser-bounty").textContent).toMatch(
    /ACME-7/,
  );
});

test("a board whose fitting tickets are all sized says so, not that nothing fits", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  // Every ticket that fit is proposed, so the scan fell back to the oldest
  // that fit nothing.
  world.scan = {
    ...preview(),
    issues: [{ ...ticket(20, leftBehind), categories: [] }],
    skippedLive: 3,
    fallback: true,
  };
  show();

  const scan = await screen.findByTestId("backlog-scan");
  expect(
    await within(scan).findByRole("heading", {
      name: /every ticket that fits is sized/i,
    }),
  ).toBeDefined();
  expect(scan.textContent).toMatch(
    /3 of 43 open tickets fit a pattern teams outsource, and all of them are sized\. The oldest of the rest are below/,
  );
  expect(scan.textContent).not.toMatch(/matched the six patterns/);
  expect(within(scan).queryByTestId("scan-categories")).toBeNull();
});

test("a server without GitHub still opens on the board, and says nothing about GitHub", async () => {
  // Its repository list answers 503. A failed read is read again whenever a
  // component asking for it mounts, which used to put home back to loading,
  // unmount the board, and mount it again, for as long as it kept failing.
  world.jira = [jiraSite];
  world.boards = [board];
  world.github = null;
  show();

  const teaser = await screen.findByTestId("teaser-bounty");
  expect(teaser.textContent).toMatch(/Generated from the ticket/);
  expect(teaser.textContent).not.toMatch(/GitHub/);
  expect(screen.getByTestId("setup-checklist").textContent).toMatch(/1 of 2/);
  expect(screen.queryByText(/could not be read/i)).toBeNull();
  const reads = requests.filter(({ url }) =>
    url.endsWith("/github/repositories"),
  ).length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(
    requests.filter(({ url }) => url.endsWith("/github/repositories")).length,
  ).toBeLessThanOrEqual(reads + 1);
});

test("a member reads the scan but is not offered sizing", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  show("member");
  const teaser = await screen.findByTestId("teaser-bounty");
  expect(within(teaser).queryByRole("button", { name: /size/i })).toBeNull();
  expect(teaser.textContent).toMatch(/owner or admin/i);
});

/* -------------------------------------------------------------------------- */
/* GitHub                                                                     */
/* -------------------------------------------------------------------------- */

test("a linked GitHub account offers its repositories in place, and one click maps it", async () => {
  world.github = [githubAccount];
  world.installationRepositories = [
    {
      externalId: "1296269",
      fullName: "acme/widgets",
      defaultBranch: "main",
      isPrivate: true,
      registeredId: null,
    },
  ];
  show();

  const picker = await screen.findByTestId("repo-picker");
  await userEvent.click(
    await within(picker).findByRole("button", { name: "Use acme/widgets" }),
  );
  expect(
    requests.find(
      ({ method, url }) =>
        method === "POST" &&
        url.endsWith("/github/connections/ghc_1/repositories"),
    )?.body,
  ).toEqual({ externalId: "1296269", role: "source" });

  const xray = await screen.findByTestId("repo-xray");
  expect(within(xray).getByText("acme/widgets")).toBeTruthy();
  expect(screen.queryByTestId("repo-picker")).toBeNull();
});

test("the x-ray says where a first bounty fits, and writing one starts there", async () => {
  world.github = [githubAccount];
  world.repositories = [widgets];
  const { onWriteBounty } = show();

  const xray = await screen.findByTestId("repo-xray");
  const facts = await within(xray).findByTestId("repo-facts");
  expect(facts.textContent).toMatch(/240/);
  expect(facts.textContent).toMatch(/20%/);
  expect(facts.textContent).toMatch(/Migrations · CI/);

  const fits = within(xray).getByTestId("fit-modules");
  // Tested and contained first; the root and the docs are never offered.
  expect(
    within(fits)
      .getAllByRole("listitem")
      .map((item) => item.querySelector(".font-mono")?.textContent),
  ).toEqual(["packages/billing", "apps/web"]);
  await userEvent.click(
    within(fits).getByRole("button", {
      name: "Write a bounty in packages/billing",
    }),
  );
  expect(onWriteBounty).toHaveBeenCalledWith({
    area: "packages/billing",
    repository: "acme/widgets",
  });

  // Writing comes first here, Jira after it, with what it would find.
  const paths = screen.getByTestId("path-cards");
  expect(
    within(paths)
      .getAllByRole("listitem")
      .map((item) => item.getAttribute("data-path")),
  ).toEqual(["write", "jira"]);
  expect(screen.getByTestId("category-showcase")).toBeTruthy();
});

/* -------------------------------------------------------------------------- */
/* Both                                                                       */
/* -------------------------------------------------------------------------- */

test("with both, the board's tickets may touch the workspace's repository, with nothing to link", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  world.github = [githubAccount];
  world.repositories = [widgets];
  show();

  const teaser = await screen.findByTestId("teaser-bounty");
  await waitFor(() =>
    expect(teaser.textContent).toMatch(
      /Cut from acme\/widgets, if its work touches it/,
    ),
  );
  expect(teaser.textContent).not.toMatch(/link a repository/);
  expect(screen.queryByTestId("board-repository")).toBeNull();
});

/* -------------------------------------------------------------------------- */
/* The checklist                                                              */
/* -------------------------------------------------------------------------- */

test("the checklist can be hidden, and stays hidden for this workspace", async () => {
  world.github = [githubAccount];
  world.repositories = [widgets];
  const first = show();
  const checklist = await screen.findByTestId("setup-checklist");
  await userEvent.click(
    within(checklist).getByRole("button", { name: "Hide" }),
  );
  expect(screen.queryByTestId("setup-checklist")).toBeNull();
  first.unmount();

  show();
  await screen.findByTestId("repo-xray");
  expect(screen.queryByTestId("setup-checklist")).toBeNull();
});

test("a workspace with every step done has no checklist", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  world.github = [githubAccount];
  world.repositories = [widgets];
  world.proposals = 2;
  show();
  await screen.findByTestId("backlog-scan");
  expect(screen.queryByTestId("setup-checklist")).toBeNull();
});

/* -------------------------------------------------------------------------- */

test("the greeting goes by the clock and the first name", () => {
  expect(greeting(new Date(2026, 0, 1, 9))).toBe("Good morning");
  expect(greeting(new Date(2026, 0, 1, 13))).toBe("Good afternoon");
  expect(greeting(new Date(2026, 0, 1, 20))).toBe("Good evening");
  expect(firstName("  Ada Example ")).toBe("Ada");
  expect(firstName("   ")).toBeUndefined();
});
