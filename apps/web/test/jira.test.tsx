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

  await userEvent.click(screen.getByRole("button", { name: /acme/i }));

  expect(opened).toEqual(["jrc_1"]);
  // Not on the list: pressing the wrong bin in a column of similar names is
  // how a site gets disconnected by accident.
  expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
});

test("a member can open a site even though they cannot connect one", async () => {
  renderPage("member");
  await screen.findByText("Acme");

  await userEvent.click(screen.getByRole("button", { name: /acme/i }));

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
/* Boards and the backlog preview                                             */
/* -------------------------------------------------------------------------- */

const board = {
  id: "jrb_1",
  connectionId: "jrc_1",
  externalId: "42",
  name: "Acme Board",
  boardType: "scrum",
  projectKey: "ACME",
  selection: { maxTickets: 10, excludeAssigned: true },
  writebackEnabled: false,
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
    preview?: { status?: number; body?: unknown };
    detail?: { status?: number; body?: unknown };
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
    if (url.includes("backlog-preview")) {
      const spec = overrides.preview;
      return json(
        spec?.body ?? {
          boardId: "jrb_1",
          source: "backlog",
          jql: "ORDER BY created ASC",
          issues: [
            issue(1, "2020-01-01T00:00:00.000Z"),
            issue(2, "2021-01-01T00:00:00.000Z"),
          ],
        },
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

/** The board page: the ticket list, and the detail panel beside it. */
let reportedBoardName: (string | undefined)[] = [];

function renderBoard(boardId = "jrb_1") {
  reportedBoardName = [];
  return render(
    <JiraBoard
      organizationId="org_1"
      connectionId="jrc_1"
      boardId={boardId}
      onBoardName={(name) => reportedBoardName.push(name)}
      onSiteName={vi.fn()}
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

  await userEvent.click(screen.getByRole("button", { name: /acme board/i }));

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
    .getByRole("button", { name: /acme board/i })
    .querySelector("svg");
  const kanban = screen
    .getByRole("button", { name: /flow/i })
    .querySelector("svg");

  expect(scrum).not.toBeNull();
  expect(kanban).not.toBeNull();
  // Different marks, not the same one twice.
  expect(scrum?.innerHTML).not.toBe(kanban?.innerHTML);
});

test("the board page lists its oldest tickets", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();

  const list = await screen.findByTestId("backlog-preview");
  // The ordering is the product's claim about which work is worth a bounty.
  const keys = within(list)
    .getAllByText(/^ACME-\d+$/)
    .map((node) => node.textContent);
  expect(keys).toEqual(["ACME-1", "ACME-2"]);
  expect(within(list).getByText("Ticket 1")).toBeDefined();
});

test("a ticket opens over the list, which keeps its place", async () => {
  // The property the split existed for, and the peek keeps: reading one
  // ticket must not cost the place in the list, or comparing two means
  // opening each in turn from memory.
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");

  await userEvent.click(screen.getByText("Ticket 1"));

  const panel = await screen.findByTestId("issue-panel");
  expect(
    within(panel).getByText(/Establish the canonical data model/),
  ).toBeDefined();

  /*
    The list is still mounted behind the peek, holding its scroll position
    and its selection. `hidden: true` because the panel is a modal, so
    everything outside it is `aria-hidden` and the default queries skip it —
    which is the point: it is there, and it is not what the reader is in.
  */
  const list = screen.getByTestId("backlog-preview", { hidden: true });
  expect(list).toBeDefined();
  expect(within(list).getAllByRole("button", { hidden: true })).toHaveLength(2);
});

test("the peek is a dialog, so Escape and a click outside close it", async () => {
  // What a peek buys over a column: the focus trap, the return of focus to
  // the row, and one obvious way out that does not need a bespoke control.
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");

  await userEvent.click(screen.getByText("Ticket 1"));
  await screen.findByTestId("issue-panel");

  expect(screen.getByRole("dialog")).toBeDefined();

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByTestId("issue-panel")).toBeNull();
  });
  // And the list is the reader's again.
  expect(screen.getByTestId("backlog-preview")).toBeDefined();
});

test("the ticket being read is marked in the list", async () => {
  // In a column of similar summaries, the only way to know which one the
  // panel is showing is to see it.
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");

  await userEvent.click(screen.getByText("Ticket 1"));
  await screen.findByTestId("issue-panel");

  /*
    Scoped to the list, and `hidden: true` because the peek is a modal that
    marks everything behind it `aria-hidden`. The mark matters more with a
    peek than it did with the split: the list is what the reader comes back
    to when the panel closes.
  */
  const list = screen.getByTestId("backlog-preview", { hidden: true });
  const row = within(list).getByText("Ticket 1").closest("button");
  expect(row?.getAttribute("aria-current")).toBe("true");
  // And only that one.
  expect(
    within(list)
      .getAllByRole("button", { hidden: true })
      .filter((node) => node.getAttribute("aria-current") === "true"),
  ).toHaveLength(1);
});

test("picking another ticket swaps the panel, without leaving the list", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");

  const list = screen.getByTestId("backlog-preview");
  await userEvent.click(within(list).getByText("Ticket 1"));
  const panel = await screen.findByTestId("issue-panel");
  // The peek names the ticket it is showing. Scoped, because the panel's own
  // `sr-only` title carries the same summary as the heading inside it.
  expect(within(panel).getAllByText("Ticket 1").length).toBeGreaterThan(0);

  // Closing and opening the next one, which is what a peek makes the reader
  // do — and the list it returns to is still there to do it from.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByTestId("issue-panel")).toBeNull();
  });

  await userEvent.click(
    within(screen.getByTestId("backlog-preview")).getByText("Ticket 2"),
  );
  await waitFor(() => {
    expect(screen.getByTestId("issue-panel")).toBeDefined();
  });
  expect(screen.getByTestId("backlog-preview", { hidden: true })).toBeDefined();
});

