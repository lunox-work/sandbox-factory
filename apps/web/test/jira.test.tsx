import { completeBountyFixture } from "./api-fixtures";
/**
 * The Jira connections list, which is the Jira tab of an organization's
 * settings, and the board page under it. A site has no page of its own.
 *
 * Three properties. That the connect button is a *navigation* rather than a
 * fetch, because the browser has to reach Atlassian's consent screen. That the
 * outcome the callback appended is explained and then removed from the URL, so
 * a reload does not re-announce it. And that a plain member sees no control
 * the API would refuse.
 *
 * The server is faked at the `fetch` boundary, as elsewhere in this suite.
 */

import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "./render";

import { fromToday } from "../src/IssueSpec";
import { resolveCategories } from "sandbox-factory";
import { JiraConnections } from "../src/Jira";
import { BoardScan } from "../src/features/onboarding/BoardScan";

const connection = {
  id: "jrc_1",
  cloudId: "cloud-1",
  siteUrl: "https://acme.atlassian.net",
  siteName: "Acme",
  email: "dana@example.test",
  healthy: true,
  scopes: ["read:jira-work"],
  resourceScopes: ["read:jira-work"],
  writeGranted: false,
  createdAt: "2026-09-21T00:00:00.000Z",
};

/** The real `window.location`, restored after each test. */
let assigned: string[] = [];
let replaced: string[] = [];

beforeEach(() => {
  assigned = [];
  replaced = [];

  // jsdom refuses assignment to window.location, so it is replaced with a
  // recorder. `href` is what `connect` sets.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/o/acme/settings",
      search: "",
      get href() {
        return "http://localhost/o/acme/settings?connection=jira";
      },
      set href(value: string) {
        assigned.push(value);
      },
    },
  });

  vi.spyOn(window.history, "replaceState").mockImplementation(
    (_state, _title, url) => {
      replaced.push(String(url));
    },
  );

  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ connections: [connection] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The sites and their boards. `opened` records which board a row opened. */
let opened: string[] = [];

function renderPage(role = "owner") {
  opened = [];
  return render(
    <JiraConnections
      organizationId="org_1"
      organizationSlug="acme"
      role={role}
      onOpenBoard={(board) => opened.push(board.id)}
    />,
  );
}

/**
 * Opens a site's options menu. From the keyboard, as the app's other menu
 * tests do: Radix opens on pointerdown, which jsdom's click does not send.
 */
async function openSiteMenu(siteName = "Acme") {
  const trigger = await screen.findByRole("button", {
    name: `${siteName} options`,
  });
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  return screen.findByRole("menu");
}

test("connected sites are listed", async () => {
  renderPage();

  expect(await screen.findByText("Acme")).toBeDefined();
  expect(screen.getByText("https://acme.atlassian.net")).toBeDefined();
});

test("connect navigates to the API rather than fetching it", async () => {
  // An XHR would follow the redirect to Atlassian's consent screen and fail
  // CORS — and the person needs to see that screen to grant anything.
  renderPage();
  await screen.findByText("Acme");

  await userEvent.click(screen.getByRole("button", { name: /^connect/i }));

  expect(assigned).toHaveLength(1);
  expect(assigned[0]).toContain("/api/v1/orgs/org_1/jira/connect");
  // And it says where to come back to.
  expect(assigned[0]).toContain("returnTo=");
});

test("connecting sits outside the card, not as a row in the list", async () => {
  // Inside the card it read as one more site under the last one. It is an
  // action on the list, so it trails the card rather than joining it.
  const { container } = renderPage();
  await screen.findByText("Acme");

  const button = screen.getByRole("button", { name: /^connect/i });
  const card = container.querySelector('[data-slot="card"]');
  expect(card).not.toBeNull();
  expect(card?.contains(button)).toBe(false);
  // And to the right, which is the corner the eye finishes a list in.
  expect(button.parentElement?.className).toContain("justify-end");
});

