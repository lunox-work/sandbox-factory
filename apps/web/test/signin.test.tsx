/**
 * Tests for the signed-out screen.
 *
 * As in `app.test.tsx`, the auth client is faked at the module boundary and
 * everything else is real, so these assert what actually reaches the screen:
 * the brand, a mark on every provider button, and that the wait after a click
 * is legible — the clicked button says so, and the others cannot be clicked
 * into a second, competing redirect.
 */

import { releaseTag } from "@sandbox-factory/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { TEST_BUILD } from "./build";

const signInWith = vi.fn();

vi.mock("../src/auth", () => ({
  PROVIDERS: [
    { id: "google", label: "Continue with Google" },
    { id: "github", label: "Continue with GitHub" },
    { id: "atlassian", label: "Continue with Atlassian" },
  ],
  signInWith: (provider: string) => signInWith(provider) as Promise<void>,
}));

// The build footer asks the API for its version; nothing here is about that.
vi.stubGlobal(
  "fetch",
  vi.fn(() => Promise.resolve(Response.json({}))),
);

const { SignIn } = await import("../src/SignIn");

beforeEach(() => {
  signInWith.mockReset();
});

afterEach(cleanup);

test("the screen is branded Lunox, with the tagline, and no longer says Todos", () => {
  render(<SignIn />);

  expect(screen.getByRole("heading", { name: "Lunox" })).toBeTruthy();
  expect(screen.getByText("See less, Build more")).toBeTruthy();
  expect(screen.queryByText(/todos/i)).toBeNull();
});

test("every provider button carries its mark", () => {
  render(<SignIn />);

  for (const name of [
    "Continue with Google",
    "Continue with GitHub",
    "Continue with Atlassian",
  ]) {
    const button = screen.getByRole("button", { name });
    expect(button.querySelector("svg")).not.toBeNull();
  }
});

test("clicking a provider starts sign-in, says so on that button, and locks the rest", async () => {
  // Never settles: a real sign-in ends in a navigation, not a resolution.
  signInWith.mockReturnValue(new Promise(() => {}));
  render(<SignIn />);

  await userEvent.click(
    screen.getByRole("button", { name: "Continue with GitHub" }),
  );

  expect(signInWith).toHaveBeenCalledWith("github");
  expect(screen.getByRole("button", { name: "Redirecting…" })).toBeTruthy();
  // The other two keep their labels — only the clicked one is relabelled —
  // but none of the three can be clicked again.
  expect(
    screen.getByRole("button", { name: "Continue with Google" }),
  ).toBeTruthy();
  for (const button of screen.getAllByRole("button")) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
});

test("a sign-in that fails to start shows an alert and gives the buttons back", async () => {
  signInWith.mockRejectedValue(new Error("network"));
  render(<SignIn />);

  await userEvent.click(
    screen.getByRole("button", { name: "Continue with Google" }),
  );

  await waitFor(() => {
    expect(screen.getByRole("alert")).toBeTruthy();
  });
  for (const button of screen.getAllByRole("button")) {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  }
});

/*
 * The build readout, which this screen showed only the version of.
 *
 * This is the one screen that cannot reach the avatar menu — there is no
 * avatar until someone signs in — and it is the screen where "which build is
 * this?" gets asked, because a broken sign-in is what prompts the question. So
 * it carries the same facts the menu does, not a subset.
 */
test("the screen shows the commit this bundle was built from, not just the version", () => {
  render(<SignIn />);

  expect(screen.getByText("v1.4.2")).toBeTruthy();
  const link = screen.getByText("7f3a9c1") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(
    `https://github.com/lunox-work/sandbox-factory/commit/${TEST_BUILD.gitSha}`,
  );
  // The full sha, the form a bug report or a provenance check needs.
  expect(link.getAttribute("title") ?? "").toContain(TEST_BUILD.gitSha);
});

/*
 * There is no menu here, so the links must be reachable as plain anchors.
 *
 * Wrapping them as `DropdownMenuItem`s — the menu's own arrangement — throws
 * outside a Radix `Menu`, so this pins that the wrapper stays opt-in.
 */
test("the commit link is a plain anchor, reachable without a menu around it", () => {
  render(<SignIn />);

  const link = screen.getByText("7f3a9c1");
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("role")).toBeNull();
});

// The fixture is a build of `main`, which is not a release.
test("no release notes link on a build that is not a tagged release", () => {
  render(<SignIn />);
  expect(screen.queryByText("Release notes")).toBeNull();
});

test("a tagged release build offers the release notes link", async () => {
  vi.resetModules();
  vi.doMock("../src/build", () => ({
    webBuild: { ...TEST_BUILD, gitRef: releaseTag(TEST_BUILD.version) },
    fetchApiBuild: () => Promise.resolve(undefined),
    logBuild: vi.fn(),
  }));

  const { SignIn: Released } = await import("../src/SignIn");
  render(<Released />);

  const link = (await screen.findByText("Release notes")).closest(
    "a",
  ) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(
    `https://github.com/lunox-work/sandbox-factory/releases/tag/${releaseTag(
      TEST_BUILD.version,
    )}`,
  );
  // Alongside the commit link, not instead of it.
  expect(screen.getByText("7f3a9c1")).toBeTruthy();

  vi.doUnmock("../src/build");
  vi.resetModules();
});
