/**
 * Tests for the left rail and the account menu behind its avatar.
 *
 * Two properties. Reachability: every screen must be reachable from every
 * other, and the rail must say which one you are on — the account screen has
 * no back button, so a broken Home leaves a user stranded. And containment:
 * sign out and the version readout moved into the menu, so they must be absent
 * from the page until it is opened, and present once it is.
 *
 * The server is faked at the `fetch` and auth-client boundary, as in
 * `app.test.tsx`.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { EntityAvatar } from "../src/components/Avatar";

const useSession = vi.fn();
const signOut = vi.fn();

/** What `/api/v1/me/invitations` answers with; set per test. */
let pendingInvitations: unknown[] = [];
/** Organizations listed after Acme and Globex; set per test. */
let extraOrganizations: unknown[] = [];
/** What each organization's `/jira/boards` answers with; set per test. */
let boardsByOrganization: Record<string, unknown[]> = {};
const setActive = vi.fn((_input: unknown) =>
  Promise.resolve({ data: {}, error: null }),
);

vi.mock("../src/auth", () => ({
  useSession: () => useSession(),
  signOut: () => signOut(),
  authClient: {
    listAccounts: () => Promise.resolve({ data: [] }),
    unlinkAccount: vi.fn(),
    linkSocial: vi.fn(),
    organization: {
      setActive: (input: unknown) => setActive(input),
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
    const boards = /\/orgs\/([^/]+)\/jira\/boards$/.exec(url);
    if (boards !== null) {
      return Promise.resolve(
        Response.json({ boards: boardsByOrganization[boards[1]!] ?? [] }),
      );
    }
    if (url.includes("/jira/connections")) {
      // One site, on the first organization only, so the home screen has a
      // row that leads somewhere and the test can tell which owner it
      // carried.
      return Promise.resolve(
        Response.json({
          connections: url.includes("org_1")
            ? [
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
              ]
            : [],
        }),
      );
    }
    if (url.includes("/api/v1/me/emails")) {
      return Promise.resolve(Response.json({ emails: [] }));
    }
    if (url.includes("/api/v1/me/invitations")) {
      // Per-test, so the mark on the avatar can be checked both ways without
      // a second fake server.
      return Promise.resolve(
        Response.json({ invitations: pendingInvitations }),
      );
    }
    // One organization, so the switcher and the `/o/:slug` route have
    // something real to resolve against.
    if (url.includes("/api/v1/me/orgs")) {
      return Promise.resolve(
        Response.json({
          organizations: [
            { id: "org_1", name: "Acme", slug: "acme", role: "owner" },
            // A second one, so a test that opens it can tell "the clicked
            // organization" apart from "the first in the list".
            { id: "org_2", name: "Globex", slug: "globex", role: "member" },
            ...extraOrganizations,
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
 * Radix's avatar decides whether to show the picture or the fallback by
 * constructing `new window.Image()`, attaching listeners, and then reading
 * `complete` and `naturalWidth` off it. jsdom creates the object but never
 * fetches anything, so the wait never resolves and the picture never appears.
 *
 * The stub is a real jsdom `img` element — so `addEventListener` and the rest
 * of the DOM interface come for free — with the fetch faked: setting `src`
 * dispatches `load` on the next tick and reports a decoded 1x1 image, which is
 * the state Radix treats as loaded. `FAILING_IMAGE` dispatches `error`
 * instead, keeping the fallback-on-failure path reachable.
 *
 * Assigned to `window.Image`, not the bare global: that is the reference
 * Radix reads.
 */
const FAILING_IMAGE = "https://example.test/gone.png";

/**
 * The identicon `user_1` generates, as the single path `Identicon` draws.
 *
 * Pinned from `packages/shared`'s own golden vectors rather than recomputed
 * here: the point is to fail if this avatar stops being *that* person's.
 */
const IDENTICON_D =
  "M1 0h1v1h-1zM3 0h1v1h-1zM1 1h1v1h-1zM3 1h1v1h-1zM1 2h1v1h-1z" +
  "M3 2h1v1h-1zM0 3h1v1h-1zM1 3h1v1h-1zM2 3h1v1h-1zM3 3h1v1h-1z" +
  "M4 3h1v1h-1zM0 4h1v1h-1zM2 4h1v1h-1zM4 4h1v1h-1z";

vi.stubGlobal("Image", function FakeImage() {
  const element = document.createElement("img");

  // Radix reads both to decide whether a load actually produced an image.
  Object.defineProperty(element, "complete", { value: true });
  Object.defineProperty(element, "naturalWidth", { value: 1 });

  let source = "";
  Object.defineProperty(element, "src", {
    get: () => source,
    set: (value: string) => {
      source = value;
      element.setAttribute("src", value);
      setTimeout(() => {
        element.dispatchEvent(
          new Event(value === FAILING_IMAGE ? "error" : "load"),
        );
      }, 0);
    },
  });

  return element;
} as unknown as typeof Image);

const { App } = await import("../src/App");

/** The rail's controls, by the accessible name each one carries. */
const HOME = "Home";

/**
 * The rail's Home button specifically.
 *
 * Scoped to the "Main" landmark because the breadcrumb trail offers a Home
 * step of its own on every screen below home, and these tests are about the
 * rail — which one is marked current, and where its click lands. Two controls
 * named Home is not an ambiguity to a screen reader either, as long as they
 * sit in landmarks that are named apart; that is what `aria-label` on each
 * `nav` is for.
 */
function railHome(): HTMLElement {
  return within(screen.getByRole("navigation", { name: "Main" })).getByRole(
    "link",
    { name: HOME },
  );
}
const AVATAR = /Account and settings/;

function signedIn(image?: string | null) {
  useSession.mockReturnValue({
    data: {
      user: {
        id: "user_1",
        name: "Alice Ang",
        email: "alice@example.test",
        image,
      },
    },
  });
}

/**
 * Opens the avatar menu.
 *
 * Enter on the focused trigger rather than a click: Radix opens on either, and
 * userEvent's pointer emulation is several times slower in jsdom for no extra
 * coverage.
 */
/** The identicon an id draws, rendered on its own to compare against. */
function identiconPath(id: string): string | null | undefined {
  const { container, unmount } = render(
    <EntityAvatar id={id} shape="square" />,
  );
  const d = container.querySelector("path")?.getAttribute("d");
  unmount();
  return d;
}

/** The organization switcher's trigger, whichever organization is active. */
const SWITCHER = /^Switch workspace/;

/** Opens the switcher, once the active organization has loaded into it. */
async function openSwitcher() {
  const trigger = await screen.findByRole("button", {
    name: /^Switch workspace — /,
  });
  trigger.focus();
  // See `openMenu`: Radix focuses the menu in an effect after the open.
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  return await screen.findByRole("menu");
}

async function openMenu() {
  const trigger = screen.getByRole("button", { name: AVATAR });
  trigger.focus();
  /*
   * Inside `act` because Radix moves focus into the menu in an effect that
   * lands after the open itself. Leaving it outside lets that update fall
   * between assertions, which React reports as an un-acted update.
   */
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
}

beforeEach(() => {
  signedIn();
  signOut.mockClear();
  setActive.mockClear();
  pendingInvitations = [];
  extraOrganizations = [];
  boardsByOrganization = {};
  // Each test owns the path it renders under; `Signed` reads it once on mount
  // to decide the starting screen.
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  // The rail remembers whether it was expanded; no test inherits another's.
  window.localStorage.clear();
});

test("the rail offers home and the account avatar, with the switcher above them", () => {
  render(<App />);

  const rail = screen.getByRole("navigation", { name: "Main" });
  expect(within(rail).getByRole("button", { name: SWITCHER })).toBeTruthy();
  expect(railHome()).toBeTruthy();
  expect(screen.getByRole("button", { name: AVATAR })).toBeTruthy();
});

test("the home header carries no name or sign out", async () => {
  render(<App />);

  // Both moved into the avatar menu; neither is part of the work the page is
  // for. This is the header the screenshot asked for.
  expect(
    await screen.findByRole("heading", { name: "Connections" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
});

test("the version readout is in the menu, not on the page", async () => {
  render(<App />);

  // `v1.4.2` comes from the fixture in vitest.config.ts.
  expect(screen.queryByText("v1.4.2")).toBeNull();

  await openMenu();
  expect(screen.getByText("v1.4.2")).toBeTruthy();
});

test("the menu opens the account screen, and home comes back", async () => {
  render(<App />);
  expect(
    await screen.findByRole("heading", { name: "Connections" }),
  ).toBeTruthy();

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Account settings/ }));

  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
  });

  // The account screen has no back button of its own, so this click is the
  // only way out. If it stops working, the screen is a dead end.
  fireEvent.click(railHome());
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
  });
});

test("signing out from the menu calls signOut", async () => {
  render(<App />);
  await openMenu();

  fireEvent.click(screen.getByRole("menuitem", { name: /Sign out/ }));

  await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
});

test("the menu offers account and sign out, but not a second way home", async () => {
  render(<App />);
  await openMenu();

  expect(
    screen.getByRole("menuitem", { name: /Account settings/ }),
  ).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: /Sign out/ })).toBeTruthy();
  // Home lives in the rail. Two affordances for one screen invite the wrong
  // one, so the menu does not repeat it.
  expect(screen.queryByRole("menuitem", { name: /Home/ })).toBeNull();
});

test("the rail marks the screen you are on", async () => {
  render(<App />);

  expect(railHome()).toHaveProperty("ariaCurrent", "page");

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Account settings/ }));

  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
  });
  // Home is no longer current once the account screen is showing.
  expect(railHome().ariaCurrent).toBeNull();
});

