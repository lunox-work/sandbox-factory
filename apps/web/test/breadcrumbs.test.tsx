/**
 * Tests for the trail above each page.
 *
 * Two properties. The trail must describe the hierarchy rather than the
 * history: arriving at `/o/acme/jira` from a bookmark must still offer every
 * step up, because Back would leave the app. And the last crumb must not be a
 * link — a step that navigates to the page you are already on reads as a
 * broken control, and is the mistake this component is easiest to regress
 * into.
 *
 * `trailFor` is tested directly for the shapes, since driving the shell to
 * every screen to assert five lists would test the navigation twice over. The
 * rendering and the click-through are then tested through the real shell, with
 * the server faked at the `fetch` and auth-client boundary as in
 * `nav.test.tsx`.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { trailFor } from "../src/Breadcrumbs";

const useSession = vi.fn();

vi.mock("../src/auth", () => ({
  useSession: () => useSession(),
  signOut: vi.fn(),
  authClient: {
    listAccounts: () => Promise.resolve({ data: [] }),
    unlinkAccount: vi.fn(),
    linkSocial: vi.fn(),
    organization: {
      setActive: () => Promise.resolve({ data: {}, error: null }),
      acceptInvitation: vi.fn(),
      rejectInvitation: vi.fn(),
    },
  },
  PROVIDERS: [{ id: "google", label: "Continue with Google" }],
  signInWith: vi.fn(),
}));

vi.stubGlobal(
  "fetch",
  vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/jira/connections")) {
      return Promise.resolve(
        Response.json({
          connections: [
            {
              id: "jrc_1",
              cloudId: "cloud-1",
              siteUrl: "https://acme.atlassian.net",
              siteName: "lunox-work",
              email: null,
              healthy: true,
              scopes: [],
              createdAt: "2026-09-21T00:00:00.000Z",
            },
          ],
        }),
      );
    }
    if (url.includes("backlog-preview")) {
      return Promise.resolve(
        Response.json({
          boardId: "jrb_1",
          source: "backlog",
          jql: "",
          issues: [],
        }),
      );
    }
    if (url.includes("/jira/boards")) {
      return Promise.resolve(
        Response.json({
          boards: [
            {
              id: "jrb_1",
              connectionId: "jrc_1",
              externalId: "42",
              name: "Sprint Board",
              boardType: "scrum",
              projectKey: "ACME",
              selection: {},
              writebackEnabled: false,
              createdAt: "2026-09-21T00:00:00.000Z",
            },
          ],
        }),
      );
    }
    if (url.includes("/api/v1/me/emails")) {
      return Promise.resolve(Response.json({ emails: [] }));
    }
    if (url.includes("/api/v1/me/invitations")) {
      return Promise.resolve(Response.json({ invitations: [] }));
    }
    if (url.includes("/api/v1/me/orgs")) {
      return Promise.resolve(
        Response.json({
          organizations: [
            {
              id: "org_1",
              name: "Acme",
              slug: "acme",
              kind: "team",
              role: "owner",
            },
          ],
        }),
      );
    }
    if (url.includes("/members")) {
      return Promise.resolve(Response.json({ members: [] }));
    }
    if (url.includes("/api/v1/me")) {
      return Promise.resolve(
        Response.json({ user: { id: "user_1", username: "alice" } }),
      );
    }
    return Promise.resolve(Response.json({}));
  }),
);

/*
 * Radix's avatar constructs `new window.Image()` and waits for a load that
 * jsdom never performs. The rail renders one on every screen, so without this
 * the fallback never settles — see `nav.test.tsx`, where the same stub is
 * explained in full.
 */
vi.stubGlobal("Image", function FakeImage() {
  const element = document.createElement("img");
  Object.defineProperty(element, "complete", { value: true });
  Object.defineProperty(element, "naturalWidth", { value: 1 });
  let source = "";
  Object.defineProperty(element, "src", {
    get: () => source,
    set: (value: string) => {
      source = value;
      element.setAttribute("src", value);
      setTimeout(() => element.dispatchEvent(new Event("load")), 0);
    },
  });
  return element;
} as unknown as typeof Image);

const { App } = await import("../src/App");

const ACME = { name: "Acme", slug: "acme" };

