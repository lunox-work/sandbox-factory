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

import { Jira } from "../src/Jira";

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

function renderPage(role = "owner") {
  return render(
    <Jira organizationId="org_1" organizationName="Acme" role={role} />,
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

test("a plain member gets no connect or disconnect control", async () => {
  // Courtesy, not security: the API checks the role again on every write.
  renderPage("member");

  expect(await screen.findByText("Acme")).toBeDefined();
  expect(screen.queryByRole("button", { name: /^connect/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /^disconnect/i })).toBeNull();
  expect(screen.getByText(/only an owner or admin/i)).toBeDefined();
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

test("disconnecting asks the API and reloads the list", async () => {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return Promise.resolve(
        init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ connections: [connection] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      );
    }),
  );

  renderPage();
  await screen.findByText("Acme");

  await userEvent.click(
    screen.getByRole("button", { name: /disconnect acme/i }),
  );

  await waitFor(() => {
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  });
  // The list is re-read afterwards, so a failed delete cannot leave a stale row.
  // Counted by route rather than by verb: the page also lists boards on load,
  // and a bare GET count would pass or fail on an unrelated call.
  await waitFor(() => {
    expect(
      calls.filter(
        (call) => call.method === "GET" && call.url.endsWith("/connections"),
      ),
    ).toHaveLength(2);
  });
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
 * The page now makes three different calls, and answering them all with the
 * same body is how a test passes while the page is broken.
 */
function routedFetch(
  overrides: {
    boards?: { status?: number; body?: unknown };
    remote?: { status?: number; body?: unknown };
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
    if (url.includes("/connections/") && url.endsWith("/boards")) {
      const spec = overrides.remote;
      return json(
        spec?.body ?? {
          boards: [
            { id: 42, name: "Acme Board", type: "scrum", projectKey: "ACME" },
            { id: 43, name: "Other Board", type: "kanban", projectKey: "OTH" },
          ],
        },
        spec?.status ?? 200,
      );
    }
    if (url.endsWith("/jira/boards")) {
      const spec = overrides.boards;
      return json(spec?.body ?? { boards: [board] }, spec?.status ?? 200);
    }
    return json({ connections: [connection] });
  });
}

test("a registered board is listed with its type and project", async () => {
  vi.stubGlobal("fetch", routedFetch());

  renderPage();

  expect(await screen.findByText("Acme Board")).toBeDefined();
  expect(screen.getByText(/scrum · ACME/i)).toBeDefined();
});

test("previewing a board shows its oldest tickets in a dialog", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderPage();
  await screen.findByText("Acme Board");

  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /preview/i }));

  const dialog = await screen.findByRole("dialog");
  const preview = within(dialog).getByTestId("backlog-preview");
  // The ordering is the product's claim about which work is worth a bounty.
  const keys = within(preview)
    .getAllByText(/^ACME-\d+$/)
    .map((node) => node.textContent);
  expect(keys).toEqual(["ACME-1", "ACME-2"]);
  expect(within(dialog).getByText("Ticket 1")).toBeDefined();
});

test("a ticket opens its full detail in the same dialog", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderPage();
  await screen.findByText("Acme Board");
  await userEvent.click(screen.getByRole("button", { name: /preview/i }));
  const dialog = await screen.findByRole("dialog");

  await userEvent.click(within(dialog).getByText("Ticket 1"));

  const detail = await screen.findByTestId("issue-detail");
  // The spec tab is the one that opens, because the words are what a
  // reviewer is here for.
  expect(
    within(detail).getByText(/Establish the canonical data model/),
  ).toBeDefined();
  // One dialog, two views: the list is gone rather than stacked behind.
  expect(screen.queryByTestId("backlog-preview")).toBeNull();

  // The fields the list DTO does not carry are on the other tab.
  await userEvent.click(within(detail).getByRole("tab", { name: /fields/i }));
  const fields = within(detail).getByTestId("issue-fields");
  expect(within(fields).getByText("charlie angriawan")).toBeDefined();
  expect(within(fields).getByText("Highest")).toBeDefined();
  expect(within(fields).getByText("foundation")).toBeDefined();
});