test("/account opens the account screen directly", async () => {
  // A bookmark, a reload, or Better Auth sending the browser back after a
  // provider link: the path is what decides the screen.
  window.history.replaceState(null, "", "/account");
  render(<App />);

  expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();

  // `Account` loads itself on mount. Awaited so its state lands inside the
  // test rather than after it, which React reports as an act() warning.
  await waitFor(() => {
    expect(screen.getByText("@alice")).toBeTruthy();
  });
});

test("a trailing slash names the same screen", () => {
  window.history.replaceState(null, "", "/account/");
  render(<App />);

  expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
});

test("an unknown path falls back to the home screen", async () => {
  // Rather than a blank screen: the server serves index.html for any path, so
  // the app has to decide what a stale link means.
  window.history.replaceState(null, "", "/nope");
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "Connections" }),
  ).toBeTruthy();
});

test("navigating writes the path, so a reload stays put", async () => {
  render(<App />);
  expect(window.location.pathname).toBe("/");

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Account settings/ }));

  await waitFor(() => expect(window.location.pathname).toBe("/account"));

  fireEvent.click(railHome());
  expect(window.location.pathname).toBe("/");
});

test("the Back button returns to the previous screen", async () => {
  render(<App />);

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Account settings/ }));
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
  });

  /*
   * Each navigation is its own history entry, so Back has somewhere to go.
   * jsdom updates the URL on `back()` but does not dispatch `popstate`, so the
   * event is fired here — what is under test is that the app listens for it,
   * not jsdom's own history bookkeeping.
   */
  window.history.back();
  window.dispatchEvent(new PopStateEvent("popstate"));

  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
  });
});

