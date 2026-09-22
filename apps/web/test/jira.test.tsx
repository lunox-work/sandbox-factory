/**
 * The Jira connections page.
 *
 * Three properties. That the connect button is a *navigation* rather than a
 * fetch, because the browser has to reach Atlassian's consent screen. That the
 * outcome the callback appended is explained and then removed from the URL, so
 * a reload does not re-announce it. And that a plain member sees no control
 * the API would refuse.
 *
 * The server is faked at the `fetch` boundary, as elsewhere in this suite.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Jira, JiraBoard, JiraSite } from "../src/Jira";

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
      pathname: "/o/acme/jira",
      search: "",
      get href() {
        return "http://localhost/o/acme/jira";
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

/** The list of sites. `opened` records which one a row navigated to. */
let opened: string[] = [];

function renderPage(role = "owner") {
  opened = [];
  return render(
    <Jira
      organizationId="org_1"
      organizationSlug="acme"
      organizationName="Acme"
      role={role}
      onOpenSite={(site) => opened.push(site.id)}
    />,
  );
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

test("a site row opens that site rather than carrying its own controls", async () => {
  // There is one destination per row and nothing else to press, so the whole
  // row is the target and what can be done to a site lives inside it.
  renderPage();
  await screen.findByText("Acme");

  await userEvent.click(screen.getByRole("link", { name: /acme/i }));

  expect(opened).toEqual(["jrc_1"]);
  // Not on the list: pressing the wrong bin in a column of similar names is
  // how a site gets disconnected by accident.
  expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
});

test("a member can open a site even though they cannot connect one", async () => {
  renderPage("member");
  await screen.findByText("Acme");

  await userEvent.click(screen.getByRole("link", { name: /acme/i }));

  expect(opened).toEqual(["jrc_1"]);
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
  renderSite();
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
  expect(badges[0]?.closest("li")?.textContent).toContain("Acme");
});

test("a failed load says so rather than rendering an empty list", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
  );

  renderPage();

  expect(await screen.findByText(/could not load/i)).toBeDefined();
});

test("a response of the wrong shape renders empty rather than throwing", async () => {
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

  expect(await screen.findByText(/no sites connected/i)).toBeDefined();
});

/* The outcome banner: what the callback reports back. */

