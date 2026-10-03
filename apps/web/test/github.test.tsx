/**
 * The GitHub tab of an organization's settings.
 *
 * What it must get right: connecting is a navigation, not a fetch; every
 * outcome the callback can append is explained and then removed from the
 * URL; `pick` opens a picker that links only a free installation; a
 * repository is registered from what the installation can see; and a plain
 * member is offered nothing the API would refuse.
 *
 * The server is faked at `fetch`, routed by method and path.
 */

import { act, fireEvent, render, screen, waitFor, within } from "./render";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { GithubConnections } from "../src/Github";

const connection = {
  id: "ghc_1",
  installationId: "9",
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "selected",
  healthy: true,
  suspendedAt: null,
  uninstalledAt: null,
  settingsUrl: "https://github.com/organizations/acme/settings/installations/9",
  createdAt: "2026-10-01T00:00:00.000Z",
};

const registered = {
  id: "ghr_1",
  connectionId: "ghc_1",
  role: "source",
  externalId: "1",
  fullName: "acme/widgets",
  defaultBranch: "main",
  isPrivate: true,
  sizeKb: 120,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  pushedAt: "2026-10-01T00:00:00.000Z",
  lastSyncedAt: "2026-10-01T00:05:00.000Z",
  syncStatus: "ok",
  syncError: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

interface Server {
  connections: unknown[];
  repositories: unknown[];
  installationRepositories: unknown[];
  available: unknown[];
  failRegister?: boolean;
  failConnections?: boolean;
  /** The server has no GitHub App: every route answers 503 `unconfigured`. */
  unconfigured?: boolean;
  /** The registered list never answers, or fails. */
  holdRepositories?: boolean;
  failRepositories?: boolean;
  /** What the picker's listing answers instead, e.g. a lapsed grant. */
  availableFailure?: { status: number; body: unknown };
  /** What registering answers instead, e.g. the installation gone. */
  registerFailure?: { status: number; body: unknown };
  /** Disconnecting misses, as a connection deleted in another tab would. */
  disconnectMissing?: boolean;
}

let server: Server;
let calls: string[];
let assigned: string[];
let replaced: string[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  server = {
    connections: [connection],
    repositories: [registered],
    installationRepositories: [
      {
        externalId: "1",
        fullName: "acme/widgets",
        defaultBranch: "main",
        isPrivate: true,
        registeredId: "ghr_1",
      },
      {
        externalId: "2",
        fullName: "acme/gadgets",
        defaultBranch: "main",
        isPrivate: false,
        registeredId: null,
      },
    ],
    available: [
      {
        installationId: "9",
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        status: "free",
      },
      {
        installationId: "10",
        accountLogin: "beta",
        accountType: "Organization",
        repositorySelection: "all",
        status: "claimed",
      },
    ],
  };
  calls = [];
  assigned = [];
  replaced = [];

  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/o/acme/settings",
      search: "?connection=github",
      get href() {
        return "http://localhost/o/acme/settings?connection=github";
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
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input);
      calls.push(`${method} ${path}`);
      const base = "/api/v1/orgs/org_1/github";
      if (server.unconfigured === true) {
        return json(
          {
            error: "GitHub is not set up on this server.",
            code: "unconfigured",
          },
          503,
        );
      }
      if (method === "GET" && path === `${base}/connections`) {
        return server.failConnections === true
          ? json({ error: "nope" }, 500)
          : json({ connections: server.connections });
      }
      if (method === "GET" && path === `${base}/repositories`) {
        if (server.holdRepositories === true) {
          return new Promise<Response>(() => {});
        }
        if (server.failRepositories === true) {
          return json({ error: "nope" }, 500);
        }
        return json({ repositories: server.repositories });
      }
      if (method === "GET" && path === `${base}/connections/available`) {
        if (server.availableFailure !== undefined) {
          return json(
            server.availableFailure.body,
            server.availableFailure.status,
          );
        }
        return json({
          grant: { githubLogin: "dana", healthy: true },
          installations: server.available,
        });
      }
      if (method === "POST" && path === `${base}/connections`) {
        const { installationId } = JSON.parse(String(init?.body)) as {
          installationId: string;
        };
        server.available = server.available.map((entry) =>
          (entry as { installationId: string }).installationId ===
          installationId
            ? { ...(entry as object), status: "linked" }
            : entry,
        );
        return json({ connection }, 201);
      }
      if (
        method === "GET" &&
        path === `${base}/connections/ghc_1/repositories`
      ) {
        return json({ repositories: server.installationRepositories });
      }
      if (
        method === "POST" &&
        path === `${base}/connections/ghc_1/repositories`
      ) {
        if (server.failRegister === true) {
          return json({ error: "GitHub refused that request." }, 502);
        }
        if (server.registerFailure !== undefined) {
          return json(
            server.registerFailure.body,
            server.registerFailure.status,
          );
        }
        const { externalId } = JSON.parse(String(init?.body)) as {
          externalId: string;
        };
        const added = {
          ...registered,
          id: "ghr_2",
          externalId,
          fullName: "acme/gadgets",
          isPrivate: false,
        };
        server.repositories = [...server.repositories, added];
        server.installationRepositories = server.installationRepositories.map(
          (entry) =>
            (entry as { externalId: string }).externalId === externalId
              ? { ...(entry as object), registeredId: "ghr_2" }
              : entry,
        );
        return json({ repository: added }, 201);
      }
      if (
        method === "DELETE" &&
        path === `${base}/connections/ghc_1` &&
        server.disconnectMissing === true
      ) {
        return json({ error: "Not found" }, 404);
      }
      if (method === "DELETE" && path === `${base}/connections/ghc_1`) {
        server.connections = [];
        server.repositories = [];
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE" && path === `${base}/repositories/ghr_1`) {
        server.repositories = [];
        return new Response(null, { status: 204 });
      }
      return json({ error: "Not found" }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderTab(role = "owner") {
  return render(<GithubConnections organizationId="org_1" role={role} />);
}

function withOutcome(outcome: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/o/acme/settings",
      search: `?connection=github&github=${outcome}`,
      href: "",
    },
  });
}