test("the avatar shows the provider's picture when there is one", async () => {
  signedIn("https://example.test/alice.png");
  render(<App />);

  // `loadImage` (below) is what stands in for the network: Radix renders no
  // `img` at all until its own off-DOM probe reports the picture loaded, and
  // jsdom never fetches one. Without it this would assert against an avatar
  // still showing its fallback, which is the *next* test's case.
  const trigger = screen.getByRole("button", { name: AVATAR });
  await waitFor(() => {
    expect(trigger.querySelector("img")).not.toBeNull();
  });

  const img = trigger.querySelector("img");
  expect(img?.getAttribute("src")).toBe("https://example.test/alice.png");
  // No referrer: the provider's CDN does not need to know who is on this app.
  expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
});

test("an account with no picture falls back to its identicon", async () => {
  signedIn(null);
  render(<App />);

  // Radix renders the fallback asynchronously, after it has checked for an
  // image to load.
  const trigger = screen.getByRole("button", { name: AVATAR });
  await waitFor(() => {
    expect(trigger.querySelector("svg")).not.toBeNull();
  });

  // The grid generated for `user_1` and nothing else: a pinned path is what
  // catches the avatar being seeded with the wrong value — a name, a handle,
  // or an id from the wrong entity would all still render *a* grid.
  expect(trigger.querySelector("path")?.getAttribute("d")).toBe(IDENTICON_D);
  expect(trigger.querySelector("img")).toBeNull();
});