function withOutcome(search: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/o/acme/jira",
      search,
      get href() {
        return `http://localhost/o/acme/jira${search}`;
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
  selection: { maxTickets: 10, excludeAssigned: true },
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
    liveKey: `ACME-${n}`,
    liveTitle: `Ticket ${n}`,
    liveUrl: `https://acme.atlassian.net/browse/ACME-${n}`,
    modelRationale: "A few files.",
    complexity: "M",
    amountMinor: 200,
    currency: "USD",
    modelComplexity: "M",
    modelConfidence: "high",
    actualModel: "claude-sonnet-5",
    freshness: "current",
    status: "proposed",
    revision: 1,
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
  } = {},
) {
  return vi.fn((input: string) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );

    if (url.includes("/issues/")) {
      const spec = overrides.detail;
      return json(
        spec?.body ?? {
          issue: {
            ...issue(1, "2020-01-01T00:00:00.000Z"),
            descriptionText:
              "## Objective\nEstablish the canonical data model.\n\n## Scope\n- Canonical entities\n- Multi-tenant isolation",
            reporter: "charlie angriawan",
            creator: "charlie angriawan",
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
        freshness: { freshness: "current", checkedAt: "now" },
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

/** The one-site page: boards, the preview, and disconnecting. */
let disconnected = 0;
let reportedName: (string | undefined)[] = [];
let openedBoards: string[] = [];

/** The board page: its proposals, and the peek that opens over them. */
let reportedBoardName: (string | undefined)[] = [];

function renderBoard(boardId = "jrb_1", role?: string) {
  reportedBoardName = [];
  return render(
    <JiraBoard
      organizationId="org_1"
      connectionId="jrc_1"
      boardId={boardId}
      onBoardName={(name) => reportedBoardName.push(name)}
      onSiteName={vi.fn()}
      role={role}
    />,
  );
}

function renderSite(role = "owner", connectionId = "jrc_1") {
  disconnected = 0;
  reportedName = [];
  openedBoards = [];
  return render(
    <JiraSite
      organizationId="org_1"
      organizationSlug="acme"
      connectionId={connectionId}
      role={role}
      onDisconnected={() => {
        disconnected += 1;
      }}
      onOpenBoard={(opened) => openedBoards.push(opened.id)}
      onSiteName={(name) => reportedName.push(name)}
    />,
  );
}

test("a registered board is listed with its type and project", async () => {
  vi.stubGlobal("fetch", routedFetch());

  renderSite();

  expect(await screen.findByText("Acme Board")).toBeDefined();
  expect(screen.getByText(/scrum · ACME/i)).toBeDefined();
});

test("a board row opens the board rather than previewing it in place", async () => {
  // The row used to carry a "Preview" button, which named the mechanism
  // rather than the destination. The whole row is the target now.
  vi.stubGlobal("fetch", routedFetch());
  renderSite();
  await screen.findByText("Acme Board");

  expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();

  await userEvent.click(screen.getByRole("link", { name: /acme board/i }));

  expect(openedBoards).toEqual(["jrb_1"]);
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
  renderSite();
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

test("the board page lists its proposals, and nothing else", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();

  const list = await screen.findByTestId("proposal-list");
  const keys = within(list)
    .getAllByText(/^ACME-\d+$/)
    .map((node) => node.textContent);
  expect(keys).toEqual(["ACME-1", "ACME-2"]);
  expect(within(list).getByText("Ticket 1")).toBeDefined();
  // A row is a scan: key, title, size, price. The rationale, the model line
  // and the actions are all in the peek.
  expect(within(list).getAllByText("M")).toHaveLength(2);
  expect(within(list).getAllByText(/2\.00/)).toHaveLength(2);
  expect(within(list).queryByText("A few files.")).toBeNull();
  expect(within(list).queryByRole("button", { name: "Approve" })).toBeNull();
  // No Backlog tab to switch to: proposals are the page.
  expect(screen.queryByRole("tab", { name: /backlog/i })).toBeNull();
  expect(screen.queryByTestId("backlog-preview")).toBeNull();
});

test("a proposal opens over the list, which keeps its place", async () => {
  // Reading one proposal must not cost the place in the list, or comparing
  // two means opening each in turn from memory.
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));

  const panel = await screen.findByTestId("proposal-panel");
  expect(within(panel).getByRole("tab", { name: /bounty/i })).toBeDefined();
  expect(within(panel).getByRole("tab", { name: /spec/i })).toBeDefined();
  expect(within(panel).getByText("A few files.")).toBeDefined();

  /*
    The list is still mounted behind the peek, holding its scroll position
    and its selection. `hidden: true` because the panel is a modal, so
    everything outside it is `aria-hidden` and the default queries skip it —
    which is the point: it is there, and it is not what the reader is in.
  */
  const list = screen.getByTestId("proposal-list", { hidden: true });
  expect(within(list).getAllByRole("button", { hidden: true })).toHaveLength(2);
});

test("the peek is a dialog, so Escape closes it", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));
  await screen.findByTestId("proposal-panel");
  expect(screen.getByRole("dialog")).toBeDefined();

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
  });
  expect(screen.getByTestId("proposal-list")).toBeDefined();
});

test("the proposal being read is marked in the list", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));
  await screen.findByTestId("proposal-panel");

  const list = screen.getByTestId("proposal-list", { hidden: true });
  const row = within(list).getByText("Ticket 1").closest("button");
  expect(row?.getAttribute("aria-current")).toBe("true");
  expect(
    within(list)
      .getAllByRole("button", { hidden: true })
      .filter((node) => node.getAttribute("aria-current") === "true"),
  ).toHaveLength(1);
});

test("picking another proposal swaps the panel, without leaving the list", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");
  expect(within(panel).getAllByText("ACME-1").length).toBeGreaterThan(0);

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
  });

  await userEvent.click(
    within(screen.getByTestId("proposal-list")).getByText("Ticket 2"),
  );
  const next = await screen.findByTestId("proposal-panel");
  expect(within(next).getAllByText("ACME-2").length).toBeGreaterThan(0);
  expect(screen.getByTestId("proposal-list", { hidden: true })).toBeDefined();
});

