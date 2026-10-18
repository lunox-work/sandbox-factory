import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Leaving, SLOW_LEAVE_MS } from "../src/Leaving";
import { leaveFor, stopLeaving } from "../src/navigation/leave";
import { act, fireEvent, render, screen } from "./render";

const realLocation = window.location;
/** Where the page was sent. jsdom cannot navigate, so `href` is recorded. */
let assigned: string[] = [];

beforeEach(() => {
  assigned = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/o/acme/settings",
      search: "",
      hash: "",
      get href() {
        return "http://localhost/o/acme/settings";
      },
      set href(value: string) {
        assigned.push(value);
      },
    },
  });
});

afterEach(() => {
  // The leaving state is the module's, and outlives a test's render.
  act(() => stopLeaving());
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pageshow(persisted: boolean) {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

/** The app behind the cover, with the control that set it going. */
function renderApp() {
  render(
    <>
      <button type="button">Connect GitHub</button>
      <Leaving />
    </>,
  );
  const control = screen.getByRole("button", { name: "Connect GitHub" });
  control.focus();
  return control;
}

test("leaving for a provider covers the page until the browser goes, and back from its cache clears it", () => {
  const control = renderApp();
  expect(screen.queryByTestId("leaving")).toBeNull();

  act(() => leaveFor("/api/v1/orgs/org_1/github/connect", "GitHub"));
  expect(assigned).toEqual(["/api/v1/orgs/org_1/github/connect"]);
  const cover = screen.getByTestId("leaving");
  expect(cover.textContent).toContain("Opening GitHub…");

  // Nothing behind it can be reached: the app is inert, focus is on the cover.
  const app = control.closest("body > div");
  expect(app?.hasAttribute("inert")).toBe(true);
  expect(cover.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(cover);

  // A fresh load is a new page; only one restored as it was left says so.
  act(() => pageshow(false));
  expect(screen.getByTestId("leaving")).toBeTruthy();
  act(() => pageshow(true));
  expect(screen.queryByTestId("leaving")).toBeNull();
  expect(app?.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(control);
});

test("leaving for Jira says so", () => {
  renderApp();
  act(() => leaveFor("/api/v1/orgs/org_1/jira/connect", "Jira"));
  expect(screen.getByTestId("leaving").textContent).toContain("Opening Jira…");
  expect(screen.getByRole("dialog", { name: "Opening Jira" })).toBeTruthy();
});

test("a navigation that has not gone after a while offers the page back", () => {
  vi.useFakeTimers();
  const stop = vi.spyOn(window, "stop").mockImplementation(() => {});
  const control = renderApp();

  act(() => leaveFor("/api/v1/orgs/org_1/github/connect", "GitHub"));
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

  act(() => vi.advanceTimersByTime(SLOW_LEAVE_MS - 1));
  expect(screen.getByTestId("leaving").textContent).not.toContain("Still");
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByTestId("leaving").textContent).toContain(
    "Still opening GitHub…",
  );

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("leaving")).toBeNull();
  expect(document.activeElement).toBe(control);
});

test("Escape gives the page back at any point", () => {
  const stop = vi.spyOn(window, "stop").mockImplementation(() => {});
  renderApp();

  act(() => leaveFor("/api/v1/orgs/org_1/github/connect", "GitHub"));
  fireEvent.keyDown(screen.getByTestId("leaving"), { key: "Escape" });
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("leaving")).toBeNull();
});