test("an account whose picture 404s falls back to its identicon", async () => {
  // The case the fallback exists for: providers hand out avatar URLs that go
  // stale, and Radix keeps the fallback when the load fails.
  signedIn(FAILING_IMAGE);
  render(<App />);

  const trigger = screen.getByRole("button", { name: AVATAR });
  await waitFor(() => {
    expect(trigger.querySelector("path")?.getAttribute("d")).toBe(IDENTICON_D);
  });
  expect(trigger.querySelector("img")).toBeNull();
});

// ---- organization screens -------------------------------------------------

test("/o/:slug/settings opens that organization directly", async () => {
  // A shared link, or the return from a rename. Without this the path falls
  // through to the home screen and the link looks broken.
  window.history.replaceState(null, "", "/o/acme/settings");
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "Acme", level: 1 }),
  ).toBeTruthy();
  await waitFor(() => {
    expect(screen.getByText("acme")).toBeTruthy();
  });
});

test("a trailing slash names the same organization screen", async () => {
  window.history.replaceState(null, "", "/o/acme/settings/");
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "Acme", level: 1 }),
  ).toBeTruthy();
});

test("an unavailable organization route stays unavailable and links to the list", async () => {
  window.history.replaceState(null, "", "/o/missing/settings");
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "Workspace unavailable" }),
  ).toBeTruthy();
  const destination = screen.getByRole("link", {
    name: "View your workspaces",
  });
  expect(destination.getAttribute("href")).toBe("/workspaces");

  fireEvent.click(destination);
  expect(window.location.pathname).toBe("/workspaces");
});

test("the document title follows the current page", async () => {
  render(<App />);
  expect(document.title).toBe("Home · Lunox");

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Account settings/ }));

  await waitFor(() => expect(document.title).toBe("Account · Lunox"));
});

test("only /o/... names an organization, not any two-segment path", async () => {
  // The parser requires the literal `o` in the first segment. Without that
  // check *every* unrecognised two-segment path — `/settings/profile`,
  // `/reports/weekly` — reads as an organization handle, and the stale-link
  // fallback to the home screen stops working for all of them.
  window.history.replaceState(null, "", "/settings/profile");
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "Connections" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Edit workspace handle" }),
  ).toBeNull();
});

test("/workspaces/new opens the create form", async () => {
  window.history.replaceState(null, "", "/workspaces/new");
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "New workspace" }),
  ).toBeTruthy();
});

test("an old /organizations link still opens its page, under the new path", async () => {
  // Bookmarks and links in old messages predate the rename. They land on the
  // same page, and the address bar is brought up to date without adding a
  // history entry.
  for (const [legacy, current, heading] of [
    ["/organizations", "/workspaces", "Workspaces"],
    ["/organizations/new", "/workspaces/new", "New workspace"],
  ] as const) {
    window.history.replaceState(null, "", `${legacy}?x=1`);
    const before = window.history.length;
    const { unmount } = render(<App />);

    expect(
      await screen.findByRole("heading", { name: heading, level: 1 }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(current);
    expect(window.location.search).toBe("?x=1");
    expect(window.history.length).toBe(before);
    unmount();
  }
});

test("the account menu reaches the organizations page", async () => {
  // One item, not a switcher: the list is a page because it carries names,
  // handles and roles, and the actions on a row need room beside them.
  render(<App />);

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Workspaces/ }));

  expect(
    await screen.findByRole("heading", { name: "Workspaces", level: 1 }),
  ).toBeTruthy();
  expect(window.location.pathname).toBe("/workspaces");
});

test("the menu no longer switches organization", async () => {
  // Switching is deliberately absent while nothing the app renders belongs to
  // an organization: a control that only moved a tick read as broken.
  render(<App />);

  await openMenu();

  expect(screen.queryByRole("menuitem", { name: /^Acme/ })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /Personal/ })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /New workspace/ })).toBeNull();
});