test("the Spec tab is the ticket read live: its fields, then its description", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");
  await userEvent.click(screen.getByText("Ticket 1"));

  const panel = await screen.findByTestId("proposal-panel");
  await userEvent.click(within(panel).getByRole("tab", { name: /spec/i }));

  const spec = await within(panel).findByTestId("issue-spec");
  expect(
    within(spec).getByText(/Establish the canonical data model/),
  ).toBeDefined();
  // One scroll: the fields come before the description rather than
  // hiding behind a second tab.
  const fields = within(panel).getByTestId("issue-fields");
  expect(
    fields.compareDocumentPosition(spec) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(within(panel).queryByRole("tab", { name: /fields/i })).toBeNull();
  // Folded: the status and the due date, with its distance from today,
  // and nothing else yet.
  expect(within(fields).getByText("To Do")).toBeDefined();
  expect(within(fields).getByText("Due")).toBeDefined();
  expect(within(fields).getByText(/^· (in|next) /)).toBeDefined();
  expect(within(fields).queryByText("Priority")).toBeNull();
  expect(within(fields).queryByText("charlie angriawan")).toBeNull();

  await userEvent.click(
    within(fields).getByRole("button", { name: /show all/i }),
  );
  expect(within(fields).getByText("charlie angriawan")).toBeDefined();
  expect(within(fields).getByText("Highest")).toBeDefined();
  expect(within(fields).getByText("foundation")).toBeDefined();
  // Created and Updated carry their distance too.
  expect(within(fields).getAllByText(/years ago$/)).toHaveLength(2);

  await userEvent.click(
    within(fields).getByRole("button", { name: /show less/i }),
  );
  expect(within(fields).queryByText("Highest")).toBeNull();
});

test("folded fields fall back from due date to priority to created", async () => {
  vi.stubGlobal(
    "fetch",
    routedFetch({
      detail: {
        body: {
          issue: {
            ...issue(1, "2020-01-01T00:00:00.000Z"),
            descriptionText: "Some spec.",
            reporter: null,
            creator: null,
            resolution: null,
            resolutionDate: null,
            labels: [],
            priority: "Low",
            parentKey: null,
            projectKey: "NOX",
            dueDate: null,
            components: [],
            fixVersions: [],
            originalEstimateSeconds: null,
            remainingEstimateSeconds: null,
            votes: 0,
            watchers: 0,
            environment: null,
          },
        },
      },
    }),
  );
  renderBoard();
  await screen.findByTestId("proposal-list");
  await userEvent.click(screen.getByText("Ticket 1"));

  const panel = await screen.findByTestId("proposal-panel");
  await userEvent.click(within(panel).getByRole("tab", { name: /spec/i }));

  const fields = await within(panel).findByTestId("issue-fields");
  expect(within(fields).queryByText("Due")).toBeNull();
  expect(within(fields).getByText("Low")).toBeDefined();
  expect(within(fields).queryByText("Created")).toBeNull();
});

test("a field Jira did not send renders no row", async () => {
  // A site can omit almost any field; a column of empty labels is worse than
  // a short list.
  vi.stubGlobal(
    "fetch",
    routedFetch({
      detail: {
        body: {
          issue: {
            ...issue(1, "2020-01-01T00:00:00.000Z"),
            descriptionText: "",
            reporter: null,
            creator: null,
            resolution: null,
            resolutionDate: null,
            labels: [],
            priority: null,
            parentKey: null,
            projectKey: null,
            dueDate: null,
            components: [],
            fixVersions: [],
            originalEstimateSeconds: null,
            remainingEstimateSeconds: null,
            votes: null,
            watchers: null,
            environment: null,
          },
        },
      },
    }),
  );
  renderBoard();
  await screen.findByTestId("proposal-list");
  await userEvent.click(screen.getByText("Ticket 1"));

  const panel = await screen.findByTestId("proposal-panel");
  await userEvent.click(within(panel).getByRole("tab", { name: /spec/i }));

  const fields = await within(panel).findByTestId("issue-fields");
  // No due date and no priority: the fold shows when it was created.
  expect(within(fields).getByText("Created")).toBeDefined();
  await userEvent.click(
    within(fields).getByRole("button", { name: /show all/i }),
  );
  expect(within(fields).queryByText("Reporter")).toBeNull();
  expect(within(fields).queryByText("Resolution")).toBeNull();
  expect(within(fields).queryByText("Labels")).toBeNull();
  // Assignee still shows, because "Unassigned" is information.
  expect(within(fields).getByText("Unassigned")).toBeDefined();
  // And a missing description is said, not left blank.
  expect(within(panel).getByText(/no description/i)).toBeDefined();
});