test("a plain member gets no connect control", async () => {
  // Courtesy, not security: the API checks the role again on every write.
  renderPage("member");

  expect(await screen.findByText("Acme")).toBeDefined();
  expect(screen.queryByRole("button", { name: /^connect/i })).toBeNull();
  expect(screen.getByText(/only an owner or admin/i)).toBeDefined();
});

test("each site's boards are listed on the page, and open from it", async () => {
  // The boards are what a person comes here for; a list of sites made every
  // board a trip through a page that showed little else.
  vi.stubGlobal(
    "fetch",
    routedFetch({
      connections: {
        body: {
          connections: [
            connection,
            { ...connection, id: "jrc_2", siteName: "Beta" },
          ],
        },
      },
      boards: {
        body: {
          boards: [
            board,
            { ...board, id: "jrb_2", connectionId: "jrc_2", name: "Beta Ops" },
          ],
        },
      },
    }),
  );
  const { container } = renderPage();

  const acme = await screen.findByText("Acme Board");
  const beta = await screen.findByText("Beta Ops");
  // Each under its own site, not pooled.
  expect(acme.closest('[data-slot="card"]')?.textContent).toContain("Acme");
  expect(acme.closest('[data-slot="card"]')?.textContent).not.toContain(
    "Beta Ops",
  );
  expect(beta.closest('[data-slot="card"]')?.textContent).toContain("Beta");
  expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(2);

  await userEvent.click(screen.getByRole("link", { name: /beta ops/i }));
  expect(opened).toEqual(["jrb_2"]);
});

test("re-sync and disconnect sit in the site's menu, not on the page", async () => {
  // Buttons on every card read as the page's actions rather than the site's.
  vi.stubGlobal("fetch", routedFetch());
  renderPage();
  await screen.findByText("Acme Board");

  expect(screen.queryByRole("button", { name: /re-sync/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();

  const menu = await openSiteMenu();
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Re-sync", "Disconnect"]);
});

test("disconnecting from the Jira page asks first, then drops the site", async () => {
  let gone = false;
  const routes = routedFetch();
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      gone = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (gone && String(input).endsWith("/jira/connections")) {
      return Promise.resolve(
        new Response(JSON.stringify({ connections: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return routes(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderPage();
  await screen.findByText("Acme Board");

  const menu = await openSiteMenu();
  await userEvent.click(
    within(menu).getByRole("menuitem", { name: /disconnect/i }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/Disconnect acme\?/i)).toBeDefined();
  expect(gone).toBe(false);

  await userEvent.click(
    within(dialog).getByRole("button", { name: "Disconnect" }),
  );

  expect(await screen.findByText(/no sites connected/i)).toBeDefined();
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/jira/connections/jrc_1") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    ),
  ).toHaveLength(1);
});

test("a member can open a board, and may re-sync but not disconnect", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderPage("member");

  await userEvent.click(
    await screen.findByRole("link", { name: /acme board/i }),
  );
  expect(opened).toEqual(["jrb_1"]);

  const menu = await openSiteMenu();
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Re-sync"]);
});

test("an admin may manage connections", async () => {
  renderPage("admin");

  expect(
    await screen.findByRole("button", { name: /^connect/i }),
  ).toBeDefined();
});

test("a member holding several roles is judged by the strongest", async () => {
  renderPage("member,admin");

  expect(
    await screen.findByRole("button", { name: /^connect/i }),
  ).toBeDefined();
});

test("an unhealthy connection is flagged for reconnection", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ connections: [{ ...connection, healthy: false }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  );

  renderPage();

  expect(await screen.findByText("Reconnect")).toBeDefined();
});

test("reconnect is the same consent as connecting, and comes back here", async () => {
  // No per-connection parameter any more: every consent asks for the full
  // grant, and Atlassian records it against the site it names, so a second
  // consent to a connected site refreshes that connection.
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ connections: [{ ...connection, healthy: false }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  );
  renderList();
  await userEvent.click(
    await screen.findByRole("button", { name: "Reconnect" }),
  );
  expect(assigned[0]).toMatch(
    /^\/api\/v1\/orgs\/org_1\/jira\/connect\?returnTo=/,
  );
  expect(assigned[0]).not.toContain("connectionId=");
});

test("a site connected without the write grant is marked read-only", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            connections: [
              connection,
              {
                ...connection,
                id: "jrc_2",
                siteName: "Beta",
                siteUrl: "https://beta.atlassian.net",
                writeGranted: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  );
  renderPage();

  const badges = await screen.findAllByText("Read-only");
  // One site of the two: Acme holds no write grant, Beta does.
  expect(badges).toHaveLength(1);
  expect(badges[0]?.closest('[data-slot="card"]')?.textContent).toContain(
    "Acme",
  );
});

test("a failed load says so rather than rendering an empty list", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
  );

  renderPage();

  expect(await screen.findByText(/could not load/i)).toBeDefined();
});

test("a response of the wrong shape reports a controlled load error", async () => {
  // The existing suite stubs `fetch` loosely, and trusting a response shape
  // has crashed these tests before.
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );

  renderPage();

  expect(
    await screen.findByText(/could not load your Jira connections/i),
  ).toBeDefined();
});

/* The outcome banner: what the callback reports back. */

function withOutcome(search: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/o/acme/settings",
      search,
      get href() {
        return `http://localhost/o/acme/settings${search}`;
      },
      set href(value: string) {
        assigned.push(value);
      },
    },
  });
}