test("the organizations page lists what you belong to, with your role", async () => {
  window.history.replaceState(null, "", "/workspaces");
  render(<App />);

  // Scoped to the page: the switcher at the head of the rail names the
  // active organization too.
  const page = await screen.findByRole("main");
  expect(await within(page).findByText("Acme")).toBeTruthy();
  expect(screen.getByText("@acme")).toBeTruthy();
  expect(screen.getByText("owner")).toBeTruthy();
});

test("a row opens that organization's settings", async () => {
  // Deliberately the *second* row: opening the first would pass even if the
  // path were built from whichever organization happened to be active, which
  // is the bug — `select` has not re-rendered when `navigate` runs.
  window.history.replaceState(null, "", "/workspaces");
  render(<App />);

  fireEvent.click(await screen.findByRole("link", { name: /Globex/ }));

  expect(
    await screen.findByRole("heading", { name: "Globex", level: 1 }),
  ).toBeTruthy();
  // The URL names the organization, so the link is shareable and a reload
  // lands back on it.
  expect(window.location.pathname).toBe("/o/globex/settings");
});

test("the organizations page reaches the create form", async () => {
  window.history.replaceState(null, "", "/workspaces");
  render(<App />);

  fireEvent.click(await screen.findByRole("link", { name: /New workspace/ }));

  expect(
    await screen.findByRole("heading", { name: "New workspace" }),
  ).toBeTruthy();
});

// ---- the rail answers the cursor ------------------------------------------

test("an inactive destination lights up under the cursor", async () => {
  // `sm:hover:bg-transparent` cancelled the hover fill at exactly the widths
  // the rail exists at, so the only rail button gave no feedback at all.
  window.history.replaceState(null, "", "/account");
  render(<App />);

  // Scoped to the rail: the trail above the page carries a "Home" crumb too,
  // and on this screen both are on the page at once.
  const rail = await screen.findByRole("navigation", { name: "Main" });
  const home = within(rail).getByRole("link", { name: "Home" });
  expect(home.className).toContain("hover:bg-accent");
  expect(home.className).not.toContain("sm:hover:bg-transparent");
});

test("the switcher answers the cursor too", async () => {
  window.history.replaceState(null, "", "/");
  render(<App />);

  const switcher = await screen.findByRole("button", { name: SWITCHER });
  expect(switcher.className).toContain("hover:bg-accent");
});

test("a site on the home screen opens its organization's Jira tab", async () => {
  // End to end through the shell: a site has no page of its own, so the row
  // leads to where its boards are listed.
  window.history.replaceState(null, "", "/");
  render(<App />);

  await waitFor(() => {
    expect(screen.getByText("lunox-work")).toBeTruthy();
  });
  fireEvent.click(screen.getByText("lunox-work"));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/acme/settings");
    expect(window.location.search).toBe("?connection=jira");
  });
});

function board(id: string, name: string) {
  return {
    id,
    connectionId: "jrc_1",
    externalId: `ext-${id}`,
    name,
    boardType: "scrum",
    projectKey: null,
    selection: {},
    createdAt: "2026-09-21T00:00:00.000Z",
  };
}

/** The home screen's board picker, named for the board it is showing. */
async function homeBoard(name: string) {
  return screen.findByRole("button", { name: `Switch board — ${name}` });
}

test("home opens on the organization's board, not the connections list", async () => {
  // The proposals are the work; the list of sites is one step removed from
  // them. With no board opened yet, the first one is where home lands.
  boardsByOrganization = {
    org_1: [board("jrb_1", "Delivery"), board("jrb_2", "Platform")],
  };
  render(<App />);

  expect(await homeBoard("Delivery")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Connections" })).toBeNull();
  expect(window.location.pathname).toBe("/");
});

test("home greets the person rather than titling the board", async () => {
  // Home is where the day starts, not a board somebody navigated to: the
  // board is named in the picker, and the heading is the greeting.
  boardsByOrganization = { org_1: [board("jrb_1", "Delivery")] };
  render(<App />);

  const heading = await screen.findByRole("heading", { level: 1 });
  expect(heading.textContent).toMatch(
    /^Good (morning|afternoon|evening), Alice$/,
  );
  expect(screen.queryByRole("heading", { name: "Delivery" })).toBeNull();
});

test("home comes back to the board last opened", async () => {
  boardsByOrganization = {
    org_1: [board("jrb_1", "Delivery"), board("jrb_2", "Platform")],
  };
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1/jrb_2");
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Platform" })).toBeTruthy();

  fireEvent.click(railHome());

  await waitFor(() => expect(window.location.pathname).toBe("/"));
  expect(await homeBoard("Platform")).toBeTruthy();
});

test("the picker switches home's board and remembers it", async () => {
  boardsByOrganization = {
    org_1: [board("jrb_1", "Delivery"), board("jrb_2", "Platform")],
  };
  const { unmount } = render(<App />);

  const trigger = await homeBoard("Delivery");
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Platform/ }));

  expect(await homeBoard("Platform")).toBeTruthy();
  expect(window.location.pathname).toBe("/");

  // A reload lands on the one chosen, not back on the first.
  unmount();
  render(<App />);
  expect(await homeBoard("Platform")).toBeTruthy();
});