test("the panel shows the fields the list DTO does not carry", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");
  await userEvent.click(screen.getByText("Ticket 1"));

  const panel = await screen.findByTestId("issue-panel");
  await userEvent.click(within(panel).getByRole("tab", { name: /fields/i }));
  const fields = within(panel).getByTestId("issue-fields");
  expect(within(fields).getByText("charlie angriawan")).toBeDefined();
  expect(within(fields).getByText("Highest")).toBeDefined();
  expect(within(fields).getByText("foundation")).toBeDefined();
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
  await screen.findByTestId("backlog-preview");
  await userEvent.click(screen.getByText("Ticket 1"));

  const panel = await screen.findByTestId("issue-panel");
  await userEvent.click(within(panel).getByRole("tab", { name: /fields/i }));

  const fields = within(panel).getByTestId("issue-fields");
  expect(within(fields).queryByText("Reporter")).toBeNull();
  expect(within(fields).queryByText("Resolution")).toBeNull();
  expect(within(fields).queryByText("Labels")).toBeNull();
  // Assignee still shows, because "Unassigned" is information.
  expect(within(fields).getByText("Unassigned")).toBeDefined();
});

test("the board page says nothing was stored", async () => {
  // The promise the page makes: looking at a board is not pricing it.
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();

  await screen.findByTestId("backlog-preview");
  expect(screen.getByText(/nothing was stored/i)).toBeDefined();
});

test("an empty backlog is explained rather than shown as a blank table", async () => {
  vi.stubGlobal(
    "fetch",
    routedFetch({
      preview: {
        body: { boardId: "jrb_1", source: "backlog", jql: "", issues: [] },
      },
    }),
  );
  renderBoard();

  expect(await screen.findByText(/no tickets match/i)).toBeDefined();
});

test("a revoked grant asks for a reconnect rather than a retry", async () => {
  // 409 with `reconnect` is the one failure a retry cannot fix.
  vi.stubGlobal(
    "fetch",
    routedFetch({
      preview: { status: 409, body: { error: "gone", code: "reconnect" } },
    }),
  );
  renderBoard();

  expect(await screen.findByText(/expired or been revoked/i)).toBeDefined();
});

