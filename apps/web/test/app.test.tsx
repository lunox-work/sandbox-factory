/**
 * Tests for the signed-in shell.
 *
 * One property: what a person sees must belong to the signed-in account. The
 * API scopes todos to the session user, but a list cached in the browser that
 * outlives its session still shows one user another's data.
 *
 * The server is faked at the `fetch` and auth-client boundary, as in
 * `account.test.tsx`.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const useSession = vi.fn();

vi.mock("../src/auth", () => ({
  useSession: () => useSession(),
  signOut: vi.fn(),
  authClient: {
    listAccounts: () => Promise.resolve({ data: [] }),
    unlinkAccount: vi.fn(),
    linkSocial: vi.fn(),
  },
  PROVIDERS: [{ id: "google", label: "Continue with Google" }],
  signInWith: vi.fn(),
}));

/** Titles the API will return for the next list request, per call. */
let todosByCall: string[][] = [];
let callCount = 0;

/**
 * Installed before `App` is imported, and never replaced. `TodoClient` binds
 * `globalThis.fetch` when `api.ts` constructs it at module load, so a stub
 * installed in `beforeEach` arrives too late. Tests vary its behaviour through
 * the mutable state above instead.
 */
const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/v1/todos")) {
    if (unauthorized) {
      return Promise.resolve(
        Response.json({ error: "Authentication required." }, { status: 401 }),
      );
    }
    const titles = todosByCall[callCount] ?? [];
    callCount += 1;
    return Promise.resolve(
      Response.json({
        todos: titles.map((title, index) => ({
          id: `todo_${index}`,
          title,
          done: false,
          createdAt: "2026-09-16T00:00:00.000Z",
        })),
      }),
    );
  }
  return Promise.resolve(Response.json({}));
});

let unauthorized = false;

vi.stubGlobal("fetch", fetchMock);

const { App } = await import("../src/App");

function session(user: { id: string; name: string } | null) {
  useSession.mockReturnValue({ data: user === null ? null : { user } });
}

beforeEach(() => {
  callCount = 0;
  todosByCall = [];
  unauthorized = false;
  fetchMock.mockClear();
});

test("a signed-out visitor sees the sign-in screen, not a list", () => {
  session(null);
  render(<App />);

  expect(screen.getByText("Continue with Google")).toBeTruthy();
  expect(screen.queryByLabelText("Todo title")).toBeNull();
});

test("a signed-in user sees their own todos", async () => {
  todosByCall = [["alice's todo"]];
  session({ id: "user_1", name: "Alice" });
  render(<App />);

  await waitFor(() => {
    expect(screen.getByText("alice's todo")).toBeTruthy();
  });
});

test("switching account does not leave the previous user's todos on screen", async () => {
  // The regression: without the user-id key React reuses the mounted tree, so
  // the first user's todos stay visible until a refetch replaces them.
  todosByCall = [["alice's todo"], ["bob's todo"]];

  session({ id: "user_1", name: "Alice" });
  const { rerender } = render(<App />);
  await waitFor(() => {
    expect(screen.getByText("alice's todo")).toBeTruthy();
  });

  session({ id: "user_2", name: "Bob" });
  rerender(<App />);

  // Gone immediately on the identity change, not once Bob's request resolves.
  expect(screen.queryByText("alice's todo")).toBeNull();
  await waitFor(() => {
    expect(screen.getByText("bob's todo")).toBeTruthy();
  });
});

test("a 401 clears the list rather than leaving it on screen", async () => {
  // A session can end while the tab is open. Rows fetched for it must not
  // survive the failure.
  todosByCall = [["alice's todo"]];
  session({ id: "user_1", name: "Alice" });
  const { rerender } = render(<App />);
  await waitFor(() => {
    expect(screen.getByText("alice's todo")).toBeTruthy();
  });

  // The session ends server-side while the rows are already on screen.
  unauthorized = true;

  // Force a refetch: a different id mounts a fresh tree and reruns the effect.
  session({ id: "user_1_resumed", name: "Alice" });
  rerender(<App />);

  await waitFor(() => {
    expect(screen.getByRole("alert")).toBeTruthy();
  });
  // The error is shown *and* the stale rows are gone, not one or the other.
  expect(screen.queryByText("alice's todo")).toBeNull();
});