test("the picker leads out to the board's own page", async () => {
  // Home has no trail, so this is how the board's page and its site are
  // reached from here.
  boardsByOrganization = { org_1: [board("jrb_1", "Delivery")] };
  render(<App />);

  const trigger = await homeBoard("Delivery");
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  const menu = await screen.findByRole("menu");
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: /Open board page/ }),
  );

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/acme/jira/jrc_1/jrb_1");
  });
  expect(await screen.findByRole("heading", { name: "Delivery" })).toBeTruthy();
});

test("a remembered board that is gone falls back to the first", async () => {
  // Removed since, or its site disconnected: opening it would be a page with
  // nothing behind it.
  window.localStorage.setItem(
    "lunox:home-board:user_1:org_1",
    JSON.stringify({ connectionId: "jrc_1", boardId: "jrb_gone" }),
  );
  boardsByOrganization = { org_1: [board("jrb_1", "Delivery")] };
  render(<App />);

  expect(await homeBoard("Delivery")).toBeTruthy();
});

test("switching organization moves home to that organization's board", async () => {
  boardsByOrganization = {
    org_1: [board("jrb_1", "Delivery")],
    org_2: [board("jrb_9", "Globex board")],
  };
  render(<App />);
  expect(await homeBoard("Delivery")).toBeTruthy();

  const menu = await openSwitcher();
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Globex/ }));

  expect(await homeBoard("Globex board")).toBeTruthy();
  expect(window.location.pathname).toBe("/");
});

test("cancelling a new organization goes back to the list, not home", async () => {
  // The trail says Organizations is the parent, and it is where the button
  // that opens this form lives.
  window.history.replaceState(null, "", "/workspaces/new");
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/workspaces");
  });
});

// ---- expanding and collapsing ----------------------------------------------