test("a successful connection is announced", async () => {
  withOutcome("?jira=connected");

  renderPage();

  expect(await screen.findByText(/jira connected/i)).toBeDefined();
});

test("the outcome is stripped from the URL, so a reload does not repeat it", async () => {
  withOutcome("?jira=connected");

  renderPage();
  await screen.findByText(/jira connected/i);

  expect(replaced).toHaveLength(1);
  expect(replaced[0]).not.toContain("jira=");
});

test("an outcome the callback never sends is cleared, not announced", async () => {
  // `?jira=foo` rendered an empty notice.
  withOutcome("?jira=foo");

  renderPage();

  await waitFor(() => expect(replaced).toHaveLength(1));
  expect(replaced[0]).not.toContain("jira=");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("status", { name: /jira/i })).toBeNull();
});

test("a cancelled consent is not presented as an error", async () => {
  // Pressing Cancel is a choice, not a fault.
  withOutcome("?jira=cancelled");

  renderPage();

  const banner = await screen.findByTestId("jira-outcome");
  expect(banner.className).toContain("amber");
  expect(screen.getByText(/nothing was changed/i)).toBeDefined();
});

test("missing granular scopes are named, with where to find them", async () => {
  // The trap this exists for: without these the agile endpoints answer 404,
  // which reads like "no such board" rather than "missing scope".
  withOutcome(
    "?jira=partial-scopes&missing=read%3Aboard-scope%3Ajira-software%2Cread%3Asprint%3Ajira-software",
  );

  renderPage();

  expect(
    await screen.findByText(/some permissions are missing/i),
  ).toBeDefined();
  expect(screen.getByText(/read:board-scope:jira-software/)).toBeDefined();
  expect(screen.getByText(/granular scopes/i)).toBeDefined();
});

test("a rejected state is reported without saying why", async () => {
  // Each reason would tell an attacker something about why their forgery
  // failed, so the page offers a remedy instead.
  withOutcome("?jira=state");

  renderPage();

  expect(await screen.findByText(/could not be verified/i)).toBeDefined();
});

test("the banner can be dismissed", async () => {
  withOutcome("?jira=connected");

  renderPage();
  await screen.findByText(/jira connected/i);

  await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));

  await waitFor(() => {
    expect(screen.queryByTestId("jira-outcome")).toBeNull();
  });
});

test("no banner is shown without an outcome in the URL", async () => {
  renderPage();
  await screen.findByText("Acme");

  expect(screen.queryByTestId("jira-outcome")).toBeNull();
  // And nothing was rewritten.
  expect(replaced).toHaveLength(0);
});

/* -------------------------------------------------------------------------- */
/* Boards and the proposals page                                              */
/* -------------------------------------------------------------------------- */

