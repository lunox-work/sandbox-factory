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
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const useSession = vi.fn();
const signOut = vi.fn();

vi.mock("../src/auth", () => ({
  useSession: () => useSession(),
  signOut: () => signOut(),
  authClient: {
    listAccounts: () => Promise.resolve({ data: [] }),
    unlinkAccount: vi.fn(),
    linkSocial: vi.fn(),
  },
  PROVIDERS: [{ id: "google", label: "Continue with Google" }],
  signInWith: vi.fn(),
}));

vi.stubGlobal(
  "fetch",
  vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/v1/todos")) {
      return Promise.resolve(Response.json({ todos: [] }));
    }
    if (url.includes("/api/v1/me/emails")) {
      return Promise.resolve(Response.json({ emails: [] }));
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
  expect(screen.getByRole("button", { name: HOME })).toBeTruthy();
  expect(screen.getByRole("button", { name: AVATAR })).toBeTruthy();
});

test("the todo header carries no counts, name or sign out", () => {
  render(<App />);

  // All three moved: the counts are answered by the list, and the other two
  // live in the avatar menu. This is the header the screenshot asked for.
  expect(screen.queryByText(/active ·/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Todos" })).toBeTruthy();
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
  expect(screen.getByRole("heading", { name: "Todos" })).toBeTruthy();

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Account settings/ }));

  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
  });

  // The account screen has no back button of its own, so this click is the
  // only way out. If it stops working, the screen is a dead end.
  fireEvent.click(screen.getByRole("button", { name: HOME }));
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Todos" })).toBeTruthy();
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
  expect(screen.queryByRole("menuitem", { name: /Todos/ })).toBeNull();
});

test("the rail marks the screen you are on", async () => {
  render(<App />);

  expect(screen.getByRole("button", { name: HOME })).toHaveProperty(
    "ariaCurrent",
    "page",
  );

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Account settings/ }));

  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
  });
  // Home is no longer current once the account screen is showing.
  expect(screen.getByRole("button", { name: HOME }).ariaCurrent).toBeNull();
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
    expect(screen.getByLabelText("Username")).toHaveProperty("value", "alice");
  });
});

test("a trailing slash names the same screen", () => {
  window.history.replaceState(null, "", "/account/");
  render(<App />);

  expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
});

test("an unknown path falls back to the todo list", () => {
  // Rather than a blank screen: the server serves index.html for any path, so
  // the app has to decide what a stale link means.
  window.history.replaceState(null, "", "/nope");
  render(<App />);

  expect(screen.getByRole("heading", { name: "Todos" })).toBeTruthy();
});

test("navigating writes the path, so a reload stays put", async () => {
  render(<App />);
  expect(window.location.pathname).toBe("/");

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Account settings/ }));

  await waitFor(() => expect(window.location.pathname).toBe("/account"));

  fireEvent.click(screen.getByRole("button", { name: HOME }));
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
    expect(screen.getByRole("heading", { name: "Todos" })).toBeTruthy();
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

test("an account with no picture falls back to its initials", async () => {
  signedIn(null);
  render(<App />);

  // Radix renders the fallback asynchronously, after it has checked for an
  // image to load.
  const trigger = screen.getByRole("button", { name: AVATAR });
  await waitFor(() => {
    // Both words of "Alice Ang", which is what distinguishes two people whose
    // names start with the same letter.
    expect(trigger.textContent).toBe("AA");
  });
  expect(trigger.querySelector("img")).toBeNull();
});
