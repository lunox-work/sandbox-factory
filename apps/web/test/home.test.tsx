/**
 * Home and onboarding: two pages that change with what a workspace has
 * connected. Home says where setup stands and points at onboarding, which
 * has the rest: the ways in, the checklist, a repository's x-ray and, once
 * Jira is connected, the board's backlog scan.
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
import { Onboarding } from "../src/Onboarding";

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
    onOpenSettings: vi.fn(),
    onWriteBounty: vi.fn(),
  };
  const view = render(
    <Home name="Ada Example" organization={{ ...owner, role }} {...handlers} />,
  );
  return { ...view, ...handlers };
}

function showOnboarding(role: "owner" | "member" = "owner") {
  const handlers = {
    onOpenSettings: vi.fn(),
    onOpenRepository: vi.fn(),
    onWriteBounty: vi.fn(),
    onOpenBounties: vi.fn(),
  };
  const view = render(
    <Onboarding
      userId="user_1"
      organization={{ ...owner, role }}
      {...handlers}
    />,
  );
  return { ...view, ...handlers };
}

/* -------------------------------------------------------------------------- */
/* Nothing connected                                                          */
/* -------------------------------------------------------------------------- */

test("home does not point back to onboarding, and offers writing a bounty", async () => {
  // Home is offered once setup is done: onboarding is not offered beside it.
  const { onWriteBounty } = show();
  await screen.findByTestId("home-promise");
  expect(screen.queryByRole("button", { name: /onboarding/i })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: /write a bounty/i }),
  );
  expect(onWriteBounty).toHaveBeenCalledWith();
  // The ways in are onboarding's, not home's.
  expect(screen.queryByTestId("path-cards")).toBeNull();
  expect(screen.queryByTestId("category-showcase")).toBeNull();
  expect(screen.queryByTestId("setup-checklist")).toBeNull();
});