const board = {
  id: "jrb_1",
  connectionId: "jrc_1",
  externalId: "42",
  name: "Acme Board",
  boardType: "scrum",
  projectKey: "ACME",
  selection: { unassignedOnly: false, categories: {} },
  createdAt: "2026-09-21T00:00:00.000Z",
};

function issue(n: number, created: string) {
  return {
    id: String(1000 + n),
    key: `ACME-${n}`,
    summary: `Ticket ${n}`,
    status: "To Do",
    statusCategory: "new",
    assignee: null,
    issueType: "Task",
    created,
    updated: created,
    url: `https://acme.atlassian.net/browse/ACME-${n}`,
  };
}

/** A sizing proposal against `issue(n)`, as the list and detail routes return it. */
function proposal(n: number) {
  return {
    id: `bpr_${n}`,
    issueKey: `ACME-${n}`,
    modelRationale: "A few files.",
    complexity: "M",
    amountMinor: 200,
    currency: "USD",
    modelComplexity: "M",
    modelConfidence: "high",
    actualModel: "claude-sonnet-5",
    status: "proposed",
    revision: 1,
  };
}

/**
 * A board's backlog scan: three tickets, two of them left behind and one
 * paper cut, none sized yet.
 */
function scanPreview() {
  const resolved = resolveCategories();
  return {
    boardId: "jrb_1",
    jql: "project = ACME",
    categories: resolved,
    issues: [
      {
        ...issue(7, "2025-01-01T00:00:00.000Z"),
        priority: null,
        labels: [],
        projectKey: "ACME",
        parentKey: null,
        dueDate: null,
        categories: [
          {
            id: "left-behind",
            label: "Left behind",
            reason: "Open 600 days, never in a sprint, unassigned",
          },
        ],
      },
      {
        ...issue(8, "2025-03-01T00:00:00.000Z"),
        priority: null,
        labels: [],
        projectKey: "ACME",
        parentKey: null,
        dueDate: null,
        categories: [
          {
            id: "left-behind",
            label: "Left behind",
            reason: "Open 550 days, never in a sprint, unassigned",
          },
        ],
      },
      {
        ...issue(9, "2025-06-01T00:00:00.000Z"),
        priority: "Low",
        labels: [],
        projectKey: "ACME",
        parentKey: null,
        dueDate: null,
        categories: [
          {
            id: "paper-cuts",
            label: "Paper cuts",
            reason: "Low-priority bug, open 400 days",
          },
        ],
      },
    ],
    matched: { "left-behind": 2, "paper-cuts": 1 },
    unmatched: 40,
    candidatesScanned: 43,
    skippedLive: 0,
    scanLimitReached: false,
    ticketCapReached: false,
  };
}

/**
 * The server, faked per route rather than as one blanket response.
 *
 * The page makes several different calls, and answering them all with the
 * same body is how a test passes while the page is broken.
 */