async function openMenu(login = "acme") {
  const trigger = await screen.findByRole("button", {
    name: `${login} options`,
  });
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  return screen.findByRole("menu");
}

test("a linked account lists its repositories as rows, without sync columns", async () => {
  renderTab();

  expect(await screen.findByText("acme")).toBeDefined();
  const list = await screen.findByRole("list", {
    name: "Registered repositories",
  });
  expect(within(list).getByText("acme/widgets")).toBeDefined();
  expect(within(list).getByLabelText("Private")).toBeDefined();
  expect(within(list).queryByText("0123456")).toBeNull();
  expect(within(list).queryByText("Up to date")).toBeNull();
  expect(within(list).queryByText("main")).toBeNull();
});

async function openRepository() {
  fireEvent.click(await screen.findByRole("button", { name: /acme\/widgets/ }));
}

test("connect navigates to the API, carrying where to come back to", async () => {
  renderTab();

  fireEvent.click(
    await screen.findByRole("button", { name: "Connect another account" }),
  );

  expect(assigned).toHaveLength(1);
  const url = new URL(assigned[0] ?? "", "http://localhost");
  expect(url.pathname).toBe("/api/v1/orgs/org_1/github/connect");
  expect(url.searchParams.get("returnTo")).toBe(
    "/o/acme/settings?connection=github",
  );
  // Never fetched: `/connections` is a different route.
  expect(calls.some((call) => /\/connect(\?|$)/.test(call))).toBe(false);
});

test("a plain member can read but is offered nothing the API would refuse", async () => {
  renderTab("member");

  await screen.findByRole("list", { name: "Registered repositories" });
  expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add a repository" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  expect(
    screen.getByText("Only an owner or admin can connect GitHub."),
  ).toBeDefined();

  // The link is in the subtitle for everyone; the menu is for managers only.
  expect(
    screen.getByRole("link", {
      name: "https://github.com/organizations/acme",
    }),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "acme options" })).toBeNull();
});

test("a successful connection is announced, and the outcome stripped from the URL", async () => {
  withOutcome("connected");
  renderTab();

  const banner = await screen.findByTestId("github-outcome");
  expect(banner.getAttribute("role")).toBe("status");
  expect(within(banner).getByText("GitHub connected")).toBeDefined();
  expect(replaced).toEqual(["/o/acme/settings?connection=github"]);
});

test("a claimed installation is a warning that names nobody", async () => {
  withOutcome("claimed");
  renderTab();

  const banner = await screen.findByTestId("github-outcome");
  expect(banner.getAttribute("role")).toBe("status");
  expect(
    within(banner).getByText("Connected to another workspace"),
  ).toBeDefined();
});

test.each([
  ["not-visible", "That installation is not one you can see"],
  ["not-authorized", "That account is not yours to connect"],
  ["state", "That connection could not be verified"],
  ["forbidden", "You are no longer allowed to connect GitHub"],
  ["denied", "GitHub refused the authorization"],
  ["error", "Something went wrong"],
  ["something-new", "Something went wrong"],
])("the %s outcome is reported as a failure", async (outcome, title) => {
  withOutcome(outcome);
  renderTab();

  const banner = await screen.findByTestId("github-outcome");
  expect(banner.getAttribute("role")).toBe("alert");
  expect(within(banner).getByText(title)).toBeDefined();
});