test("a scope mismatch is not reported as an expired connection", async () => {
  // The failure that prompted this: a live grant, refused by the Agile API
  // because the Atlassian app was never given the Jira Software scopes.
  // "Reconnect" is a loop that ends where it started.
  vi.stubGlobal(
    "fetch",
    routedFetch({
      preview: {
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

  expect(await screen.findByTestId("jira-scope-error")).toBeDefined();
  expect(screen.getByText(/scope list/i)).toBeDefined();
  expect(screen.queryByText(/expired or been revoked/i)).toBeNull();
});

test("the board's name is reported up, for the trail above the page", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");

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
  expect(screen.getByRole("button", { name: /acme board/i })).toBeDefined();
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
  const dialog = await screen.findByRole("dialog");
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
  const list = await screen.findByTestId("backlog-preview");
  await userEvent.click(within(list).getByText("Ticket 1"));

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
  const list = await screen.findByTestId("backlog-preview");
  await userEvent.click(within(list).getByText("Ticket 1"));

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

// ---- the open ticket stays in view ----------------------------------------
//
// The panel renders in the right-hand column, which starts at the top of the
// grid. Open a ticket from the foot of a long list and the panel was drawn
// entirely above the viewport — measured 400px up, with nothing on screen to
// show the click had done anything but highlight a row.

test("the peek is its own scrolling region, and the only one", async () => {
  /*
    The whole reason a peek settles the scrolling question. The split pinned
    the panel inside the page's own scroller, so either the panel captured
    the wheel when the cursor was inside it, or a long ticket stretched the
    page. A peek scrolls itself and Radix locks the page behind it, so the
    wheel has one destination wherever the cursor is.

    jsdom has no layout and no wheel, so the class contract carries this; the
    behaviour itself is checked in a browser.
  */
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");

  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("issue-panel");

  const scroller = panel.querySelector(".overflow-y-auto");
  expect(scroller).not.toBeNull();
  // `overscroll-contain`, or reaching the end of the ticket starts scrolling
  // the page behind the panel.
  expect(scroller?.className).toContain("overscroll-contain");
  // And the panel itself is not a second one.
  expect(panel.className).not.toContain("overflow-y-auto");
});

test("the peek comes in from the edge it is attached to", async () => {
  // Where it came from and where closing it puts it back. Without the
  // direction it reads as a dialog that happens to be against one side.
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");

  await userEvent.click(screen.getByText("Ticket 1"));
  const panel = await screen.findByTestId("issue-panel");

  expect(panel.className).toContain("slide-in-from-right");
  expect(panel.className).toContain("inset-y-0");
  expect(panel.className).toContain("right-0");
});

test("the spec no longer scrolls inside the scrolling panel", async () => {
  // A scroll area inside a scroll area: the spec had its own 26rem box, so a
  // long ticket gave the reader two scrollbars for one document.
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");

  await userEvent.click(screen.getByText("Ticket 1"));
  const spec = await screen.findByTestId("issue-spec");

  expect(spec.className).not.toContain("max-h-");
  expect(spec.className).not.toContain("overflow-y-auto");
});

test("the peek returns focus to the row it was opened from", async () => {
  /*
    What replaces the old scroll-into-view dance. The split had to bring the
    panel to the top by hand, because it rendered wherever the grid happened
    to start. A peek is a focus trap: Radix moves focus into it on open and
    hands it back to the trigger on close, so the reader lands on the row
    they were reading and can carry on down the list.
  */
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");

  const row = within(screen.getByTestId("backlog-preview"))
    .getByText("Ticket 1")
    .closest("button");
  await userEvent.click(row as HTMLElement);
  await screen.findByTestId("issue-panel");

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(document.activeElement).toBe(row);
  });
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

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/Disconnect acme\?/i)).toBeDefined();
  expect(
    fetchMock.mock.calls.some(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    ),
  ).toBe(false);
  expect(disconnected).toBe(0);
});

// ---- the wait has a shape -------------------------------------------------
//
// Opening waited for Jira before showing anything, so a click's only answer
// was a small spinner in the row — on a slow read the page looked unchanged,
// which invites a second click. The peek opens on the click instead, with the
// ticket's own shape sketched inside it.

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

test("clicking a ticket opens the peek before the ticket has arrived", async () => {
  const { fetchMock, release } = pendingDetailFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderBoard();
  await screen.findByTestId("backlog-preview");

  await userEvent.click(screen.getByText("Ticket 1"));

  // Open, and holding the ticket's shape rather than the ticket.
  expect(await screen.findByTestId("issue-panel")).toBeDefined();
  expect(screen.getByTestId("issue-skeleton")).toBeDefined();
  expect(screen.queryByTestId("issue-detail")).toBeNull();

  release();

  // And the real thing replaces it in the panel that was already open.
  await waitFor(() => {
    expect(screen.getByTestId("issue-detail")).toBeDefined();
  });
  expect(screen.queryByTestId("issue-skeleton")).toBeNull();
});

test("the skeleton says what it is standing in for", async () => {
  // The bars are `aria-hidden`; a screen reader should hear one sentence, not
  // a tree of empty boxes.
  const { fetchMock, release } = pendingDetailFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderBoard();
  await screen.findByTestId("backlog-preview");

  await userEvent.click(screen.getByText("Ticket 1"));
  const skeleton = await screen.findByTestId("issue-skeleton");

  expect(within(skeleton).getByRole("status").textContent).toMatch(/loading/i);
  release();
  await waitFor(() => {
    expect(screen.getByTestId("issue-detail")).toBeDefined();
  });
});

test("the row being opened is marked from the click, not from the response", async () => {
  // Or the list shows nothing selected for as long as the read takes, while
  // a panel about that very ticket is open beside it.
  const { fetchMock, release } = pendingDetailFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderBoard();
  await screen.findByTestId("backlog-preview");

  const list = screen.getByTestId("backlog-preview");
  const row = within(list).getByText("Ticket 1").closest("button");
  await userEvent.click(row as HTMLElement);
  await screen.findByTestId("issue-skeleton");

  expect(row?.getAttribute("aria-current")).toBe("true");
  release();
  await waitFor(() => {
    expect(screen.getByTestId("issue-detail")).toBeDefined();
  });
});

test("closing while the ticket is still loading does not reopen it", async () => {
  // The response is in flight when the reader gives up on it. Landing it
  // afterwards would push a panel back over a page they had returned to.
  const { fetchMock, release } = pendingDetailFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderBoard();
  await screen.findByTestId("backlog-preview");

  await userEvent.click(screen.getByText("Ticket 1"));
  await screen.findByTestId("issue-skeleton");

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByTestId("issue-panel")).toBeNull();
  });

  release();

  // Still closed, a tick later.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByTestId("issue-panel")).toBeNull();
});