/** The trail as it reads on screen, so a test names labels and not nodes. */
function labels(): string[] {
  const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
  return [...trail.querySelectorAll("li")].map((li) =>
    (li.textContent ?? "").trim(),
  );
}

beforeEach(() => {
  useSession.mockReturnValue({
    data: {
      user: {
        id: "user_1",
        name: "Alice Ang",
        email: "alice@example.test",
        image: null,
      },
    },
  });
  // Each test owns the path it renders under; the shell reads it once on
  // mount to decide the starting screen.
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

test("home has no trail", () => {
  // A lone crumb reading "Home" on the home screen is chrome, not navigation.
  expect(trailFor("home")).toEqual([]);
});

test("each screen's trail names every step above it", () => {
  expect(trailFor("account").map((c) => c.label)).toEqual(["Home", "Account"]);
  expect(trailFor("organizations").map((c) => c.label)).toEqual([
    "Home",
    "Organizations",
  ]);
  expect(trailFor("create-org").map((c) => c.label)).toEqual([
    "Home",
    "Organizations",
    "New organization",
  ]);
  expect(trailFor("org-settings", ACME).map((c) => c.label)).toEqual([
    "Home",
    "Organizations",
    "Acme",
  ]);
  // The deepest screen, and the one Back serves worst: two levels down, and
  // reachable directly by URL.
  expect(trailFor("org-jira", ACME).map((c) => c.label)).toEqual([
    "Home",
    "Organizations",
    "Acme",
    "Jira",
  ]);
  // One deeper still: a connected site, under Jira.
  expect(
    trailFor("org-jira-site", ACME, "lunox-work").map((c) => c.label),
  ).toEqual(["Home", "Organizations", "Acme", "Jira", "lunox-work"]);
});

test("a board is one step deeper, under the site it belongs to", () => {
  expect(
    trailFor("org-jira-board", ACME, "lunox-work", "Sprint Board", "jrc_1").map(
      (c) => c.label,
    ),
  ).toEqual([
    "Home",
    "Organizations",
    "Acme",
    "Jira",
    "lunox-work",
    "Sprint Board",
  ]);
});

test("the site crumb becomes a link on a board, and carries the site it names", () => {
  // On the site's own trail it was the page you were on, so it had no
  // destination. Here it is the way back up, and it needs the connection id
  // to navigate — the slug alone resolves to the list of sites.
  const trail = trailFor(
    "org-jira-board",
    ACME,
    "lunox-work",
    "Sprint Board",
    "jrc_1",
  );
  const site = trail.find((crumb) => crumb.label === "lunox-work");

  expect(site?.screen).toBe("org-jira-site");
  expect(site?.connectionId).toBe("jrc_1");
});

test("a board whose name has not arrived keeps its place in the trail", () => {
  expect(
    trailFor("org-jira-board", ACME, "lunox-work").map((c) => c.label),
  ).toEqual(["Home", "Organizations", "Acme", "Jira", "lunox-work", "Board"]);
});

test("the Jira crumb becomes a link on a site, which is the way back up", () => {
  // The site page carries no other way back to the list of sites.
  const trail = trailFor("org-jira-site", ACME, "lunox-work");
  const jira = trail.find((crumb) => crumb.label === "Jira");

  expect(jira?.screen).toBe("org-jira");
  expect(jira?.slug).toBe("acme");
});

test("a site whose name has not arrived keeps its place in the trail", () => {
  // Dropping the last crumb would mark Jira as the current page while a site
  // is on screen.
  expect(trailFor("org-jira-site", ACME).map((c) => c.label)).toEqual([
    "Home",
    "Organizations",
    "Acme",
    "Jira",
    "Site",
  ]);
});

test("an organization still loading is left out rather than guessed at", () => {
  /*
   * A crumb reading "Loading…" shifts the row under the cursor when the name
   * lands. The settings screen is the organization, so it has no trail to
   * show until the name arrives — ending it at "Organizations" would mark the
   * list as the current page while an organization is on screen. Jira names
   * itself, so only its middle crumb goes missing.
   */
  expect(trailFor("org-settings")).toEqual([]);
  expect(trailFor("org-jira").map((c) => c.label)).toEqual([
    "Home",
    "Organizations",
    "Jira",
  ]);
});

test("no trail ends in a step that goes nowhere", () => {
  /*
   * The regression this guards: the organization crumb is a link in the Jira
   * trail and the end of the settings trail, so it is the one place a screen
   * could be left on a terminal crumb — which renders a button that navigates
   * to the page already on screen.
   */
  const screens = [
    trailFor("account"),
    trailFor("organizations"),
    trailFor("create-org"),
    trailFor("org-settings", ACME),
    trailFor("org-jira", ACME),
    trailFor("org-settings"),
    trailFor("org-jira"),
    trailFor("org-jira-site", ACME, "lunox-work"),
    trailFor("org-jira-site"),
    trailFor("org-jira-board", ACME, "lunox-work", "Sprint Board", "jrc_1"),
    trailFor("org-jira-board"),
  ];

  for (const trail of screens) {
    expect(trail[trail.length - 1]?.screen).toBeUndefined();
  }
});

test("the page you are on is text, and every step above it is a button", async () => {
  window.history.replaceState(null, "", "/o/acme/settings");
  render(<App />);

  await waitFor(() => {
    expect(labels()).toEqual(["Home", "Organizations", "Acme"]);
  });

  const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
  const current = nav.querySelector("[aria-current='page']");
  expect(current?.textContent).toBe("Acme");
  expect(current?.tagName).toBe("SPAN");
  // Not a button: a click would navigate to the screen already showing.
  expect(screen.queryByRole("button", { name: "Acme" })).toBeNull();
  // The steps above it are, or the trail is decoration.
  expect(screen.getByRole("button", { name: "Organizations" })).toBeTruthy();
});

test("a deep link renders the whole trail", async () => {
  window.history.replaceState(null, "", "/o/acme/jira");
  render(<App />);

  await waitFor(() => {
    expect(labels()).toEqual(["Home", "Organizations", "Acme", "Jira"]);
  });
});

test("a deep link to one site resolves, and the trail names it", async () => {
  // `/o/:slug/jira/:id` is its own screen, so a bookmark or a reload lands on
  // the site rather than on the list above it.
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1");
  render(<App />);

  await waitFor(() => {
    expect(labels()).toEqual([
      "Home",
      "Organizations",
      "Acme",
      "Jira",
      "lunox-work",
    ]);
  });
});

test("the Jira crumb on a site goes back to the list of sites", async () => {
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1");
  render(<App />);

  // Waited on the organization crumb, not the Jira one. The Jira crumb is in
  // the trail before the organization list arrives — `trailFor` drops only
  // the middle crumb while it loads — so clicking on its appearance races the
  // load, and a crumb clicked without a slug falls back to /organizations.
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Acme" })).toBeTruthy();
  });

  fireEvent.click(screen.getByRole("button", { name: "Jira" }));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/acme/jira");
    expect(labels()).toEqual(["Home", "Organizations", "Acme", "Jira"]);
  });
});