function routedFetch(
  overrides: {
    boards?: { status?: number; body?: unknown };
    sync?: { status?: number; body?: unknown };
    connections?: { status?: number; body?: unknown };
    detail?: { status?: number; body?: unknown };
    proposals?: { status?: number; body?: unknown };
    preview?: { status?: number; body?: unknown };
  } = {},
) {
  return vi.fn((input: string, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(
          status === 204 ? null : JSON.stringify(completeBountyFixture(body)),
          {
            status,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    if (url.includes("/proposal-categories")) {
      // The board's counts: as many as the list holds.
      const listed = (
        overrides.proposals?.body as { proposals?: unknown[] } | undefined
      )?.proposals;
      return json({
        total: listed?.length ?? 2,
        uncategorized: listed?.length ?? 2,
        categories: [],
      });
    }
    if (url.includes("/backlog-preview")) {
      const spec = overrides.preview;
      return json(spec?.body ?? scanPreview(), spec?.status ?? 200);
    }
    if (url.endsWith("/rate-card")) {
      return json({ rateCard: null });
    }

    if (url.endsWith("/resize")) {
      // The resized proposal, as the route returns it: the size asked for,
      // priced, one revision on.
      const n = Number(/bpr_(\d+)/.exec(url)?.[1] ?? "1");
      const { complexity } = JSON.parse(String(init?.body)) as {
        complexity: string;
      };
      return json({
        proposal: { ...proposal(n), complexity, amountMinor: 300, revision: 2 },
      });
    }

    if (url.includes("/issues/")) {
      const spec = overrides.detail;
      return json(
        spec?.body ?? {
          issue: {
            ...issue(1, "2020-01-01T00:00:00.000Z"),
            descriptionText:
              "## Objective\nEstablish the canonical data model.\n\n## Scope\n- Canonical entities\n- Multi-tenant isolation",
            reporter: "ada lovelace",
            creator: "ada lovelace",
            resolution: null,
            resolutionDate: null,
            labels: ["foundation", "platform"],
            priority: "Highest",
            parentKey: null,
            projectKey: "NOX",
            dueDate: "2026-12-19",
            components: [],
            fixVersions: [],
            originalEstimateSeconds: null,
            remainingEstimateSeconds: null,
            votes: 0,
            watchers: 1,
            environment: null,
          },
        },
        spec?.status ?? 200,
      );
    }
    if (url.includes("/runs")) {
      return json({ runs: [], sizingAvailable: true });
    }
    if (url.includes("/proposals/")) {
      const n = Number(/bpr_(\d+)/.exec(url)?.[1] ?? "1");
      return json({
        proposal: proposal(n),
        freshness: {
          freshness: "current",
          checkedAt: "now",
          liveKey: `ACME-${n}`,
          liveTitle: `Ticket ${n}`,
          liveUrl: `https://acme.atlassian.net/browse/ACME-${n}`,
        },
        writebackOperations: [],
      });
    }
    if (url.includes("/proposals?")) {
      const spec = overrides.proposals;
      return json(
        spec?.body ?? { proposals: [proposal(1), proposal(2)] },
        spec?.status ?? 200,
      );
    }
    if (url.endsWith("/sync")) {
      const spec = overrides.sync;
      return json(spec?.body ?? { boards: [board] }, spec?.status ?? 200);
    }
    if (url.endsWith("/jira/boards")) {
      const spec = overrides.boards;
      return json(spec?.body ?? { boards: [board] }, spec?.status ?? 200);
    }
    const spec = overrides.connections;
    return json(
      spec?.body ?? { connections: [connection] },
      spec?.status ?? 200,
    );
  });
}

/** The boards a row in the Jira list opened. */
let openedBoards: string[] = [];

/** A board as home shows it: its scan, and the way to its bounties. */
/** A board's scan, as onboarding shows it: the workspace's first board. */
function renderBoard(role?: string) {
  return render(
    <BoardScan
      userId="user_1"
      organizationId="org_1"
      organizationSlug="acme"
      canManage={role === "owner" || role === "admin"}
      githubAvailable
      fallback={<p>No board yet</p>}
    />,
  );
}

/** The Jira list with the routed server: every site's boards, and the menus. */
function renderList(role = "owner") {
  openedBoards = [];
  return render(
    <JiraConnections
      organizationId="org_1"
      organizationSlug="acme"
      role={role}
      onOpenBoard={(opened) => openedBoards.push(opened.id)}
    />,
  );
}

test("a registered board is listed without type or project pills", async () => {
  vi.stubGlobal("fetch", routedFetch());

  renderList();

  expect(await screen.findByText("Acme Board")).toBeDefined();
  const row = screen.getByRole("link", { name: /acme board/i });
  expect(within(row).queryByText("scrum")).toBeNull();
  expect(within(row).queryByText("ACME")).toBeNull();
});

test("Re-sync re-reads the site and says what it found", async () => {
  // Opening the page syncs already; the button is for a board made in Jira
  // a moment ago, and the card says what it found.
  const fetchMock = routedFetch({
    sync: { body: { boards: [board], added: [] } },
  });
  vi.stubGlobal("fetch", fetchMock);
  renderList();
  await screen.findByText("Acme Board");
  const syncs = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sync"))
      .length;
  await waitFor(() => expect(syncs()).toBe(1));
  expect(screen.queryByRole("status")).toBeNull();

  fetchMock.mockImplementation(
    routedFetch({
      sync: { body: { boards: [board], added: ["jrb_2", "jrb_3"] } },
    }).getMockImplementation()!,
  );
  const menu = await openSiteMenu();
  await userEvent.click(
    within(menu).getByRole("menuitem", { name: /re-sync/i }),
  );

  await waitFor(() => expect(syncs()).toBe(2));
  // Found, not sized: connecting or syncing a site sizes nothing.
  expect((await screen.findByRole("status")).textContent).toBe(
    "Found 2 new boards.",
  );
});

test("a board row opens the board rather than previewing it in place", async () => {
  // The row used to carry a "Preview" button, which named the mechanism
  // rather than the destination. The whole row is the target now.
  vi.stubGlobal("fetch", routedFetch());
  renderList();
  await screen.findByText("Acme Board");

  expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
  // A board has no page of its own: it opens as its bounties.
  expect(
    screen.getByRole("link", { name: /acme board/i }).getAttribute("href"),
  ).toBe("/bounties?board=acme/jrb_1");

  await userEvent.click(screen.getByRole("link", { name: /acme board/i }));

  expect(openedBoards).toEqual(["jrb_1"]);
});

test("a board's scan is the tickets alone, with no way out to its bounties", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("board-bar");
  expect(
    screen.queryByRole("link", { name: /this board’s bounties/ }),
  ).toBeNull();
  expect(screen.queryByText(/bounties already/)).toBeNull();
  expect(screen.queryByTestId("proposal-list")).toBeNull();
});

test("a board carries the mark of the kind of board it is", async () => {
  // Kanban and Scrum differ in a way that matters here — a Kanban board has
  // no backlog of its own — so they are not drawn alike.
  vi.stubGlobal(
    "fetch",
    routedFetch({
      boards: {
        body: {
          boards: [
            board,
            {
              ...board,
              id: "jrb_2",
              externalId: "43",
              name: "Flow",
              boardType: "kanban",
            },
          ],
        },
      },
    }),
  );
  renderList();
  await screen.findByText("Acme Board");

  const scrum = screen
    .getByRole("link", { name: /acme board/i })
    .querySelector("svg");
  const kanban = screen
    .getByRole("link", { name: /flow/i })
    .querySelector("svg");

  expect(scrum).not.toBeNull();
  expect(kanban).not.toBeNull();
  // Different marks, not the same one twice.
  expect(scrum?.innerHTML).not.toBe(kanban?.innerHTML);
});

test("opening the list re-reads each site's boards, so one made since shows up", async () => {
  // A client creates a board in Jira and nothing tells us. Nobody is asked
  // to press anything: the list is refreshed where somebody is looking at it.
  const fetchMock = routedFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderList();
  await screen.findByText("Acme Board");

  await waitFor(() => {
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith("/connections/jrc_1/sync") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);
  });
});

