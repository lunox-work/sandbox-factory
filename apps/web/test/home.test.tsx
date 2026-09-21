/**
 * The home screen: every connection the person can reach, grouped by owner.
 *
 * Three properties. That connections are attributed to the organization that
 * owns them — the whole point of grouping, and getting it wrong would show a
 * client's site under the wrong account. That a personal organization is
 * presented as the person's own and sorted first. And that one organization
 * failing to load does not empty the others.
 *
 * The server is faked at the `fetch` boundary, as elsewhere in this suite.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

import { Home } from "../src/Home";

const personal = {
  id: "org_personal",
  name: "Dana",
  slug: "dana",
  kind: "personal" as const,
  role: "owner",
};

const acme = {
  id: "org_acme",
  name: "Acme",
  slug: "acme",
  kind: "team" as const,
  role: "member",
};

function connection(overrides: { id: string; siteName: string }) {
  return {
    cloudId: `cloud-${overrides.id}`,
    siteUrl: `https://${overrides.siteName.toLowerCase()}.atlassian.net`,
    email: null,
    healthy: true,
    scopes: ["read:jira-work"],
    createdAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

/** Connections per organization id; a missing key answers 500. */
let byOrganization: Record<string, ReturnType<typeof connection>[]> = {};

beforeEach(() => {
  byOrganization = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const match = /\/orgs\/([^/]+)\/jira\/connections/.exec(url);
      if (match === null) {
        return Promise.resolve(Response.json({}));
      }
      const rows = byOrganization[decodeURIComponent(match[1] ?? "")];
      return Promise.resolve(
        rows === undefined
          ? Response.json({ error: "boom" }, { status: 500 })
          : Response.json({ connections: rows }),
      );
    }),
  );
});

test("each connection is listed under the organization that owns it", async () => {
  // The property grouping exists for: a site belongs to one owner, and showing
  // it under another would misattribute a client's data.
  byOrganization = {
    org_personal: [connection({ id: "jrc_1", siteName: "Mine" })],
    org_acme: [connection({ id: "jrc_2", siteName: "Client" })],
  };

  render(
    <Home
      organizations={[personal, acme]}
      organizationsLoading={false}
      onOpen={vi.fn()}
    />,
  );

  const mine = await screen.findByText("Mine");
  const client = await screen.findByText("Client");

  // Scoped to the card, not the page: `getByText` alone would pass however
  // the two groups were arranged.
  const personalCard = mine.closest("[data-slot='card']");
  const teamCard = client.closest("[data-slot='card']");
  expect(personalCard).not.toBe(teamCard);
  expect(
    within(personalCard as HTMLElement).getByText("Personal"),
  ).toBeTruthy();
  expect(within(teamCard as HTMLElement).getByText("Acme")).toBeTruthy();
});

test("the personal organization is shown as the person's own account", async () => {
  byOrganization = { org_personal: [] };

  render(
    <Home
      organizations={[personal]}
      organizationsLoading={false}
      onOpen={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("Personal")).toBeTruthy();
  });
  // Labelled rather than left to read as a team called "Dana".
  expect(screen.getByText("Your account")).toBeTruthy();
});

test("the personal organization sorts first", async () => {
  // It is the one organization everyone has, so it anchors the list; teams
  // come and go beneath it.
  byOrganization = { org_personal: [], org_acme: [] };

  render(
    <Home
      organizations={[acme, personal]}
      organizationsLoading={false}
      onOpen={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("Personal")).toBeTruthy();
  });

  const titles = screen
    .getAllByText(/^(Personal|Acme)$/)
    .map((node) => node.textContent);
  expect(titles[0]).toBe("Personal");
});

test("one organization failing does not empty the others", async () => {
  // Independent reads: a 500 on one must not cost the person sight of the
  // rest, which a single try/catch around the whole fan-out would.
  byOrganization = {
    org_acme: [connection({ id: "jrc_2", siteName: "Client" })],
  };

  render(
    <Home
      organizations={[personal, acme]}
      organizationsLoading={false}
      onOpen={vi.fn()}
    />,
  );

  expect(await screen.findByText("Client")).toBeTruthy();
  expect(screen.getByText("Could not load these connections.")).toBeTruthy();
});

test("belonging to no organization says so rather than showing nothing", async () => {
  render(
    <Home organizations={[]} organizationsLoading={false} onOpen={vi.fn()} />,
  );

  await waitFor(() => {
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
  });
});

test("Manage opens that organization", async () => {
  // Connecting happens on the organization's own page, because the OAuth flow
  // has to name one owner.
  byOrganization = { org_acme: [] };
  const onOpen = vi.fn();

  render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      onOpen={onOpen}
    />,
  );

  await waitFor(() => {
    expect(screen.getByRole("button", { name: /Manage/ })).toBeTruthy();
  });
  await userEvent.click(screen.getByRole("button", { name: /Manage/ }));

  expect(onOpen).toHaveBeenCalledWith(acme);
});
