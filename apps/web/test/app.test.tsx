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

import { render, screen, waitFor, within } from "./render";
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
 * Board names the API will return for the next boards request, per call.
 * Each entry is one call, so a remount reads the next one. Home names the
 * board it opens on, which is what these tests look for.
 */
let sitesByCall: string[][] = [];
let callCount = 0;
let unauthorized = false;
/** Jira not connected, so the workspace has nothing in it. */
let empty = false;
/**
 * A repository and a proposal beside the Jira site: every onboarding step is
 * done.
 */
let setUp = false;

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

  if (unauthorized) {
    return Promise.resolve(
      Response.json({ error: "Authentication required." }, { status: 401 }),
    );
  }

  if (url.includes("/jira/connections")) {
    return Promise.resolve(
      Response.json(
        empty
          ? { connections: [] }
          : {
              connections: [
                {
                  id: "jrc_1",
                  cloudId: "cloud_1",
                  siteName: "Acme",
                  siteUrl: "https://acme.atlassian.net",
                  email: null,
                  healthy: true,
                  scopes: [],
                  createdAt: "2026-09-16T00:00:00.000Z",
                },
              ],
            },
      ),
    );
  }

  if (setUp && url.endsWith("/github/repositories")) {
    return Promise.resolve(
      Response.json({
        repositories: [
          {
            id: "ghr_1",
            connectionId: "ghc_1",
            role: "source",
            externalId: "1",
            fullName: "acme/widgets",
            defaultBranch: "main",
            isPrivate: false,
            sizeKb: 1,
            headSha: "a".repeat(40),
            pushedAt: "2026-10-01T00:00:00.000Z",
            lastSyncedAt: "2026-10-01T00:00:00.000Z",
            syncStatus: "ok",
            syncError: null,
            stack: [],
            contextSnapshotId: null,
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
    );
  }

  if (setUp && url.endsWith("/proposal-categories")) {
    return Promise.resolve(
      Response.json({ total: 1, uncategorized: 1, categories: [] }),
    );
  }

  if (/\/jira\/boards(\?|$)/.test(url)) {
    const names = sitesByCall[callCount] ?? [];
    callCount += 1;
    return Promise.resolve(
      Response.json({
        boards: names.map((name, index) => ({
          id: `jrb_${index}`,
          connectionId: "jrc_1",
          externalId: String(index),
          name,
          boardType: "scrum",
          projectKey: "ACME",
          selection: {},
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
  window.history.replaceState(null, "", "/");
  callCount = 0;
  sitesByCall = [];
  unauthorized = false;
  empty = false;
  setUp = false;
  fetchMock.mockClear();
});

test("a signed-out visitor sees the sign-in screen, not a list", () => {
  session(null);
  render(<App />);

  expect(screen.getByText("Continue with Google")).toBeTruthy();
  expect(
    screen.queryByRole("heading", {
      name: /good (morning|afternoon|evening)/i,
    }),
  ).toBeNull();
});

test("a signed-in user's onboarding scans their own board", async () => {
  // The board is on onboarding, under getting started.
  window.history.replaceState(null, "", "/onboarding");
  sitesByCall = [["alice-site"]];
  session({ id: "user_1", name: "Alice" });
  render(<App />);

  await waitFor(() => {
    expect(screen.getByText("alice-site")).toBeTruthy();
  });
});

test("switching account does not leave the previous user's board on screen", async () => {
  // The regression: without the user-id key React reuses the mounted tree, so
  // the first user's rows stay visible until a refetch replaces them.
  window.history.replaceState(null, "", "/onboarding");
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
  window.history.replaceState(null, "", "/onboarding");
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

test("a workspace not set up yet is offered onboarding alone, and home lands on it", async () => {
  // Jira connected, but no repository and nothing sized: still onboarding.
  sitesByCall = [["alice-site"]];
  session({ id: "user_1", name: "Alice" });
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "Onboarding", level: 1 }),
  ).toBeTruthy();
  await waitFor(() => expect(window.location.pathname).toBe("/onboarding"));
  const rail = screen.getByRole("navigation", { name: "Main" });
  expect(within(rail).getByRole("link", { name: "Onboarding" })).toBeTruthy();
  expect(within(rail).queryByRole("link", { name: "Home" })).toBeNull();
  expect(within(rail).queryByRole("link", { name: "Bounties" })).toBeNull();
  // It is the landing page here, so there is nothing above it to go back to.
  expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  window.history.replaceState(null, "", "/");
});

test("an empty workspace is offered onboarding alone too", async () => {
  empty = true;
  session({ id: "user_1", name: "Alice" });
  render(<App />);

  await waitFor(() => expect(window.location.pathname).toBe("/onboarding"));
  const rail = screen.getByRole("navigation", { name: "Main" });
  expect(within(rail).queryByRole("link", { name: "Home" })).toBeNull();
  window.history.replaceState(null, "", "/");
});

test("a set-up workspace is offered home and bounties, and onboarding no more", async () => {
  setUp = true;
  sitesByCall = [["alice-site"]];
  // Where a consent or an old link might still lead.
  window.history.replaceState(null, "", "/onboarding");
  session({ id: "user_1", name: "Alice" });
  render(<App />);

  await waitFor(() => expect(window.location.pathname).toBe("/"));
  expect(
    await screen.findByRole("heading", {
      name: /^Good (morning|afternoon|evening)/,
    }),
  ).toBeTruthy();
  const rail = screen.getByRole("navigation", { name: "Main" });
  for (const name of ["Home", "Bounties"])
    expect(within(rail).getByRole("link", { name })).toBeTruthy();
  expect(within(rail).queryByRole("link", { name: "Onboarding" })).toBeNull();
});

test("a version's files open on their own, outside the shell", async () => {
  window.history.replaceState(null, "", "/sandboxes/acme/sbv_1");
  session({ id: "user_1", name: "Alice" });
  render(<App />);

  // Its explorer's page, reading that version; no rail beside it.
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/orgs/org_1/sandboxes/versions/sbv_1/files"),
      ),
    ).toBe(true),
  );
  expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  window.history.replaceState(null, "", "/");
});