test("the way out to Jira sits on the tab row, not in the status line", async () => {
  /*
    Two separate things. The line under the heading states what the ticket is
    — status, then the type qualifying it — and carries no controls. The way
    out to Jira is a control, so it joins the tabs, pinned to the right edge
    where this app puts the action a surface offers.
  */
  vi.stubGlobal("fetch", routedFetch());
  renderBoard();
  await screen.findByTestId("backlog-preview");

  await userEvent.click(screen.getByText("Ticket 1"));
  await screen.findByTestId("issue-detail");

  const link = screen.getByRole("link", { name: /open in jira/i });
  // A peer of the tabs: same row, and the row pins it to the far edge.
  const row = link.parentElement;
  expect(row?.className).toContain("justify-between");
  expect(within(row as HTMLElement).getByRole("tablist")).toBeDefined();

  // Opens Jira in its own tab, without handing it this page's opener.
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
});

// ---- how old a ticket is --------------------------------------------------

test("a ticket raised today says so, rather than counting zero days", async () => {
  // "0d" was the one value in this column that read as a missing number
  // instead of an age: the rest of the scale counts upward from it, so
  // nothing else in the list makes a zero legible as a quantity.
  const today = new Date().toISOString();
  vi.stubGlobal(
    "fetch",
    routedFetch({
      preview: {
        body: {
          boardId: "jrb_1",
          source: "backlog",
          jql: "",
          issues: [issue(1, today)],
        },
      },
    }),
  );
  renderBoard();

  const list = await screen.findByTestId("backlog-preview");
  expect(within(list).getByText("Today")).toBeDefined();
  expect(within(list).queryByText("0d")).toBeNull();
});

test("an older ticket still counts in days and years", async () => {
  // The boundary above is the only special case; the scale itself is intact.
  const days = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString();
  vi.stubGlobal(
    "fetch",
    routedFetch({
      preview: {
        body: {
          boardId: "jrb_1",
          source: "backlog",
          jql: "",
          issues: [issue(1, days(1)), issue(2, days(40)), issue(3, days(800))],
        },
      },
    }),
  );
  renderBoard();

  const list = await screen.findByTestId("backlog-preview");
  expect(within(list).getByText("1d")).toBeDefined();
  expect(within(list).getByText("40d")).toBeDefined();
  expect(within(list).getByText("2y 2m")).toBeDefined();
});