test("an installation GitHub would not let us check is a warning", async () => {
  withOutcome("unavailable");
  renderTab();

  const banner = await screen.findByTestId("github-outcome");
  expect(banner.getAttribute("role")).toBe("status");
  expect(
    within(banner).getByText("GitHub would not let us use that installation"),
  ).toBeDefined();
});

test("a cancelled consent is not presented as an error, and can be dismissed", async () => {
  withOutcome("cancelled");
  renderTab();

  const banner = await screen.findByTestId("github-outcome");
  expect(banner.getAttribute("role")).toBe("status");
  fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByTestId("github-outcome")).toBeNull();
});

test("pick opens the picker, which links only a free installation", async () => {
  withOutcome("pick");
  renderTab();

  const picker = await screen.findByRole("region", {
    name: "Choose an account",
  });
  expect(await within(picker).findByText(/@dana can see it/)).toBeDefined();
  // Claimed elsewhere: said, but not offered, and not named.
  expect(within(picker).getByText("Another workspace")).toBeDefined();
  const connect = within(picker).getAllByRole("button", { name: "Connect" });
  expect(connect).toHaveLength(1);

  fireEvent.click(connect[0] as HTMLElement);

  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Choose an account" }),
    ).toBeNull();
  });
  expect(calls).toContain("POST /api/v1/orgs/org_1/github/connections");
  // The list is read again after linking.
  expect(
    calls.filter(
      (call) => call === "GET /api/v1/orgs/org_1/github/connections",
    ),
  ).toHaveLength(2);
});

test("a repository is registered from what the installation can see", async () => {
  renderTab();

  fireEvent.click(
    within(await openMenu()).getByRole("menuitem", {
      name: "Add a repository",
    }),
  );
  const picker = await screen.findByRole("region", {
    name: "Repositories this account can see",
  });
  // Already registered: says so rather than offering it again.
  expect(await within(picker).findByText("Registered")).toBeDefined();
  // And the page says what registering does and does not read.
  expect(within(picker).getByText(/Its contents are not read/)).toBeDefined();

  fireEvent.click(
    within(picker).getByRole("button", { name: "Register acme/gadgets" }),
  );

  const table = await screen.findByRole("list", {
    name: "Registered repositories",
  });
  expect(await within(table).findByText("acme/gadgets")).toBeDefined();
  expect(calls).toContain(
    "POST /api/v1/orgs/org_1/github/connections/ghc_1/repositories",
  );
  await waitFor(() => {
    expect(within(picker).getAllByText("Registered")).toHaveLength(2);
  });
});

test("a refused registration says why and registers nothing", async () => {
  server.failRegister = true;
  renderTab();

  fireEvent.click(
    within(await openMenu()).getByRole("menuitem", {
      name: "Add a repository",
    }),
  );
  const picker = await screen.findByRole("region", {
    name: "Repositories this account can see",
  });
  fireEvent.click(
    await within(picker).findByRole("button", {
      name: "Register acme/gadgets",
    }),
  );

  expect(
    await within(picker).findByText("GitHub refused that request."),
  ).toBeDefined();
  const table = screen.getByRole("list", { name: "Registered repositories" });
  expect(within(table).queryByText("acme/gadgets")).toBeNull();
});

test("disconnecting asks first, and says the App stays installed on GitHub", async () => {
  renderTab();

  const menu = await openMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Disconnect/ }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/stays installed on GitHub/)).toBeDefined();
  expect(
    within(dialog)
      .getByRole("link", { name: /installation.s settings/ })
      .getAttribute("href"),
  ).toBe(connection.settingsUrl);

  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

  expect(
    await screen.findByText("No GitHub accounts connected yet."),
  ).toBeDefined();
  expect(calls).toContain("DELETE /api/v1/orgs/org_1/github/connections/ghc_1");
});

test("removing a repository asks first", async () => {
  renderTab();

  await openRepository();
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove acme/widgets" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

  expect(
    await screen.findByText(
      "No repositories registered from this account yet.",
    ),
  ).toBeDefined();
});