test("an empty proposal list is explained rather than shown as a blank table", async () => {
  vi.stubGlobal(
    "fetch",
    routedFetch({ proposals: { body: { proposals: [] } } }),
  );
  renderBoard();

  expect(await screen.findByText(/no proposed proposals/i)).toBeDefined();
});

test("a failed ticket read stays in the Spec tab with a retry", async () => {
  vi.stubGlobal(
    "fetch",
    routedFetch({ detail: { status: 502, body: { error: "upstream" } } }),
  );
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");
  await userEvent.click(within(panel).getByRole("tab", { name: /spec/i }));
  expect(
    await within(panel).findByText(/could not load this ticket from Jira/i),
  ).toBeDefined();
  expect(
    within(panel).getByRole("button", { name: /try again/i }),
  ).toBeDefined();
  // The Bounty tab is unaffected: the proposal itself loaded.
  await userEvent.click(within(panel).getByRole("tab", { name: /bounty/i }));
  expect(within(panel).getByText("A few files.")).toBeDefined();
});

test("a proposal can be opened directly from the query", async () => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/o/acme/jira/jrc_1/jrb_1",
      search: "?proposal=bpr_1",
      href: "http://localhost/o/acme/jira/jrc_1/jrb_1?proposal=bpr_1",
    },
  });
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();

  expect(await screen.findByTestId("proposal-detail")).toBeDefined();
  expect(screen.getByRole("dialog").getAttribute("data-testid")).toBe(
    "proposal-panel",
  );
});

test("a revoked grant asks for a reconnect rather than a retry", async () => {
  // 409 with `reconnect` is the one failure a retry cannot fix. The ticket
  // read is where the grant is exercised now that the page reads no backlog.
  vi.stubGlobal(
    "fetch",
    routedFetch({
      detail: { status: 409, body: { error: "gone", code: "reconnect" } },
    }),
  );
  renderBoard();
  await screen.findByTestId("proposal-list");
  await userEvent.click(screen.getByText("Ticket 1"));

  expect(await screen.findByText(/expired or been revoked/i)).toBeDefined();
});

test("a scope mismatch is not reported as an expired connection", async () => {
  // A live grant, refused because the Atlassian app was never given the
  // Jira Software scopes. "Reconnect" is a loop that ends where it started.
  vi.stubGlobal(
    "fetch",
    routedFetch({
      detail: {
        status: 502,
        body: {
          code: "scope",
          error:
            "This Atlassian app is not authorised for Jira's Agile API. Its scope list needs the Jira Software scopes, and the site must then be connected again.",
        },
      },
    }),
  );
  renderBoard();
  await screen.findByTestId("proposal-list");
  await userEvent.click(screen.getByText("Ticket 1"));

  expect(await screen.findByTestId("jira-scope-error")).toBeDefined();
  expect(screen.queryByText(/expired or been revoked/i)).toBeNull();
});

test("the actions sit in the bounty card, beside what they change, for those who may act", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard("jrb_1", "owner");
  await screen.findByTestId("proposal-list");
  // Not in the rows.
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");
  const card = within(panel).getByTestId("proposal-bounty");
  for (const name of [
    "Approve",
    "XS",
    "S",
    "L",
    "XL",
    "Re-analyze",
    "Remove",
  ]) {
    expect(within(card).getByRole("button", { name })).toBeDefined();
  }
  // Two states, one card: nothing here is for an approved proposal.
  expect(within(card).queryByRole("button", { name: "Unapprove" })).toBeNull();
  // The size is the resize: the current size is the pressed segment, and
  // is not offered as a change.
  const resize = within(card).getByRole("group", { name: "Resize" });
  const current = within(resize).getByRole("button", {
    name: "M",
  }) as HTMLButtonElement;
  expect(current.disabled).toBe(true);
  expect(current.getAttribute("aria-pressed")).toBe("true");
  // Approve comes after the reasoning it is made on, on one row with what
  // it is checked against; Remove comes last.
  const approve = within(card).getByRole("button", { name: "Approve" });
  const follows = (before: Element, after: Element) =>
    (before.compareDocumentPosition(after) &
      Node.DOCUMENT_POSITION_FOLLOWING) !==
    0;
  expect(follows(within(card).getByText("A few files."), approve)).toBe(true);
  expect(
    within(card).getByText("Revision 1").parentElement?.parentElement,
  ).toBe(approve.parentElement?.parentElement);
  // Remove hangs under Approve.
  expect(
    within(card).getByRole("button", { name: "Remove" }).parentElement,
  ).toBe(approve.parentElement);
  // The model wears its vendor's mark.
  expect(
    within(card)
      .getByTitle("claude-sonnet-5")
      .parentElement?.querySelector("svg"),
  ).not.toBeNull();
});

