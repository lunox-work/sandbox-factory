/**
 * Tests for the trail above each page.
 *
 * Two properties. The trail must describe the hierarchy rather than the
 * history: arriving at `/o/acme/jira/:site` from a bookmark must still offer every
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

import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
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
    "Workspaces",
  ]);
  expect(trailFor("create-org").map((c) => c.label)).toEqual([
    "Home",
    "Workspaces",
    "New workspace",
  ]);
  expect(trailFor("org-settings", ACME).map((c) => c.label)).toEqual([
    "Home",
    "Workspaces",
    "Acme",
  ]);
});

test("a board sits under Jira, with no step for its site", () => {
  // A site has no page of its own, so a crumb for it would lead nowhere new.
  expect(
    trailFor("org-jira-board", ACME, "Sprint Board").map((c) => c.label),
  ).toEqual(["Home", "Workspaces", "Acme", "Jira", "Sprint Board"]);
});

test("a board whose name has not arrived keeps its place in the trail", () => {
  // Dropping the last crumb would mark Jira as the current page while a board
  // is on screen.
  expect(trailFor("org-jira-board", ACME).map((c) => c.label)).toEqual([
    "Home",
    "Workspaces",
    "Acme",
    "Jira",
    "Board",
  ]);
});

test("the Jira crumb on a board leads to the Jira tab of settings", () => {
  // That tab is where every site's boards are listed now.
  const trail = trailFor("org-jira-board", ACME, "Sprint Board");
  const jira = trail.find((crumb) => crumb.label === "Jira");

  expect(jira?.screen).toBe("org-settings");
  expect(jira?.slug).toBe("acme");
  expect(jira?.connectionTab).toBe("jira");
});

test("an organization still loading is left out rather than guessed at", () => {
  /*
   * A crumb reading "Loading…" shifts the row under the cursor when the name
   * lands. The settings screen is the organization, so it has no trail to
   * show until the name arrives — ending it at "Organizations" would mark the
   * list as the current page while an organization is on screen. A board
   * names itself, so only its organization crumb goes missing.
   */
  expect(trailFor("org-settings")).toEqual([]);
  expect(trailFor("org-jira-board").map((c) => c.label)).toEqual([
    "Home",
    "Workspaces",
    "Jira",
    "Board",
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
    trailFor("org-settings"),
    trailFor("org-jira-board", ACME, "Sprint Board"),
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
    expect(labels()).toEqual(["Home", "Workspaces", "Acme"]);
  });

  const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
  const current = nav.querySelector("[aria-current='page']");
  expect(current?.textContent).toBe("Acme");
  expect(current?.tagName).toBe("SPAN");
  // Not a button: a click would navigate to the screen already showing.
  expect(screen.queryByRole("link", { name: "Acme" })).toBeNull();
  // The steps above it are, or the trail is decoration. Scoped to the trail,
  // so another landmark using the word cannot satisfy it.
  expect(within(nav).getByRole("link", { name: "Workspaces" })).toBeTruthy();
});

test("the old Jira page opens the Jira tab of the organization's settings", async () => {
  // A bookmark from before the list moved into settings. The outcome riding
  // on it is kept, or the return from Atlassian would lose its banner.
  window.history.replaceState(null, "", "/o/acme/jira?jira=cancelled");
  render(<App />);

  await waitFor(() => {
    expect(labels()).toEqual(["Home", "Workspaces", "Acme"]);
    expect(window.location.pathname).toBe("/o/acme/settings");
  });
  expect(
    await screen.findByRole("tab", { name: "Jira", selected: true }),
  ).toBeTruthy();
  expect(await screen.findByText(/connection cancelled/i)).toBeTruthy();
  // The outcome is read once and stripped; the tab stays named.
  await waitFor(() => {
    expect(window.location.search).toBe("?connection=jira");
  });
});

test("an old link to one site opens the Jira tab of settings", async () => {
  // A site has no page of its own any more; its boards are listed there.
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1");
  render(<App />);

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/acme/settings");
    expect(window.location.search).toBe("?connection=jira");
    expect(labels()).toEqual(["Home", "Workspaces", "Acme"]);
  });
  expect(
    await screen.findByRole("tab", { name: "Jira", selected: true }),
  ).toBeTruthy();
});

test("the Jira crumb on a board goes back to the list of sites", async () => {
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1/jrb_1");
  render(<App />);

  // Waited on the organization crumb, not the Jira one. The Jira crumb is in
  // the trail before the organization list arrives — `trailFor` drops only
  // the middle crumb while it loads — so clicking on its appearance races the
  // load, and a crumb clicked without a slug falls back to /organizations.
  await waitFor(() => {
    expect(screen.getByRole("link", { name: "Acme" })).toBeTruthy();
  });

  fireEvent.click(screen.getByRole("link", { name: "Jira" }));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/acme/settings");
    expect(window.location.search).toBe("?connection=jira");
    expect(labels()).toEqual(["Home", "Workspaces", "Acme"]);
  });
  expect(
    await screen.findByRole("tab", { name: "Jira", selected: true }),
  ).toBeTruthy();
});

test("a deep link to one board resolves, and the trail names every step", async () => {
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1/jrb_1");
  render(<App />);

  await waitFor(() => {
    expect(labels()).toEqual([
      "Home",
      "Workspaces",
      "Acme",
      "Jira",
      "Sprint Board",
    ]);
  });
});

test("a crumb navigates up to the screen it names", async () => {
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1/jrb_1");
  render(<App />);

  await waitFor(() => {
    expect(screen.getByRole("link", { name: "Acme" })).toBeTruthy();
  });

  // Up one level, to the organization the crumb names — not back through
  // history, which a bookmarked arrival does not have.
  fireEvent.click(screen.getByRole("link", { name: "Acme" }));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/acme/settings");
    expect(labels()).toEqual(["Home", "Workspaces", "Acme"]);
  });
});

test("the trail is a second landmark, named apart from the rail", async () => {
  window.history.replaceState(null, "", "/workspaces");
  render(<App />);

  // Two navigation landmarks on one page have to be told apart by name, or a
  // screen reader announces "navigation" twice with no way to choose.
  await waitFor(() => {
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
  });
});

// ---- the trail shares the page's column -----------------------------------
//
// The pages cap a padded `main` at `max-w-2xl`; the trail used to cap an `ol`
// inside a padded `nav`, which made its column 48px wider — the crumbs began
// where the padding did, one step left of every heading below them. Capping
// the same element as the pages is what aligns the two.

test("the trail is capped and padded on the same element as the page", async () => {
  window.history.replaceState(null, "", "/o/acme/settings");
  render(<App />);

  await waitFor(() => {
    expect(labels()).toEqual(["Home", "Workspaces", "Acme"]);
  });

  const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(nav.className).toContain("max-w-2xl");
  expect(nav.className).toContain("px-4");
  expect(nav.className).toContain("sm:px-6");
  // The list inside no longer carries a column of its own, or the two would
  // compound and the crumbs would sit inside the page's text.
  expect(nav.querySelector("ol")?.className).not.toContain("max-w-2xl");
});

test("a board's trail is as wide as the board page under it", async () => {
  // The board is the one `max-w-5xl` page. A `max-w-2xl` trail above it is
  // misaligned the other way — the crumbs sit ~150px right of the content.
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1/jrb_1");
  render(<App />);

  await waitFor(() => {
    expect(labels()).toEqual([
      "Home",
      "Workspaces",
      "Acme",
      "Jira",
      "Sprint Board",
    ]);
  });

  const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(nav.className).toContain("max-w-5xl");
  expect(nav.className).not.toContain("max-w-2xl");
});
