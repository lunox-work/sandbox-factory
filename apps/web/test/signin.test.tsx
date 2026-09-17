/**
 * Tests for the signed-out screen.
 *
 * As in `app.test.tsx`, the auth client is faked at the module boundary and
 * everything else is real, so these assert what actually reaches the screen:
 * the brand, a mark on every provider button, and that the wait after a click
 * is legible — the clicked button says so, and the others cannot be clicked
 * into a second, competing redirect.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

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
