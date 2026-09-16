/**
 * Tests for the signed-in shell.
 *
 * These are about one property: what a person sees must belong to the account
 * that is currently signed in. The API enforces that — the todo routes are
 * scoped to the session user — but the browser holds a copy of the answer, and
 * a cached list that outlives the session it was fetched for still shows one
 * user another's data even though the server would never serve it again.
 *
 * As in `account.test.tsx`, the server is faked at the `fetch` and auth-client
 * boundary rather than by mocking component internals, so these assert what
 * actually reaches the screen.
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
 * Installed before `App` is imported, and never replaced.
 *
 * `TodoClient` binds `globalThis.fetch` in its constructor, and `api.ts`
 * constructs it at module load — so a stub installed in `beforeEach` would
 * arrive too late and the real fetch would run. Stubbing once up front and
 * varying its *behaviour* through the mutable state above keeps the binding
 * valid for every test.
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
  // The regression: the signed-in tree is keyed by user id. Without that key
  // React reuses the mounted component — including the fetched list — so the
  // first user's todos stay visible until a refetch happens to replace them.
  todosByCall = [["alice's todo"], ["bob's todo"]];

  session({ id: "user_1", name: "Alice" });
  const { rerender } = render(<App />);
  await waitFor(() => {
    expect(screen.getByText("alice's todo")).toBeTruthy();
  });

  session({ id: "user_2", name: "Bob" });
  rerender(<App />);

  // Alice's row must be gone immediately on the identity change, not merely
  // replaced once Bob's request resolves.
  expect(screen.queryByText("alice's todo")).toBeNull();
  await waitFor(() => {
    expect(screen.getByText("bob's todo")).toBeTruthy();
  });
});

test("a 401 clears the list rather than leaving it on screen", async () => {
  // A session can end while the tab is open — expiry, revocation, a sign-out
  // in another tab. The rows already rendered were fetched for a session that
  // no longer exists, so they must not survive the failure.
  todosByCall = [["alice's todo"]];
  session({ id: "user_1", name: "Alice" });
  const { rerender } = render(<App />);
  await waitFor(() => {
    expect(screen.getByText("alice's todo")).toBeTruthy();
  });

  // The session ends server-side while the rows are already on screen.
  unauthorized = true;

  // Force the refetch that would happen on the next interaction or remount.
  // Keying on a different id is what makes React mount a fresh tree and run
  // the effect again — the same id would reuse the mounted one and never ask.
  session({ id: "user_1_resumed", name: "Alice" });
  rerender(<App />);

  await waitFor(() => {
    expect(screen.getByRole("alert")).toBeTruthy();
  });
  // The error is shown *and* the stale rows are gone, not one or the other.
  expect(screen.queryByText("alice's todo")).toBeNull();
});