test("there is no way to add a board, because there is nothing to add", async () => {
  // Connecting the site is the decision. Asking again, board by board, was
  // asking the person to repeat a choice they had already made.
  vi.stubGlobal("fetch", routedFetch());
  renderList();
  await screen.findByText("Acme Board");

  expect(screen.queryByRole("button", { name: /add a board/i })).toBeNull();
});

test("a dead connection is not re-read, because the sync would fail too", async () => {
  // The reconnect notice is already on screen; a failed sync would add a
  // second message about the same thing.
  const fetchMock = routedFetch({
    connections: { body: { connections: [{ ...connection, healthy: false }] } },
  });
  vi.stubGlobal("fetch", fetchMock);
  renderList();
  await screen.findByText("Reconnect");

  expect(
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sync")),
  ).toHaveLength(0);
});

test("a plain member sees boards and may open them", async () => {
  vi.stubGlobal("fetch", routedFetch());

  renderList("member");

  expect(await screen.findByText("Acme Board")).toBeDefined();
  // Reading a board's tickets is a read the organization already has a grant
  // for, so the row is open to anyone in it.
  expect(screen.getByRole("link", { name: /acme board/i })).toBeDefined();
  // Disconnecting is not.
  const menu = await openSiteMenu();
  expect(
    within(menu).queryByRole("menuitem", { name: /disconnect/i }),
  ).toBeNull();
});