test("the rail starts expanded, collapses, and remembers it", async () => {
  const { unmount } = render(<App />);

  const rail = screen.getByRole("navigation", { name: "Main" });
  const toggle = within(rail).getByRole("button", { name: "Sidebar" });
  // Expanded, the label is written beside the icon, so there is no tooltip
  // repeating it.
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(railHome().getAttribute("title")).toBeNull();
  expect(within(rail).getByText("Home")).toBeTruthy();

  fireEvent.click(toggle);

  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  // Collapsed, only the icon is left: the tooltip is what names it.
  expect(railHome().getAttribute("title")).toBe("Home");
  expect(within(rail).queryByText("Home")).toBeNull();
  // Named the same in both states, so it is one control that changed.
  expect(railHome().getAttribute("aria-label")).toBe("Home");
  // The toggle stands in for the switcher, so the way back is always
  // showing. The switcher stays mounted to fade out, but inert: no focus, not
  // announced.
  expect(
    within(rail).getByRole("button", { name: SWITCHER }).hasAttribute("inert"),
  ).toBe(true);

  // A reload keeps the choice.
  unmount();
  render(<App />);
  expect(
    within(screen.getByRole("navigation", { name: "Main" }))
      .getByRole("button", { name: "Sidebar" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
});

test("the rail still renders when storage throws", () => {
  // A private window or blocked site data: the rail falls back to expanded
  // rather than taking the shell down with it.
  const getItem = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw new Error("blocked");
    });
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("blocked");
    });
  try {
    render(<App />);
    const toggle = within(
      screen.getByRole("navigation", { name: "Main" }),
    ).getByRole("button", { name: "Sidebar" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  } finally {
    getItem.mockRestore();
    setItem.mockRestore();
  }
});

// ---- the organization switcher --------------------------------------------

test("the switcher names the active organization and lists the rest", async () => {
  window.history.replaceState(null, "", "/o/acme/jira");
  render(<App />);

  expect(
    await screen.findByRole("button", { name: "Switch workspace — Acme" }),
  ).toBeTruthy();

  const menu = await openSwitcher();
  const acme = within(menu).getByRole("menuitem", { name: /Acme/ });
  // The one being shown is marked, and only that one.
  expect(acme.getAttribute("aria-current")).toBe("true");
  expect(
    within(menu)
      .getByRole("menuitem", { name: /Globex/ })
      .getAttribute("aria-current"),
  ).toBeNull();
});

test("a personal organization is called Personal, not by its name", async () => {
  // Its name is the person's own, which says whose it is but not what it is.
  extraOrganizations = [
    {
      id: "org_0",
      name: "Alice Example",
      slug: "alice",
      role: "owner",
      kind: "personal",
    },
  ];
  window.history.replaceState(null, "", "/o/alice/jira");
  render(<App />);

  expect(
    await screen.findByRole("button", {
      name: "Switch workspace — Personal",
    }),
  ).toBeTruthy();
  const menu = await openSwitcher();
  expect(within(menu).getByRole("menuitem", { name: "Personal" })).toBeTruthy();
  expect(within(menu).queryByText("Alice Example")).toBeNull();
});

test("the switcher shows a team's identicon, square, not the app's logo", async () => {
  window.history.replaceState(null, "", "/o/acme/jira");
  render(<App />);

  const trigger = await screen.findByRole("button", {
    name: "Switch workspace — Acme",
  });
  expect(trigger.querySelector("img[src*='logo-gradient']")).toBeNull();
  const face = trigger.querySelector('[data-slot="avatar"]');
  expect(face?.className).not.toContain("rounded-full");
  expect(face?.querySelector("path")?.getAttribute("d")).toBe(
    identiconPath("org_1"),
  );
});

test("the switcher shows your own face for your personal organization", async () => {
  // It is always the viewer's, so it wears their picture, round, as the
  // account page does — seeded from the user, not the organization.
  extraOrganizations = [
    {
      id: "org_0",
      name: "Alice Example",
      slug: "alice",
      role: "owner",
      kind: "personal",
    },
  ];
  window.history.replaceState(null, "", "/o/alice/jira");
  render(<App />);

  const trigger = await screen.findByRole("button", {
    name: "Switch workspace — Personal",
  });
  const face = trigger.querySelector('[data-slot="avatar"]');
  expect(face?.className).toContain("rounded-full");
  expect(face?.querySelector("path")?.getAttribute("d")).toBe(IDENTICON_D);
});

test("every organization in the switcher's menu carries its face", async () => {
  render(<App />);

  const menu = await openSwitcher();
  for (const [name, id] of [
    ["Acme", "org_1"],
    ["Globex", "org_2"],
  ] as const) {
    const item = within(menu).getByRole("menuitem", {
      name: new RegExp(name),
    });
    expect(item.querySelector("path")?.getAttribute("d")).toBe(
      identiconPath(id),
    );
  }
});

test("choosing another organization keeps you on the same screen in it", async () => {
  // Inside an organization, so the URL has to follow: a switch that changed
  // the page but left `/o/acme/...` in the address would reload to Acme.
  window.history.replaceState(null, "", "/o/acme/settings");
  render(<App />);

  const menu = await openSwitcher();
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Globex/ }));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/globex/settings");
  });
  expect(
    await screen.findByRole("button", { name: "Switch workspace — Globex" }),
  ).toBeTruthy();
});

test("switching away from a board lands on the new organization's Jira tab", async () => {
  // The board belongs to the old organization, so its id cannot follow; the
  // nearest screen the new one has is its own list of sites and boards.
  window.history.replaceState(null, "", "/o/acme/jira/jrc_1/jrb_1");
  render(<App />);

  const menu = await openSwitcher();
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Globex/ }));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/globex/settings");
    expect(window.location.search).toBe("?connection=jira");
  });
});