test("an approved proposal offers the way back and a re-price, nothing else", async () => {
  vi.stubGlobal(
    "fetch",
    routedFetch({
      proposals: {
        body: { proposals: [{ ...proposal(1), status: "approved" }] },
      },
    }),
  );
  renderBoard("jrb_1", "owner");
  await screen.findByTestId("proposal-list");
  // The two filters are the two states.
  expect(screen.getByRole("tab", { name: "Proposed" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "Approved" })).toBeDefined();
  expect(
    screen.queryByRole("tab", { name: /rejected|superseded/i }),
  ).toBeNull();

  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");
  const card = within(panel).getByTestId("proposal-bounty");
  expect(within(card).getByRole("button", { name: "Unapprove" })).toBeDefined();
  expect(
    within(card).getByRole("button", { name: "Re-analyze" }),
  ).toBeDefined();
  expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull();
  expect(within(card).queryByRole("button", { name: "Remove" })).toBeNull();
  expect(within(card).queryByRole("group", { name: "Resize" })).toBeNull();
  // The size is still shown, just not as a control.
  expect(within(card).getByText("M")).toBeDefined();
});

test("removing a proposal asks first, then closes the peek", async () => {
  const fetchMock = routedFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderBoard("jrb_1", "owner");
  await screen.findByTestId("proposal-list");
  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");

  await userEvent.click(within(panel).getByRole("button", { name: "Remove" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(
    within(dialog).getByText(/remove the proposal for ACME-1/i),
  ).toBeDefined();
  // Nothing sent yet.
  expect(
    fetchMock.mock.calls.some(([input]) => String(input).includes("/remove")),
  ).toBe(false);

  await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() => {
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/proposals/bpr_1/remove"),
      ),
    ).toBe(true);
  });
  await waitFor(() => {
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
  });
});

test("a member sees the proposal without any way to decide it", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard("jrb_1", "member");
  await screen.findByTestId("proposal-list");
  expect(screen.queryByRole("button", { name: /run sizing/i })).toBeNull();

  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");
  for (const name of ["Approve", "Re-analyze", "Remove", "Unapprove"]) {
    expect(within(panel).queryByRole("button", { name })).toBeNull();
  }
  expect(within(panel).queryByRole("group", { name: "Resize" })).toBeNull();
  expect(within(panel).getByText("M")).toBeDefined();
  expect(within(panel).getByText("A few files.")).toBeDefined();
});

test("the proposal names the model that sized it", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");
  await userEvent.click(screen.getByText("Ticket 1"));

  const panel = await screen.findByTestId("proposal-panel");
  expect(within(panel).getByTitle("claude-sonnet-5").textContent).toBe(
    "Claude Sonnet 5",
  );
});

test("the board's name is reported up, for the trail above the page", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");

  await waitFor(() => {
    expect(reportedBoardName).toContain("Acme Board");
  });
});

test("opening a site re-reads its boards, so one made since shows up", async () => {
  // A client creates a board in Jira and nothing tells us. Nobody is asked
  // to press anything: the list is refreshed where somebody is looking at it.
  const fetchMock = routedFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderSite();
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
  renderSite();
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
  renderSite();
  await screen.findByText("Reconnect");

  expect(
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sync")),
  ).toHaveLength(0);
});

test("only this site's boards are listed", async () => {
  // The hook holds the organization's boards, because that is what the API
  // answers with. The page is about one site.
  vi.stubGlobal(
    "fetch",
    routedFetch({
      boards: {
        body: {
          boards: [
            board,
            { ...board, id: "jrb_2", connectionId: "jrc_2", name: "Other Co" },
          ],
        },
      },
    }),
  );
  renderSite();

  expect(await screen.findByText("Acme Board")).toBeDefined();
  expect(screen.queryByText("Other Co")).toBeNull();
});

test("a plain member sees boards and may open them", async () => {
  vi.stubGlobal("fetch", routedFetch());

  renderSite("member");

  expect(await screen.findByText("Acme Board")).toBeDefined();
  // Reading a board's tickets is a read the organization already has a grant
  // for, so the row is open to anyone in it.
  expect(screen.getByRole("link", { name: /acme board/i })).toBeDefined();
  // Disconnecting is not.
  expect(screen.queryByRole("button", { name: /^disconnect/i })).toBeNull();
});