// ---- the banner says its whole message ------------------------------------
//
// Title and detail sat on one line with the detail truncated, so even the
// short sentences were clipped at 1280px. The one that matters most is
// `partial-scopes`, which names the scopes to grant and where to find them —
// instructions, cut off mid-word.

test("the detail wraps instead of being truncated", async () => {
  withOutcome(
    "?jira=partial-scopes&missing=read%3Aboard-scope%3Ajira-software%2Cread%3Asprint%3Ajira-software",
  );

  renderPage();

  const banner = await screen.findByTestId("jira-outcome");
  const detail = within(banner).getByTestId("jira-outcome-detail");
  // jsdom has no layout, so `truncate` is the contract that carried the clip.
  expect(detail.className).not.toContain("truncate");
  expect(banner.className).not.toContain("truncate");
  // The whole sentence, not a prefix of it.
  expect(detail.textContent).toContain("Granular scopes");
  expect(detail.textContent).toContain("read:sprint:jira-software");
});

test("each tone is announced as urgently as it deserves", async () => {
  // A failure interrupts; a success waits until the reader is idle. Both were
  // silent before, being neither `alert` nor `status`.
  withOutcome("?jira=denied");
  renderPage();

  const banner = await screen.findByTestId("jira-outcome");
  expect(banner.getAttribute("role")).toBe("alert");
});

test("an outcome that is not a failure is announced politely", async () => {
  withOutcome("?jira=connected");
  renderPage();

  const banner = await screen.findByTestId("jira-outcome");
  expect(banner.getAttribute("role")).toBe("status");
});

test("disconnecting asks before it disconnects", async () => {
  // It takes every board registered from the site, and the grant with them.
  const fetchMock = routedFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderList();
  await screen.findByText("Acme Board");

  const menu = await openSiteMenu();
  await userEvent.click(
    within(menu).getByRole("menuitem", { name: /disconnect/i }),
  );

  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/Disconnect acme\?/i)).toBeDefined();
  expect(
    fetchMock.mock.calls.some(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    ),
  ).toBe(false);
});

// ---- the peek, and the wait inside it -------------------------------------
//
// The peek opens on the click with the proposal already in it; only the
// ticket behind the Spec tab is still on its way from Jira, and that tab
// holds the ticket's shape until it lands rather than a spinner.

test("a date-only due date is that calendar day west of UTC too", () => {
  const zone = process.env.TZ;
  // Jira sends `dueDate` without a time; read as UTC midnight, it is the day
  // before anywhere west of Greenwich.
  process.env.TZ = "America/Los_Angeles";
  try {
    const noon = new Date(2026, 11, 19, 12);
    expect(fromToday("2026-12-19", noon)).toBe("today");
    expect(fromToday("2026-12-20", noon)).toBe("tomorrow");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

/* -------------------------------------------------------------------------- */
/* The repository a board's tickets are about                                 */
/* -------------------------------------------------------------------------- */

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
  stack: null,
  contextSnapshotId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

/**
 * `routedFetch`, with the organization's registered repositories.
 * Everything else falls through.
 */
function withRepositories(repositories: unknown[] = [widgets]) {
  const inner = routedFetch({ boards: { body: { boards: [board] } } });
  return vi.fn((input: string, init?: RequestInit) => {
    if (String(input).endsWith("/github/repositories")) {
      return Promise.resolve(
        new Response(JSON.stringify({ repositories }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return inner(input, init);
  });
}

test("a board names no repository: its tickets may touch any of the workspace's", async () => {
  const fetchMock = withRepositories();
  vi.stubGlobal("fetch", fetchMock);
  renderBoard("owner");

  await screen.findByTestId("backlog-scan");
  expect(screen.queryByTestId("board-repository")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
  expect(
    fetchMock.mock.calls.some(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    ),
  ).toBe(false);
});