test("an uninstalled account is flagged, and offers no registering", async () => {
  server.connections = [
    { ...connection, healthy: false, uninstalledAt: "2026-10-01T01:00:00Z" },
  ];
  server.repositories = [{ ...registered, syncStatus: "gone" }];
  renderTab();

  expect(await screen.findByText("Uninstalled")).toBeDefined();
  expect(await screen.findByText("acme/widgets")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Add a repository" })).toBeNull();
});

test("a repository that failed to sync shows the reason", async () => {
  server.repositories = [
    {
      ...registered,
      syncStatus: "error",
      syncError: "The repository has no commits yet.",
      headSha: null,
      lastSyncedAt: null,
    },
  ];
  renderTab();

  await openRepository();
  expect(
    await screen.findByText("The repository has no commits yet."),
  ).toBeDefined();
});

test("a failed load says so rather than rendering an empty list", async () => {
  server.failConnections = true;
  renderTab();

  expect(
    await screen.findByText("Could not load your GitHub connections."),
  ).toBeDefined();
});

test("a suspended account says to unsuspend it, not to reinstall", async () => {
  server.connections = [
    { ...connection, healthy: false, suspendedAt: "2026-10-01T01:00:00Z" },
  ];
  renderTab();

  expect(await screen.findByText("Suspended")).toBeDefined();
  expect(screen.getByText(/Unsuspend it in the installation/)).toBeDefined();
});

test("an account flagged for a refusal says it is checked again", async () => {
  // Neither uninstalled nor suspended: GitHub refused a request, and the
  // sweep's probe clears it when GitHub answers again.
  server.connections = [{ ...connection, healthy: false }];
  renderTab();

  expect(await screen.findByText("Needs attention")).toBeDefined();
  expect(screen.getByText(/We check again every few minutes/)).toBeDefined();
});

test("a server without the App says GitHub is not set up, with nothing to press", async () => {
  server.unconfigured = true;
  renderTab();

  expect(
    await screen.findByText(/GitHub is not set up on this server yet/),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("while the registered list loads, no card claims it is empty", async () => {
  server.holdRepositories = true;
  renderTab();

  expect(await screen.findByText("acme")).toBeDefined();
  expect(
    screen.queryByText("No repositories registered from this account yet."),
  ).toBeNull();
});

test("a failed registered list is said once, not as an empty one per card", async () => {
  server.failRepositories = true;
  renderTab();

  expect(
    await screen.findByText("Could not load the registered repositories."),
  ).toBeDefined();
  expect(
    screen.queryByText("No repositories registered from this account yet."),
  ).toBeNull();
});

test("the pick notice goes once the picker is answered or closed", async () => {
  withOutcome("pick");
  renderTab();

  const picker = await screen.findByRole("region", {
    name: "Choose an account",
  });
  expect(screen.getByTestId("github-outcome")).toBeDefined();
  fireEvent.click(within(picker).getByRole("button", { name: "Close" }));

  expect(screen.queryByTestId("github-outcome")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Choose an account" }),
  ).toBeNull();
});

test("the picker says which installations are not the person's, and offers an install", async () => {
  withOutcome("pick");
  server.available = [
    {
      installationId: "9",
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      status: "not-authorized",
    },
    {
      installationId: "10",
      accountLogin: "beta",
      accountType: "Organization",
      repositorySelection: "all",
      status: "unavailable",
    },
  ];
  renderTab();

  const picker = await screen.findByRole("region", {
    name: "Choose an account",
  });
  expect(await within(picker).findByText("Not yours to connect")).toBeDefined();
  expect(within(picker).getByText("Unavailable")).toBeDefined();
  expect(within(picker).queryByRole("button", { name: "Connect" })).toBeNull();

  fireEvent.click(
    within(picker).getByRole("button", {
      name: "Install the App on an account you manage",
    }),
  );
  // `withOutcome`'s location takes the assignment as a plain value.
  expect(window.location.href).toMatch(
    /^\/api\/v1\/orgs\/org_1\/github\/connect\?/,
  );
});

test("a lapsed authorization in the picker offers to connect again", async () => {
  withOutcome("pick");
  server.availableFailure = {
    status: 409,
    body: {
      error: "Your GitHub authorization has lapsed. Connect GitHub again.",
      code: "reconnect",
    },
  };
  renderTab();

  const picker = await screen.findByRole("region", {
    name: "Choose an account",
  });
  fireEvent.click(
    await within(picker).findByRole("button", {
      name: "Connect GitHub again",
    }),
  );

  expect(window.location.href).toMatch(
    /^\/api\/v1\/orgs\/org_1\/github\/connect\?/,
  );
});

test("an installation GitHub turned down mid-register re-reads the accounts", async () => {
  server.registerFailure = {
    status: 409,
    body: {
      error: "GitHub no longer lets us use this installation.",
      code: "unhealthy",
    },
  };
  renderTab();

  fireEvent.click(
    within(await openMenu()).getByRole("menuitem", {
      name: "Add a repository",
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Register acme/gadgets" }),
  );

  // The card's state is stale: the API has flagged it, so read it again.
  await waitFor(() => {
    expect(
      calls.filter(
        (call) => call === "GET /api/v1/orgs/org_1/github/connections",
      ),
    ).toHaveLength(2);
  });
  expect(
    screen.queryByRole("region", { name: "Repositories this account can see" }),
  ).toBeNull();
});

test("a 404 from the API is said in our words, not as Not found", async () => {
  server.disconnectMissing = true;
  renderTab();

  const menu = await openMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Disconnect" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

  expect(
    await within(dialog).findByText("Could not disconnect that account."),
  ).toBeDefined();
  expect(within(dialog).queryByText("Not found")).toBeNull();
});
