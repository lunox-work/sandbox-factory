import { cleanup, render, screen, waitFor, within } from "./render";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { SandboxContributors } from "../src/features/sandbox/SandboxContributors";
import { SandboxSubmissions } from "../src/features/sandbox/SandboxSubmissions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stamp = "2026-11-15T00:00:00.000Z";
const invite = (overrides: object = {}) => ({
  id: "cin_1",
  sandboxVersionId: "sbv_1",
  label: "Grace",
  emailHint: null,
  state: "active",
  maxClaims: 1,
  claims: 0,
  expiresAt: "2026-11-29T00:00:00.000Z",
  revokedAt: null,
  claimedAt: null,
  createdBy: { id: "user_1", name: "Ada Lovelace" },
  createdAt: stamp,
  ...overrides,
});
const assignment = {
  id: "cas_1",
  sandboxVersionId: "sbv_1",
  user: { id: "user_c", name: "Grace Hopper", email: "grace@example.test" },
  inviteId: "cin_1",
  createdAt: stamp,
  revokedAt: null,
};

function serve(listed: { invites: unknown[]; contributors: unknown[] }) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (url.endsWith("/invites") && method === "POST")
        return Promise.resolve(
          Response.json(
            {
              invite: invite({ id: "cin_2", label: "Alan" }),
              token: "lnxinv_secret",
              claimUrl: "https://app.example.test/invite#lnxinv_secret",
            },
            { status: 201 },
          ),
        );
      if (url.endsWith("/revoke"))
        return Promise.resolve(
          url.includes("/invites/")
            ? Response.json({ invite: invite({ state: "revoked" }) })
            : Response.json({
                contributor: { ...assignment, revokedAt: stamp },
              }),
        );
      return Promise.resolve(Response.json(listed));
    }),
  );
  return calls;
}

test("an owner invites a contributor and sees the claim link once, with a copy button", async () => {
  const calls = serve({ invites: [], contributors: [] });
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  render(
    <SandboxContributors organizationId="org_1" versionId="sbv_1" canInvite />,
  );
  expect(await screen.findByText("No invites yet.")).toBeTruthy();
  await userEvent.type(screen.getByLabelText(/Who it is for/), "Alan");
  await userEvent.click(
    screen.getByRole("button", { name: "Invite contributor" }),
  );
  const shown = await screen.findByTestId("invite-link");
  const link = within(shown).getByLabelText("Claim link") as HTMLInputElement;
  expect(link.value).toBe("https://app.example.test/invite#lnxinv_secret");
  expect(within(shown).getByText(/Shown once/)).toBeTruthy();
  const made = calls.find((call) => call.method === "POST");
  expect(made?.url).toBe("/api/v1/orgs/org_1/sandboxes/versions/sbv_1/invites");
  expect(made?.body).toEqual({ label: "Alan" });
  await userEvent.click(within(shown).getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith(
    "https://app.example.test/invite#lnxinv_secret",
  );
  expect(await within(shown).findByText("Copied")).toBeTruthy();
  // Dismissed, it is gone for good.
  await userEvent.click(
    within(shown).getByRole("button", { name: "Dismiss the link" }),
  );
  expect(screen.queryByTestId("invite-link")).toBeNull();
});

test("contributors and invites are listed and revoked; a version not published takes none", async () => {
  const calls = serve({
    invites: [
      invite(),
      invite({ id: "cin_0", label: null, state: "claimed", claims: 1 }),
    ],
    contributors: [assignment],
  });
  render(
    <SandboxContributors
      organizationId="org_1"
      versionId="sbv_1"
      canInvite={false}
    />,
  );
  expect(await screen.findByText("Grace Hopper")).toBeTruthy();
  expect(screen.getByText("grace@example.test")).toBeTruthy();
  expect(screen.getByText("Unlabelled invite")).toBeTruthy();
  expect(screen.getByText("Claimed")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Invite contributor" }),
  ).toBeNull();
  expect(
    screen.getByText(
      /Only the sandbox's current published version takes invites/,
    ),
  ).toBeTruthy();

  const panel = screen.getByTestId("sandbox-contributors");
  const [revokePerson] = within(panel).getAllByRole("button", {
    name: "Revoke",
  });
  await userEvent.click(revokePerson as HTMLElement);
  await userEvent.click(
    await screen.findByRole("button", { name: "Revoke access" }),
  );
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.url === "/api/v1/orgs/org_1/sandboxes/contributors/cas_1/revoke",
      ),
    ).toBe(true),
  );
  const [, revokeInvite] = within(panel).getAllByRole("button", {
    name: "Revoke",
  });
  await userEvent.click(revokeInvite as HTMLElement);
  await userEvent.click(
    await screen.findByRole("button", { name: "Revoke invite" }),
  );
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.url === "/api/v1/orgs/org_1/sandboxes/invites/cin_1/revoke",
      ),
    ).toBe(true),
  );
});

test("each submission row names the invited contributor who made it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          submissions: [
            {
              id: "sbm_1",
              sandboxVersionId: "sbv_1",
              status: "failed",
              verdict: "overfit",
              public: { passed: 1, total: 1 },
              hidden: { passed: 1, total: 2 },
              failedScenarios: ["s3"],
              refused: [],
              runId: "arn_1",
              retryOf: null,
              merge: null,
              contributor: {
                assignmentId: "cas_1",
                userId: "user_c",
                name: "Grace Hopper",
                email: "grace@example.test",
              },
              createdAt: stamp,
              updatedAt: stamp,
            },
          ],
        }),
      ),
    ),
  );
  render(
    <SandboxSubmissions
      organizationId="org_1"
      versionId="sbv_1"
      canMerge={false}
    />,
  );
  const row = await screen.findByTestId("submission-contributor");
  expect(row.textContent).toMatch(/By Grace Hopper/);
  expect(row.textContent).toMatch(/grace@example\.test/);
});
