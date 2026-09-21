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

const useSession = vi.fn();
const signOut = vi.fn();

/** What `/api/v1/me/invitations` answers with; set per test. */
let pendingInvitations: unknown[] = [];
const setActive = vi.fn(() => Promise.resolve({ data: {}, error: null }));

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
  // Each test owns the path it renders under; `Signed` reads it once on mount
  // to decide the starting screen.
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

test("the rail offers home and the account avatar, with the logo above them", () => {
  render(<App />);

  const rail = screen.getByRole("navigation", { name: "Main" });
  expect(rail.querySelector("img[src*='logo-gradient']")).toBeTruthy();
  expect(railHome()).toBeTruthy();
  expect(screen.getByRole("button", { name: AVATAR })).toBeTruthy();
});

test("the home header carries no name or sign out", () => {
  render(<App />);

  // Both moved into the avatar menu; neither is part of the work the page is
  // for. This is the header the screenshot asked for.
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
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
  expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();

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

test("an unknown path falls back to the home screen", () => {
  // Rather than a blank screen: the server serves index.html for any path, so
  // the app has to decide what a stale link means.
  window.history.replaceState(null, "", "/nope");
  render(<App />);

  expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
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
    await screen.findByRole("heading", { name: "Organization unavailable" }),
  ).toBeTruthy();
  const destination = screen.getByRole("link", {
    name: "View your organizations",
  });
  expect(destination.getAttribute("href")).toBe("/organizations");

  fireEvent.click(destination);
  expect(window.location.pathname).toBe("/organizations");
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

  expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Edit organization handle" }),
  ).toBeNull();
});

test("/organizations/new opens the create form", async () => {
  window.history.replaceState(null, "", "/organizations/new");
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "New organization" }),
  ).toBeTruthy();
});

test("the account menu reaches the organizations page", async () => {
  // One item, not a switcher: the list is a page because it carries names,
  // handles and roles, and the actions on a row need room beside them.
  render(<App />);

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Organizations/ }));

  expect(
    await screen.findByRole("heading", { name: "Organizations", level: 1 }),
  ).toBeTruthy();
  expect(window.location.pathname).toBe("/organizations");
});

test("the menu no longer switches organization", async () => {
  // Switching is deliberately absent while nothing the app renders belongs to
  // an organization: a control that only moved a tick read as broken.
  render(<App />);

  await openMenu();

  expect(screen.queryByRole("menuitem", { name: /^Acme/ })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /Personal/ })).toBeNull();
  expect(
    screen.queryByRole("menuitem", { name: /New organization/ }),
  ).toBeNull();
});

test("the organizations page lists what you belong to, with your role", async () => {
  window.history.replaceState(null, "", "/organizations");
  render(<App />);

  expect(await screen.findByText("Acme")).toBeTruthy();
  expect(screen.getByText("@acme")).toBeTruthy();
  expect(screen.getByText("owner")).toBeTruthy();
});

test("a row opens that organization's settings", async () => {
  // Deliberately the *second* row: opening the first would pass even if the
  // path were built from whichever organization happened to be active, which
  // is the bug — `select` has not re-rendered when `navigate` runs.
  window.history.replaceState(null, "", "/organizations");
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
  window.history.replaceState(null, "", "/organizations");
  render(<App />);

  fireEvent.click(
    await screen.findByRole("link", { name: /New organization/ }),
  );

  expect(
    await screen.findByRole("heading", { name: "New organization" }),
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

test("the logo answers the cursor too", async () => {
  window.history.replaceState(null, "", "/");
  render(<App />);

  const logo = await screen.findByRole("link", { name: "Lunox home" });
  expect(logo.className).toContain("hover:opacity-80");
});

test("a site on the home screen opens that site's page", async () => {
  // End to end through the shell: the row names a site, so the URL it leads
  // to names that site rather than the list it sits in.
  window.history.replaceState(null, "", "/");
  render(<App />);

  await waitFor(() => {
    expect(screen.getByText("lunox-work")).toBeTruthy();
  });
  fireEvent.click(screen.getByText("lunox-work"));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/o/acme/jira/jrc_1");
  });
});

test("cancelling a new organization goes back to the list, not home", async () => {
  // The trail says Organizations is the parent, and it is where the button
  // that opens this form lives.
  window.history.replaceState(null, "", "/organizations/new");
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

  await waitFor(() => {
    expect(window.location.pathname).toBe("/organizations");
  });
});

// ---- organizations, and what is waiting -----------------------------------

test("the rail offers organizations as a destination", async () => {
  // It is the parent of most screens in this app and was reachable only
  // through the avatar menu.
  render(<App />);

  const rail = screen.getByRole("navigation", { name: "Main" });
  const button = within(rail).getByRole("link", { name: "Organizations" });
  fireEvent.click(button);

  await waitFor(() => {
    expect(window.location.pathname).toBe("/organizations");
  });
});

test("the rail marks organizations while you are inside one", async () => {
  // A rail that marks nothing while you are three levels into an
  // organization says you are nowhere.
  window.history.replaceState(null, "", "/o/acme/jira");
  render(<App />);

  const rail = screen.getByRole("navigation", { name: "Main" });
  await waitFor(() => {
    expect(
      within(rail)
        .getByRole("link", { name: "Organizations" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });
  // And not Home, which is a different destination.
  expect(railHome().getAttribute("aria-current")).toBeNull();
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