test("with nothing connected, onboarding offers three ways in, Jira first", async () => {
  showOnboarding();

  const paths = await screen.findByTestId("path-cards");
  expect(
    within(paths)
      .getAllByRole("listitem")
      .map((item) => item.getAttribute("data-path")),
  ).toEqual(["jira", "github", "write"]);
  expect(
    within(paths).getByRole("button", { name: /connect jira/i }),
  ).toBeTruthy();
  // One word on each button; the card's mark says which tool it is.
  expect(
    within(paths)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Connect", "Connect", "Manual"]);
  // What a tool reads is said before anyone is asked to connect it.
  expect(within(paths).getAllByText("Read-only")).toHaveLength(2);
  // Each card is named for a screen reader, which cannot see the mark.
  expect(
    within(paths).getByRole("listitem", { name: "Find work in Jira" }),
  ).toBeTruthy();
  expect(screen.getByTestId("onboarding-promise").textContent).toBe(
    "Integrate your projects and start tapping into the Lunox network",
  );

  // The six kinds of work are a click away, not a section of the page.
  expect(screen.queryByTestId("category-showcase")).toBeNull();

  // Getting started is never hidden, not even before the first step.
  const checklist = screen.getByTestId("setup-checklist");
  expect(checklist.textContent).toMatch(/0 of 3/);
  expect(
    checklist.querySelector("[aria-current='step']")?.getAttribute("data-step"),
  ).toBe("jira");
});

test("writing a bounty needs nothing connected", async () => {
  const { onWriteBounty } = showOnboarding();
  const paths = await screen.findByTestId("path-cards");
  await userEvent.click(
    within(paths).getByRole("button", { name: /write a bounty/i }),
  );
  // A bounty names no repository, so none is carried to the form.
  expect(onWriteBounty).toHaveBeenCalledWith();
});

test("a whole card is pressable, and a press fires once wherever it lands", async () => {
  const { onWriteBounty } = showOnboarding();
  const paths = await screen.findByTestId("path-cards");
  const card = within(paths).getByRole("listitem", {
    name: "Start from a task",
  });
  // Off the button: on the card itself.
  await userEvent.click(card);
  expect(onWriteBounty).toHaveBeenCalledTimes(1);
  // On the button: its click reaches the card, and is not handled twice.
  await userEvent.click(
    within(card).getByRole("button", { name: /write a bounty/i }),
  );
  expect(onWriteBounty).toHaveBeenCalledTimes(2);
});

test("a card a member may not act on does nothing when pressed", async () => {
  showOnboarding("member");
  const paths = await screen.findByTestId("path-cards");
  const card = within(paths).getByRole("listitem", {
    name: "Find work in Jira",
  });
  await userEvent.click(card);
  expect(window.location.pathname).toBe("/");
});

test("bounties written and none sized point at sizing them once there is code to size beside", async () => {
  world.bounties = 1;
  world.github = [githubAccount];
  world.repositories = [widgets];
  const { onOpenBounties } = showOnboarding();
  const paths = await screen.findByTestId("path-cards");
  await userEvent.click(
    within(paths).getByRole("button", { name: /open bounties/i }),
  );
  expect(onOpenBounties).toHaveBeenCalled();
  expect(
    within(paths).queryByRole("button", { name: /write a bounty/i }),
  ).toBeNull();
});

test("bounties written with no GitHub yet are not offered for sizing", async () => {
  world.bounties = 1;
  showOnboarding();
  const paths = await screen.findByTestId("path-cards");
  expect(
    within(paths).queryByRole("button", { name: /open bounties/i }),
  ).toBeNull();
  expect(
    within(paths).getByRole("button", { name: /write a bounty/i }),
  ).toBeTruthy();
});

test("a member is told who can connect, not shown buttons that would be refused", async () => {
  showOnboarding("member");
  const paths = await screen.findByTestId("path-cards");
  expect(within(paths).queryByRole("button", { name: /connect/i })).toBeNull();
  expect(within(paths).getAllByText(/owner or admin/i)).toHaveLength(2);
  // Writing a bounty is still theirs to do.
  expect(
    within(paths).getByRole("button", { name: /write a bounty/i }),
  ).toBeTruthy();
});

test("a server without Jira leaves Jira out of onboarding, not as a failure", async () => {
  world.jira = null;
  showOnboarding();
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

test("a consent started on onboarding is reported there", async () => {
  // Its `returnTo` is the page it started from.
  window.history.replaceState(null, "", "/onboarding?jira=cancelled");
  showOnboarding();
  expect((await screen.findByTestId("jira-outcome")).textContent).toMatch(
    /cancelled/i,
  );
  expect(window.location.pathname + window.location.search).toBe("/onboarding");
  window.history.replaceState(null, "", "/");
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

test("with Jira connected, home's line does not send anyone to onboarding", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  show();

  const promise = await screen.findByTestId("home-promise");
  expect(promise.textContent).toMatch(/bounties already/);
  expect(promise.textContent).not.toMatch(/onboarding/);
  expect(screen.queryByTestId("backlog-scan")).toBeNull();
  expect(screen.queryByRole("button", { name: /switch board/i })).toBeNull();
});

test("with Jira connected, onboarding shows the board's backlog scan under getting started, sizing nothing", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  showOnboarding();

  const scan = await screen.findByTestId("backlog-scan");
  expect(
    await within(scan).findByRole("heading", {
      name: /3 tickets worth outsourcing/,
    }),
  ).toBeTruthy();
  // Of how many, on the headline's own line rather than said again below.
  expect(within(scan).getByText("of 43 open")).toBeTruthy();
  // The six, always: an empty one is shown, not pressable.
  const tiles = within(scan).getByTestId("scan-categories");
  expect(within(tiles).getAllByRole("button")).toHaveLength(6);
  expect(
    within(tiles).getByRole("button", { name: "Holding others up, 0 tickets" }),
  ).toHaveProperty("disabled", true);

  // The ticket in focus, as the bounty it would become: the range from the
  // rate card in force. No size or spec placeholders: sizing writes those.
  const teaser = await within(scan).findByTestId("teaser-bounty");
  expect(teaser.textContent).toMatch(/ACME-7/);
  expect(await within(teaser).findByText(/\$58.\$153/)).toBeTruthy();
  const facts = within(teaser).getByTestId("teaser-facts");
  expect(within(facts).queryByText("Size")).toBeNull();
  expect(within(facts).queryByText("Spec")).toBeNull();
  expect(
    within(teaser).getByRole("button", { name: "Size ACME-7" }),
  ).toBeTruthy();

  // Under getting started, which comes first on the page.
  const checklist = screen.getByTestId("setup-checklist");
  expect(
    checklist.compareDocumentPosition(scan) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  // Looking is free: nothing asked for sizing.
  expect(requests.filter(({ method }) => method === "POST")).toEqual([]);
});

test("a category shows its own tickets, and the teaser follows the one chosen", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  showOnboarding();

  const scan = await screen.findByTestId("backlog-scan");
  await userEvent.click(
    await within(scan).findByRole("button", { name: "Paper cuts, 1 ticket" }),
  );
  const list = within(scan).getByTestId("scan-candidates");
  expect(within(list).getAllByRole("button")).toHaveLength(1);
  expect(within(list).getByText("Ticket 9")).toBeTruthy();
  // Why it pays, not its name again: the pressed tile says that.
  expect(within(scan).getByTestId("scan-why").textContent).toMatch(
    /^Small, self-contained bugs/,
  );
  expect(within(scan).getByTestId("teaser-bounty").textContent).toMatch(
    /ACME-9/,
  );
});

test("a reason every ticket in a category shares is said once, not on each row", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  world.scan = {
    ...preview(),
    issues: [7, 8].map((n) => ({
      ...ticket(n, leftBehind),
      categories: [{ ...leftBehind, reason: "Carried over 3 sprints" }],
    })),
  };
  showOnboarding();

  const scan = await screen.findByTestId("backlog-scan");
  expect((await within(scan).findByTestId("scan-why")).textContent).toMatch(
    /All carried over 3 sprints\.$/,
  );
  expect(
    within(within(scan).getByTestId("scan-candidates")).queryByText(
      "Carried over 3 sprints",
    ),
  ).toBeNull();
  expect(within(scan).getByTestId("teaser-bounty").textContent).not.toMatch(
    /Carried over/,
  );
});

test("sizing from the scan is one call for that ticket, and opens its proposal", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  // Sized beside the code: a workspace without it is asked to add it.
  world.github = [githubAccount];
  world.repositories = [widgets];
  showOnboarding();

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
  // Sized beside the code: a workspace without it is asked to add it.
  world.github = [githubAccount];
  world.repositories = [widgets];
  showOnboarding();

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
  showOnboarding();

  const scan = await screen.findByTestId("backlog-scan");
  expect(
    await within(scan).findByRole("heading", {
      name: /every ticket that fits is sized/i,
    }),
  ).toBeDefined();
  expect(scan.textContent).toMatch(/3 of 43 open\. Oldest of the rest below/);
  expect(scan.textContent).not.toMatch(/matched the six patterns/);
  expect(within(scan).queryByTestId("scan-categories")).toBeNull();
});

test("a server without GitHub still shows the board, sizes from the ticket, and says nothing about GitHub", async () => {
  // Its repository list answers 503. A failed read is read again whenever a
  // component asking for it mounts, which used to put home back to loading,
  // unmount the board, and mount it again, for as long as it kept failing.
  world.jira = [jiraSite];
  world.boards = [board];
  world.github = null;
  showOnboarding();

  const teaser = await screen.findByTestId("teaser-bounty");
  expect(teaser.textContent).toMatch(/From the ticket/);
  expect(teaser.textContent).not.toMatch(/GitHub/);
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
  showOnboarding("member");
  const teaser = await screen.findByTestId("teaser-bounty");
  expect(within(teaser).queryByRole("button", { name: /size/i })).toBeNull();
  expect(teaser.textContent).toMatch(/owner or admin/i);
});

test("sizing with no repository asks for GitHub first, and sizes nothing", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  showOnboarding();

  const teaser = await screen.findByTestId("teaser-bounty");
  expect(teaser.textContent).toMatch(/Needs GitHub connected first/);
  await userEvent.click(
    await within(teaser).findByRole("button", { name: "Size ACME-7" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Connect GitHub to size ACME-7",
  });
  expect(
    within(dialog).getByRole("button", { name: "Connect GitHub" }),
  ).toBeTruthy();
  expect(requests.filter(({ method }) => method === "POST")).toEqual([]);

  await userEvent.click(
    within(dialog).getByRole("button", { name: "Not now" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("the board bar names the board under Jira's mark, and holds the board-wide actions in its menu", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  world.github = [githubAccount];
  world.repositories = [widgets];
  showOnboarding();

  const bar = await screen.findByTestId("board-bar");
  expect(
    within(bar).getByRole("button", { name: "Switch board — Mobile" }),
  ).toBeTruthy();
  // Jira's mark says where the board is from; there is no way out to it.
  expect(within(bar).queryByRole("link")).toBeNull();

  // Not on the scan itself any more: sizing all and scanning again are the
  // board's, in its menu.
  const scan = await screen.findByTestId("backlog-scan");
  await within(scan).findByTestId("scan-categories");
  expect(within(scan).queryByRole("button", { name: /size all/i })).toBeNull();
  expect(
    within(scan).queryByRole("button", { name: /scan again/i }),
  ).toBeNull();

  await userEvent.click(
    within(bar).getByRole("button", { name: "Board actions" }),
  );
  const reads = requests.filter(({ url }) =>
    url.endsWith("/backlog-preview"),
  ).length;
  expect(
    screen.queryByRole("menuitem", { name: /open its bounties/i }),
  ).toBeNull();
  await userEvent.click(
    await screen.findByRole("menuitem", { name: /scan again/i }),
  );
  await waitFor(() =>
    expect(
      requests.filter(({ url }) => url.endsWith("/backlog-preview")).length,
    ).toBe(reads + 1),
  );

  await userEvent.click(
    within(bar).getByRole("button", { name: "Board actions" }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: /size all 3 tickets/i }),
  );
  // What it costs is said before anything starts.
  expect(
    await screen.findByRole("alertdialog", { name: "Size 3 tickets?" }),
  ).toBeTruthy();
  expect(requests.filter(({ method }) => method === "POST")).toEqual([]);
});

test("sizing the whole board waits for GitHub, as sizing one ticket does", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  showOnboarding();

  const bar = await screen.findByTestId("board-bar");
  // The scan's count is in before the menu is read.
  await screen.findByTestId("scan-categories");
  await userEvent.click(
    within(bar).getByRole("button", { name: "Board actions" }),
  );
  const sizeAll = await screen.findByRole("menuitem", {
    name: /size all 3 tickets/i,
  });
  expect(sizeAll.getAttribute("aria-disabled")).toBe("true");
  expect(sizeAll.textContent).toMatch(/Needs GitHub connected first/);
  await userEvent.click(sizeAll);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(requests.filter(({ method }) => method === "POST")).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* GitHub                                                                     */
/* -------------------------------------------------------------------------- */

test("a linked GitHub account opens its repositories dialog in place, and registering one maps it", async () => {
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
  showOnboarding();

  const picker = await screen.findByTestId("repo-picker");
  await userEvent.click(
    await within(picker).findByRole("button", { name: "Manage repositories" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: `Repositories on ${githubAccount.accountLogin}`,
  });
  await userEvent.click(
    await within(dialog).findByRole("button", {
      name: "Register acme/widgets",
    }),
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
  // The dialog outlives the step it was opened from, until Done.
  await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("the x-ray says where a first bounty fits, and writing one starts there", async () => {
  world.github = [githubAccount];
  world.repositories = [widgets];
  const { onWriteBounty } = showOnboarding();

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
});

test("the six kinds of work open in a dialog from the heading, at every stage", async () => {
  for (const connected of [false, true]) {
    world.jira = connected ? [jiraSite] : [];
    world.boards = connected ? [board] : [];
    const view = showOnboarding();

    const heading = await screen.findByRole("heading", {
      name: "Onboarding",
      level: 1,
    });
    // At the far end of the heading's own row: the page header's actions.
    const open = within(heading.closest("header") as HTMLElement).getByRole(
      "button",
      { name: "What task do teams outsource?" },
    );
    await userEvent.click(open);

    const dialog = await screen.findByRole("dialog", {
      name: "What task do teams outsource?",
    });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(6);
    expect(within(dialog).getByText("Left behind")).toBeTruthy();
    expect(dialog.textContent).toMatch(
      connected ? /below/ : /typically outsource/,
    );

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.unmount();
  }
});

/* -------------------------------------------------------------------------- */
/* Both                                                                       */
/* -------------------------------------------------------------------------- */

test("with both, the board's tickets may touch the workspace's repository, with nothing to link", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  world.github = [githubAccount];
  world.repositories = [widgets];
  showOnboarding();

  const teaser = await screen.findByTestId("teaser-bounty");
  await waitFor(() =>
    expect(
      within(within(teaser).getByTestId("teaser-facts")).getByText(
        "acme/widgets",
      ),
    ).toBeTruthy(),
  );
  expect(teaser.textContent).not.toMatch(/link a repository/);
  expect(screen.queryByTestId("board-repository")).toBeNull();
});

/* -------------------------------------------------------------------------- */
/* The checklist                                                              */
/* -------------------------------------------------------------------------- */

test("with Jira connected, onboarding's checklist has moved on to GitHub, with the scan under it", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  showOnboarding();

  const checklist = await screen.findByTestId("setup-checklist");
  expect(
    checklist.querySelector("[aria-current='step']")?.getAttribute("data-step"),
  ).toBe("github");
  expect(checklist.textContent).toMatch(/1 of 3/);
  expect(await screen.findByTestId("backlog-scan")).toBeTruthy();
  expect(
    within(screen.getByTestId("onboarding-promise")).getByRole("button", {
      name: "under getting started",
    }),
  ).toBeTruthy();
});

test("a server without GitHub counts two steps, not three", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  world.github = null;
  showOnboarding();
  expect((await screen.findByTestId("setup-checklist")).textContent).toMatch(
    /1 of 2/,
  );
  expect(screen.queryByText(/could not be read/i)).toBeNull();
});

test("with every step done, onboarding says so and keeps the steps ticked off", async () => {
  world.jira = [jiraSite];
  world.boards = [board];
  world.github = [githubAccount];
  world.repositories = [widgets];
  world.proposals = 2;
  showOnboarding();
  const checklist = await screen.findByTestId("setup-checklist");
  expect(checklist.textContent).toMatch(/3 of 3/);
  expect(checklist.querySelector("[aria-current='step']")).toBeNull();
  expect(screen.getByTestId("onboarding-promise").textContent).toMatch(
    /set up/,
  );
});

/* -------------------------------------------------------------------------- */

test("the greeting goes by the clock and the first name", () => {
  expect(greeting(new Date(2026, 0, 1, 9))).toBe("Good morning");
  expect(greeting(new Date(2026, 0, 1, 13))).toBe("Good afternoon");
  expect(greeting(new Date(2026, 0, 1, 20))).toBe("Good evening");
  expect(firstName("  Ada Example ")).toBe("Ada");
  expect(firstName("   ")).toBeUndefined();
});
