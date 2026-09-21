/**
 * Tests for the signed-in shell.
 *
 * One property: what a person sees must belong to the signed-in account. The
 * API scopes every read to the session's memberships, but a list cached in the
 * browser that outlives its session still shows one user another's data.
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
    organization: { setActive: () => Promise.resolve({}) },
  },
  PROVIDERS: [{ id: "google", label: "Continue with Google" }],
  signInWith: vi.fn(),
}));

/**
 * Site names the API will return for the next connections request, per call.
 * Each entry is one call, so a remount reads the next one.
 */
let sitesByCall: string[][] = [];
let callCount = 0;
let unauthorized = false;

/** One organization, so there is a group for the connections to hang off. */
const organizations = [
  {
    id: "org_1",
    name: "Acme",
    slug: "acme",
    kind: "team" as const,
    role: "owner",
  },
];

const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input);

  if (url.includes("/api/v1/me/orgs")) {
    return Promise.resolve(
      unauthorized
        ? Response.json({ error: "Authentication required." }, { status: 401 })
        : Response.json({ organizations }),
    );
  }

  if (url.includes("/jira/connections")) {
    if (unauthorized) {
      return Promise.resolve(
        Response.json({ error: "Authentication required." }, { status: 401 }),
      );
    }
    const names = sitesByCall[callCount] ?? [];
    callCount += 1;
    return Promise.resolve(
      Response.json({
        connections: names.map((siteName, index) => ({
          id: `jrc_${index}`,
          cloudId: `cloud_${index}`,
          siteName,
          siteUrl: `https://${siteName}.atlassian.net`,
          email: null,
          healthy: true,
          scopes: [],
          createdAt: "2026-09-16T00:00:00.000Z",
        })),
      }),
    );
  }

  return Promise.resolve(Response.json({}));
});

vi.stubGlobal("fetch", fetchMock);

const { App } = await import("../src/App");

function session(user: { id: string; name: string } | null) {
  useSession.mockReturnValue({ data: user === null ? null : { user } });
}

beforeEach(() => {
  callCount = 0;
  sitesByCall = [];
  unauthorized = false;
  fetchMock.mockClear();
});

test("a signed-out visitor sees the sign-in screen, not a list", () => {
  session(null);
  render(<App />);

  expect(screen.getByText("Continue with Google")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Connections" })).toBeNull();
});

test("a signed-in user sees the connections they can reach", async () => {
  sitesByCall = [["alice-site"]];
  session({ id: "user_1", name: "Alice" });
  render(<App />);

  await waitFor(() => {
    expect(screen.getByText("alice-site")).toBeTruthy();
  });
});

test("switching account does not leave the previous user's connections on screen", async () => {
  // The regression: without the user-id key React reuses the mounted tree, so
  // the first user's rows stay visible until a refetch replaces them.
  sitesByCall = [["alice-site"], ["bob-site"]];

  session({ id: "user_1", name: "Alice" });
  const { rerender } = render(<App />);
  await waitFor(() => {
    expect(screen.getByText("alice-site")).toBeTruthy();
  });

  session({ id: "user_2", name: "Bob" });
  rerender(<App />);

  // Gone immediately on the identity change, not once Bob's request resolves.
  expect(screen.queryByText("alice-site")).toBeNull();
  await waitFor(() => {
    expect(screen.getByText("bob-site")).toBeTruthy();
  });
});

test("a 401 clears the list rather than leaving it on screen", async () => {
  // A session can end while the tab is open. Rows fetched for it must not
  // survive the failure.
  sitesByCall = [["alice-site"]];
  session({ id: "user_1", name: "Alice" });
  const { rerender } = render(<App />);
  await waitFor(() => {
    expect(screen.getByText("alice-site")).toBeTruthy();
  });

  // The session ends server-side while the rows are already on screen.
  unauthorized = true;

  // Force a refetch: a different id mounts a fresh tree and reruns the effect.
  session({ id: "user_1_resumed", name: "Alice" });
  rerender(<App />);

  await waitFor(() => {
    expect(screen.queryByText("alice-site")).toBeNull();
  });
});
