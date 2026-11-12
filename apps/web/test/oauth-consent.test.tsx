/**
 * The `/oauth/consent` page, where a person lets an app use one workspace.
 * Better Auth's endpoints are faked at the auth client's `$fetch`.
 */

import type { MembershipDto } from "@sandbox-factory/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { cleanup, fireEvent, render, screen } from "./render";

const fetchAuth = vi.fn();

vi.mock("../src/auth", () => ({
  authClient: {
    $fetch: (path: string, options: unknown) => fetchAuth(path, options),
  },
}));

const { OAuthConsent, ORGANIZATION_HEADER, defaultScopes, requestedScopes } =
  await import("../src/features/developers/OAuthConsent");
const { isOAuthConsentPath } = await import("../src/routes");

const assign = vi.fn();

beforeEach(() => {
  vi.stubGlobal("location", { ...window.location, assign });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const SEARCH =
  "?client_id=client_1&scope=workspace%3Aread+bounties%3Awrite+offline_access&exp=1&sig=abc";

function membership(
  id: string,
  role: string,
  name = id.toUpperCase(),
): MembershipDto {
  return { id, name, slug: id, role, kind: "team" } as MembershipDto;
}

function answer(path: string) {
  if (path === "/oauth2/public-client")
    return Promise.resolve({
      data: { client_id: "client_1", client_name: "Claude Code" },
      error: null,
    });
  return Promise.resolve({
    data: { redirect: true, url: "http://127.0.0.1:33418/callback?code=x" },
    error: null,
  });
}

test("the consent address is /oauth/consent", () => {
  expect(isOAuthConsentPath("/oauth/consent")).toBe(true);
  expect(isOAuthConsentPath("/oauth/consent/")).toBe(true);
  expect(isOAuthConsentPath("/oauth")).toBe(false);
});

test("an app is offered reading by default, never more than it asked", () => {
  expect(requestedScopes(SEARCH)).toEqual({
    api: ["workspace:read", "bounties:write"],
    offline: true,
  });
  expect(defaultScopes(["workspace:read", "bounties:write"])).toEqual([
    "workspace:read",
  ]);
  expect(defaultScopes(["bounties:write"])).toEqual(["bounties:write"]);
  expect(requestedScopes("?scope=admin+workspace%3Aread").api).toEqual([
    "workspace:read",
  ]);
});

test("an owner picks a workspace and allows reading, bound by header", async () => {
  fetchAuth.mockImplementation(answer);
  render(
    <OAuthConsent
      search={SEARCH}
      organizations={[
        membership("org_1", "owner", "Acme"),
        membership("org_2", "member", "Globex"),
        membership("org_3", "admin", "Initech"),
      ]}
      loadError={null}
    />,
  );
  expect(await screen.findByText("Claude Code")).toBeTruthy();
  // Only workspaces they administer are offered.
  expect(screen.getByLabelText(/Acme/)).toBeTruthy();
  expect(screen.queryByLabelText(/Globex/)).toBeNull();
  const allow = screen.getByRole("button", { name: "Allow" });
  expect((allow as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/Initech/));
  expect(
    (
      screen.getByRole("checkbox", {
        name: /workspace:read/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(
    (
      screen.getByRole("checkbox", {
        name: /bounties:write/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(allow);
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Allowed. Returning you to Claude Code…",
  );
  expect(fetchAuth).toHaveBeenCalledWith("/oauth2/consent", {
    method: "POST",
    headers: { [ORGANIZATION_HEADER]: "org_3" },
    body: {
      accept: true,
      oauth_query: SEARCH.slice(1),
      scope: "workspace:read offline_access",
    },
  });
  expect(assign).toHaveBeenCalledWith("http://127.0.0.1:33418/callback?code=x");
});

test("a sole administered workspace is chosen, and more scopes can be ticked", async () => {
  fetchAuth.mockImplementation(answer);
  render(
    <OAuthConsent
      search={SEARCH}
      organizations={[membership("org_1", "owner")]}
      loadError={null}
    />,
  );
  await screen.findByText("Claude Code");
  fireEvent.click(screen.getByRole("checkbox", { name: /bounties:write/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /workspace:read/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /workspace:read/ }));
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  await screen.findByRole("status");
  expect(fetchAuth).toHaveBeenLastCalledWith(
    "/oauth2/consent",
    expect.objectContaining({
      headers: { [ORGANIZATION_HEADER]: "org_1" },
      body: expect.objectContaining({
        scope: "workspace:read bounties:write offline_access",
      }),
    }),
  );
});

test("denying sends no workspace", async () => {
  fetchAuth.mockImplementation(answer);
  render(
    <OAuthConsent
      search={SEARCH}
      organizations={[membership("org_1", "owner")]}
      loadError={null}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Denied. Nothing was shared.",
  );
  expect(fetchAuth).toHaveBeenLastCalledWith("/oauth2/consent", {
    method: "POST",
    headers: {},
    body: { accept: false, oauth_query: SEARCH.slice(1) },
  });
});

test("someone who administers no workspace is told so", async () => {
  fetchAuth.mockImplementation(answer);
  render(
    <OAuthConsent
      search={SEARCH}
      organizations={[membership("org_1", "member")]}
      loadError={null}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("own or administer no workspace"),
  );
});

test("a refused decision keeps the choice open with the reason", async () => {
  fetchAuth.mockImplementation((path: string) =>
    path === "/oauth2/consent"
      ? Promise.resolve({
          data: null,
          error: { status: 403, message: "Only an owner or admin may grant." },
        })
      : answer(path),
  );
  render(
    <OAuthConsent
      search={SEARCH}
      organizations={[membership("org_1", "owner")]}
      loadError={null}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
  expect(
    await screen.findByText("Only an owner or admin may grant."),
  ).toBeTruthy();
  expect(assign).not.toHaveBeenCalled();
});

test("an unknown app, or a page opened by hand, says where to start", async () => {
  fetchAuth.mockResolvedValue({ data: null, error: { status: 404 } });
  render(<OAuthConsent search={SEARCH} organizations={[]} loadError={null} />);
  expect(await screen.findByText(/not registered here/)).toBeTruthy();
  cleanup();
  render(<OAuthConsent search="" organizations={null} loadError={null} />);
  expect(screen.getByText(/Start from the app/)).toBeTruthy();
});