test("disconnecting lives on the site, and leaves it when done", async () => {
  const fetchMock = routedFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderSite();
  await screen.findByText("Acme Board");

  await userEvent.click(
    screen.getByRole("button", { name: /disconnect acme/i }),
  );
  // Behind a question now: it takes the boards and the grant with it.
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Disconnect" }),
  );

  await waitFor(() => {
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true);
  });
  // Back to the list: the site this page is about no longer exists.
  await waitFor(() => {
    expect(disconnected).toBe(1);
  });
});

test("a site the URL names but the list does not is a miss", async () => {
  // A stale bookmark, or a site somebody else disconnected.
  vi.stubGlobal("fetch", routedFetch());
  renderSite("owner", "jrc_gone");

  expect(await screen.findByText(/not connected/i)).toBeDefined();
});

test("the site's name is reported up, for the trail above the page", async () => {
  // The shell renders the trail and has no other way to learn the name.
  vi.stubGlobal("fetch", routedFetch());
  renderSite();
  await screen.findByText("Acme Board");

  await waitFor(() => {
    expect(reportedName).toContain("Acme");
  });
});

test("the description renders as markdown, not as literal hashes", async () => {
  // `adfToText` hands over Markdown; showing it raw makes a spec a wall of
  // `#` and `|`, which is exactly what a reviewer cannot read.
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  const list = await screen.findByTestId("proposal-list");
  await userEvent.click(within(list).getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");
  await userEvent.click(within(panel).getByRole("tab", { name: /spec/i }));

  const spec = await screen.findByTestId("issue-spec");
  // A real heading element, and the hashes are gone from the text.
  const heading = within(spec).getByText("Objective");
  expect(heading.tagName).toMatch(/^H[1-6]$/);
  expect(within(spec).queryByText(/^##/)).toBeNull();
  // And the bullets are list items rather than hyphens.
  expect(within(spec).getAllByRole("listitem").length).toBeGreaterThan(0);
});

test("a table in the description renders as a table", async () => {
  // The substance of a ticket like NOX-2 is its entity table, and the ADF
  // flattener now emits the delimiter row GFM needs to see one.
  vi.stubGlobal(
    "fetch",
    routedFetch({
      detail: {
        body: {
          issue: {
            ...issue(1, "2020-01-01T00:00:00.000Z"),
            descriptionText:
              "| Entity | Notes |\n| --- | --- |\n| Worker | Tenant leaf |",
            reporter: null,
            creator: null,
            resolution: null,
            resolutionDate: null,
            labels: [],
            priority: null,
            parentKey: null,
            projectKey: null,
            dueDate: null,
            components: [],
            fixVersions: [],
            originalEstimateSeconds: null,
            remainingEstimateSeconds: null,
            votes: null,
            watchers: null,
            environment: null,
          },
        },
      },
    }),
  );
  renderBoard();
  const list = await screen.findByTestId("proposal-list");
  await userEvent.click(within(list).getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");
  await userEvent.click(within(panel).getByRole("tab", { name: /spec/i }));

  const spec = await screen.findByTestId("issue-spec");
  expect(within(spec).getByRole("table")).toBeDefined();
  expect(
    within(spec).getByRole("columnheader", { name: "Entity" }),
  ).toBeDefined();
  expect(within(spec).getByRole("cell", { name: "Tenant leaf" })).toBeDefined();
});

test("the page keeps enough top padding for the breadcrumb's negative margin", async () => {
  // The trail above pulls its bottom margin back by `-mb-6 sm:-mb-8` so it
  // and the heading read as one header block. A page whose own top padding is
  // smaller than that pull has its heading dragged up into the trail, which
  // is what `p-6` did here.
  vi.stubGlobal("fetch", routedFetch());
  const { container } = renderSite();
  await screen.findByText("Acme Board");

  const main = container.querySelector("main");
  expect(main).not.toBeNull();
  expect(main?.className).toContain("py-10");
  expect(main?.className).toContain("sm:py-14");
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
  renderSite();
  await screen.findByText("Acme Board");

  await userEvent.click(
    screen.getByRole("button", { name: /disconnect acme/i }),
  );

  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/Disconnect acme\?/i)).toBeDefined();
  expect(
    fetchMock.mock.calls.some(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    ),
  ).toBe(false);
  expect(disconnected).toBe(0);
});

// ---- the peek, and the wait inside it -------------------------------------
//
// The peek opens on the click with the proposal already in it; only the
// ticket behind the Spec tab is still on its way from Jira, and that tab
// holds the ticket's shape until it lands rather than a spinner.

/**
 * A fetch whose ticket detail is held open until it is released.
 *
 * Everything else answers at once, so the board still renders; only the read
 * behind the peek is suspended, which is the moment being tested.
 */
function pendingDetailFetch() {
  let release: () => void = () => {};
  const base = routedFetch();
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchMock = vi.fn((input: string) =>
    String(input).includes("/issues/")
      ? gate.then(() => base(input) as Promise<Response>)
      : (base(input) as Promise<Response>),
  );
  return { fetchMock, release: () => release() };
}

test("the peek is its own scrolling region, and the only one", async () => {
  // jsdom has no layout and no wheel, so the class contract carries this;
  // the behaviour itself is checked in a browser.
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");

  const scroller = panel.querySelector(".overflow-y-auto");
  expect(scroller).not.toBeNull();
  expect(scroller?.className).toContain("overscroll-contain");
  expect(panel.className).not.toContain("overflow-y-auto");
});

test("the peek comes in from the edge it is attached to", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");

  expect(panel.className).toContain("slide-in-from-right");
  expect(panel.className).toContain("inset-y-0");
  expect(panel.className).toContain("right-0");
});

test("the spec does not scroll inside the scrolling panel", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("proposal-panel");
  await userEvent.click(within(panel).getByRole("tab", { name: /spec/i }));
  const spec = await within(panel).findByTestId("issue-spec");

  expect(spec.className).not.toContain("max-h-");
  expect(spec.className).not.toContain("overflow-y-auto");
});