test("going back returns to the ticket list", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderPage();
  await screen.findByText("Acme Board");
  await userEvent.click(screen.getByRole("button", { name: /preview/i }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByText("Ticket 1"));
  await screen.findByTestId("issue-detail");

  await userEvent.click(
    screen.getByRole("button", { name: /back to the ticket list/i }),
  );

  expect(await screen.findByTestId("backlog-preview")).toBeDefined();
  expect(screen.queryByTestId("issue-detail")).toBeNull();
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
  renderPage();
  await screen.findByText("Acme Board");
  await userEvent.click(screen.getByRole("button", { name: /preview/i }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByText("Ticket 1"));

  const detail = await screen.findByTestId("issue-detail");
  await userEvent.click(within(detail).getByRole("tab", { name: /fields/i }));

  const fields = within(detail).getByTestId("issue-fields");
  expect(within(fields).queryByText("Reporter")).toBeNull();
  expect(within(fields).queryByText("Resolution")).toBeNull();
  expect(within(fields).queryByText("Labels")).toBeNull();
  // Assignee still shows, because "Unassigned" is information.
  expect(within(fields).getByText("Unassigned")).toBeDefined();
});

test("the preview says nothing was stored", async () => {
  // The promise the page makes: looking at a board is not pricing it.
  vi.stubGlobal("fetch", routedFetch());
  renderPage();
  await screen.findByText("Acme Board");

  await userEvent.click(screen.getByRole("button", { name: /preview/i }));

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/nothing was stored/i)).toBeDefined();
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
  renderPage();
  await screen.findByText("Acme Board");

  await userEvent.click(screen.getByRole("button", { name: /preview/i }));

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
  renderPage();
  await screen.findByText("Acme Board");

  await userEvent.click(screen.getByRole("button", { name: /preview/i }));

  expect(await screen.findByText(/expired or been revoked/i)).toBeDefined();
});

test("the board picker opens in a dialog", async () => {
  // A choice to make and dismiss, not part of the page's own content.
  vi.stubGlobal("fetch", routedFetch());
  renderPage();
  await screen.findByText("Acme Board");

  expect(screen.queryByRole("dialog")).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: /add a board/i }));

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/Other Board/)).toBeDefined();
});

test("adding a board registers it against the site it was listed from", async () => {
  // Reading the connection from the list instead would attach the board to
  // whichever site happened to be first.
  const fetchMock = routedFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderPage();
  await screen.findByText("Acme Board");

  await userEvent.click(screen.getByRole("button", { name: /add a board/i }));
  const dialog = await screen.findByRole("dialog");
  const rows = within(dialog).getAllByRole("button", { name: /^add$/i });
  await userEvent.click(rows[rows.length - 1] as HTMLElement);

  const post = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );
  expect(post).toBeDefined();
  expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
    connectionId: "jrc_1",
    externalId: "43",
  });
});

test("the dialog closes once a board has been added", async () => {
  // Leaving it open invites adding the same board twice.
  vi.stubGlobal("fetch", routedFetch());
  renderPage();
  await screen.findByText("Acme Board");

  await userEvent.click(screen.getByRole("button", { name: /add a board/i }));
  const dialog = await screen.findByRole("dialog");
  const rows = within(dialog).getAllByRole("button", { name: /^add$/i });
  await userEvent.click(rows[rows.length - 1] as HTMLElement);

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("a board already registered cannot be added twice", async () => {
  vi.stubGlobal("fetch", routedFetch());
  renderPage();
  await screen.findByText("Acme Board");

  await userEvent.click(screen.getByRole("button", { name: /add a board/i }));
  const dialog = await screen.findByRole("dialog");

  // 42 is already registered, so its control reads "Added" and is disabled.
  const added = within(dialog).getByRole("button", { name: /^added$/i });
  expect(added).toBeDefined();
  expect((added as HTMLButtonElement).disabled).toBe(true);
});

test("a plain member sees boards but cannot add one", async () => {
  vi.stubGlobal("fetch", routedFetch());

  renderPage("member");

  expect(await screen.findByText("Acme Board")).toBeDefined();
  expect(screen.queryByRole("button", { name: /add a board/i })).toBeNull();
  // Previewing is a read of tickets the organization already has a grant for.
  expect(screen.getByRole("button", { name: /preview/i })).toBeDefined();
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
  renderPage();
  await screen.findByText("Acme Board");

  await userEvent.click(screen.getByRole("button", { name: /preview/i }));

  expect(await screen.findByTestId("jira-scope-error")).toBeDefined();
  expect(screen.getByText(/scope list/i)).toBeDefined();
  expect(screen.queryByText(/expired or been revoked/i)).toBeNull();
});

test("the description renders as markdown, not as literal hashes", async () => {
  // `adfToText` hands over Markdown; showing it raw makes a spec a wall of
  // `#` and `|`, which is exactly what a reviewer cannot read.
  vi.stubGlobal("fetch", routedFetch());
  renderPage();
  await screen.findByText("Acme Board");
  await userEvent.click(screen.getByRole("button", { name: /preview/i }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByText("Ticket 1"));

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
  renderPage();
  await screen.findByText("Acme Board");
  await userEvent.click(screen.getByRole("button", { name: /preview/i }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByText("Ticket 1"));

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
  const { container } = renderPage();
  await screen.findByText("Acme Board");

  const main = container.querySelector("main");
  expect(main).not.toBeNull();
  expect(main?.className).toContain("py-10");
  expect(main?.className).toContain("sm:py-14");
});