test("a switch outside any organization stays on that screen", async () => {
  window.history.replaceState(null, "", "/account");
  render(<App />);

  const menu = await openSwitcher();
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Globex/ }));

  expect(
    await screen.findByRole("button", { name: "Switch workspace — Globex" }),
  ).toBeTruthy();
  expect(window.location.pathname).toBe("/account");
});

test("the switcher's search narrows the list and keeps its keystrokes", async () => {
  render(<App />);

  const menu = await openSwitcher();
  const search = within(menu).getByRole("textbox", {
    name: "Search workspaces",
  });
  // Radix's typeahead would take a "g" and move focus to the item starting
  // with it; the field has to keep it.
  await waitFor(() => expect(document.activeElement).toBe(search));
  fireEvent.keyDown(search, { key: "g" });
  // Radix moves typeahead focus on a timer, so give it one to act on.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(document.activeElement).toBe(search);
  fireEvent.change(search, { target: { value: "glo" } });

  expect(within(menu).queryByRole("menuitem", { name: /Acme/ })).toBeNull();
  expect(within(menu).getByRole("menuitem", { name: /Globex/ })).toBeTruthy();

  fireEvent.change(search, { target: { value: "nothing like it" } });
  expect(within(menu).getByText("No workspaces match.")).toBeTruthy();
});

test("the switcher reaches the full list", async () => {
  render(<App />);

  const menu = await openSwitcher();
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "View all workspaces" }),
  );
  await waitFor(() => {
    expect(window.location.pathname).toBe("/workspaces");
  });
});

// ---- organizations, and what is waiting -----------------------------------

test("the rail has no organizations destination", () => {
  // The switcher at its head is where organizations are chosen; a second
  // way in beside it said the same thing twice.
  render(<App />);

  const rail = screen.getByRole("navigation", { name: "Main" });
  expect(within(rail).queryByRole("link", { name: "Workspaces" })).toBeNull();
});

test("home is not marked while you are inside an organization", async () => {
  window.history.replaceState(null, "", "/o/acme/jira");
  render(<App />);

  await screen.findByRole("button", { name: "Switch workspace — Acme" });
  expect(railHome().getAttribute("aria-current")).toBeNull();
});

test("the avatar is marked on the screens its menu leads to", async () => {
  // Account and the organizations list are reached from the avatar's menu;
  // without this the rail marks nothing while you are on them.
  for (const path of ["/account", "/workspaces", "/workspaces/new"]) {
    window.history.replaceState(null, "", path);
    const { unmount } = render(<App />);

    const avatar = await screen.findByRole("button", { name: AVATAR });
    expect(avatar.getAttribute("aria-current"), path).toBe("page");
    // The bare class, not `hover:bg-accent`, which every state carries.
    expect(avatar.className.split(/\s+/), path).toContain("bg-accent");
    // The fill alone: no border down its leading edge.
    expect(avatar.className, path).not.toMatch(/border-l/);
    expect(railHome().getAttribute("aria-current"), path).toBeNull();
    unmount();
  }
});

test("the avatar is not marked elsewhere", async () => {
  // Home is the rail's own; an organization's pages are the switcher's.
  for (const path of ["/", "/o/acme/jira"]) {
    window.history.replaceState(null, "", path);
    const { unmount } = render(<App />);

    const avatar = await screen.findByRole("button", { name: AVATAR });
    expect(avatar.getAttribute("aria-current"), path).toBeNull();
    expect(avatar.className.split(/\s+/), path).not.toContain("bg-accent");
    unmount();
  }
});

test("a pending invitation marks the avatar", async () => {
  // Nothing is emailed, so without a mark the only way to find an invitation
  // is to open Account and look.
  pendingInvitations = [
    {
      id: "inv_1",
      role: "member",
      organization: { id: "org_9", name: "Globex", slug: "globex" },
    },
  ];
  render(<App />);

  // The count is in the name, not only in the dot: a mark that is purely
  // colour says nothing to a screen reader.
  expect(
    await screen.findByRole("button", { name: /1 invitation/ }),
  ).toBeDefined();
});

test("no mark when nothing is waiting", async () => {
  render(<App />);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: AVATAR })).toBeTruthy();
  });
  expect(screen.queryByRole("button", { name: /invitation/ })).toBeNull();
});