test("a deep link to one board resolves, and the trail names every step", async () => {
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1/jrb_1");
  render(<App />);

  await waitFor(() => {
    expect(labels()).toEqual([
      "Home",
      "Organizations",
      "Acme",
      "Jira",
      "lunox-work",
      "Sprint Board",
    ]);
  });
});

test("the site crumb on a board goes back to that site, not the list", async () => {
  // The slug alone would resolve to /o/acme/jira, one level too high.
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1/jrb_1");
  render(<App />);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "lunox-work" })).toBeTruthy();
  });

  fireEvent.click(screen.getByRole("button", { name: "lunox-work" }));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/acme/jira/jrc_1");
  });
});

test("a crumb navigates up to the screen it names", async () => {
  window.history.replaceState(null, "", "/o/acme/jira");
  render(<App />);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Acme" })).toBeTruthy();
  });

  // Up one level, to the organization the crumb names — not back through
  // history, which a bookmarked arrival does not have.
  fireEvent.click(screen.getByRole("button", { name: "Acme" }));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/acme/settings");
    expect(labels()).toEqual(["Home", "Organizations", "Acme"]);
  });
});

test("the trail is a second landmark, named apart from the rail", async () => {
  window.history.replaceState(null, "", "/organizations");
  render(<App />);

  // Two navigation landmarks on one page have to be told apart by name, or a
  // screen reader announces "navigation" twice with no way to choose.
  await waitFor(() => {
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
  });
});