test("the peek returns focus to the row it was opened from", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");

  const row = within(screen.getByTestId("proposal-list"))
    .getByText("Ticket 1")
    .closest("button");
  await userEvent.click(row as HTMLElement);
  await screen.findByTestId("proposal-panel");

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(document.activeElement).toBe(row);
  });
});

test("the ticket is read when the peek opens, so the Spec tab is instant once it lands", async () => {
  const { fetchMock, release } = pendingDetailFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));

  // Open at once, on the Bounty tab, with the proposal already there.
  const panel = await screen.findByTestId("proposal-panel");
  expect(within(panel).getByText("A few files.")).toBeDefined();
  // The read started with the click, not with the tab.
  expect(
    fetchMock.mock.calls.some(([input]) => String(input).includes("/issues/")),
  ).toBe(true);

  // The Spec tab holds the ticket's shape until it arrives.
  await userEvent.click(within(panel).getByRole("tab", { name: /spec/i }));
  const skeleton = within(panel).getByTestId("issue-skeleton");
  expect(within(skeleton).getByRole("status").textContent).toMatch(/loading/i);
  expect(within(panel).queryByTestId("issue-detail")).toBeNull();

  release();

  await waitFor(() => {
    expect(within(panel).getByTestId("issue-detail")).toBeDefined();
  });
  expect(within(panel).queryByTestId("issue-skeleton")).toBeNull();
});

test("the row being opened is marked from the click, not from the response", async () => {
  const { fetchMock, release } = pendingDetailFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderBoard();
  await screen.findByTestId("proposal-list");

  const list = screen.getByTestId("proposal-list");
  const row = within(list).getByText("Ticket 1").closest("button");
  await userEvent.click(row as HTMLElement);
  await screen.findByTestId("proposal-panel");

  expect(row?.getAttribute("aria-current")).toBe("true");
  release();
});

test("closing while the ticket is still loading does not reopen it", async () => {
  const { fetchMock, release } = pendingDetailFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));
  await screen.findByTestId("proposal-panel");

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
  });

  release();

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByTestId("proposal-panel")).toBeNull();
});

test("the way out to Jira sits on the tab row", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("proposal-list");

  await userEvent.click(screen.getByText("Ticket 1"));
  await screen.findByTestId("proposal-detail");

  const link = screen.getByRole("link", { name: /open in jira/i });
  const row = link.parentElement;
  expect(row?.className).toContain("justify-between");
  expect(within(row as HTMLElement).getByRole("tablist")).toBeDefined();
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
});
