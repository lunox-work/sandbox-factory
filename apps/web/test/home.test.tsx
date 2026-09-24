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
  role: "owner" as const,
};

const acme = {
  id: "org_acme",
  name: "Acme",
  slug: "acme",
  kind: "team" as const,
  role: "member" as const,
};

function connection(overrides: {
  id: string;
  siteName: string;
  healthy?: boolean;
}) {
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
      activeOrganization={null}
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
  byOrganization = {
    org_personal: [connection({ id: "jrc_1", siteName: "Mine" })],
  };

  render(
    <Home
      organizations={[personal]}
      organizationsLoading={false}
      activeOrganization={null}
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
  byOrganization = {
    org_personal: [connection({ id: "jrc_1", siteName: "Mine" })],
    org_acme: [connection({ id: "jrc_2", siteName: "Client" })],
  };

  render(
    <Home
      organizations={[acme, personal]}
      organizationsLoading={false}
      activeOrganization={null}
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
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  expect(await screen.findByText("Client")).toBeTruthy();
  expect(screen.getByText("Could not load these connections.")).toBeTruthy();
});

test("belonging to no organization says so rather than showing nothing", async () => {
  render(
    <Home
      organizations={[]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("No sites connected yet")).toBeTruthy();
  });
  expect(screen.getByText(/not in a workspace yet/)).toBeTruthy();
});

test("Manage opens that organization", async () => {
  // Connecting happens in the organization's own settings, because the OAuth flow
  // has to name one owner.
  byOrganization = {
    org_acme: [connection({ id: "jrc_1", siteName: "Client" })],
  };
  const onOpen = vi.fn();

  render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={onOpen}
    />,
  );

  await waitFor(() => {
    expect(screen.getByRole("link", { name: /Manage/ })).toBeTruthy();
  });
  await userEvent.click(screen.getByRole("link", { name: /Manage/ }));

  expect(onOpen).toHaveBeenCalledWith(acme);
});

// ---- only working connections are listed ----------------------------------
//
// A connection goes unhealthy when Atlassian refuses the credential, and it
// cannot read a board until someone reconnects it. It is not listed — but it
// is counted, because one that vanished silently would look like one nobody
// had made.

test("an unhealthy connection is not listed", async () => {
  byOrganization = {
    org_acme: [
      connection({ id: "jrc_1", siteName: "Working" }),
      connection({ id: "jrc_2", siteName: "Revoked", healthy: false }),
    ],
  };

  render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  expect(await screen.findByText("Working")).toBeTruthy();
  expect(screen.queryByText("Revoked")).toBeNull();
});

test("unhealthy connections are reported as a count", async () => {
  // Hidden, not silent: the remedy is a click away on the organization's page.
  byOrganization = {
    org_acme: [
      connection({ id: "jrc_1", siteName: "Working" }),
      connection({ id: "jrc_2", siteName: "Revoked", healthy: false }),
      connection({ id: "jrc_3", siteName: "AlsoGone", healthy: false }),
    ],
  };

  render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  expect(await screen.findByText("2 sites need reconnecting")).toBeTruthy();
});

test("the reconnect count is singular for one", async () => {
  byOrganization = {
    org_acme: [
      connection({ id: "jrc_2", siteName: "Revoked", healthy: false }),
    ],
  };

  render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  expect(await screen.findByText("1 site needs reconnecting")).toBeTruthy();
});

test("a group of only unhealthy connections does not read as empty", async () => {
  // "No sites connected yet" would be wrong: one is connected, it is broken.
  byOrganization = {
    org_acme: [
      connection({ id: "jrc_2", siteName: "Revoked", healthy: false }),
    ],
  };

  render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("1 site needs reconnecting")).toBeTruthy();
  });
  expect(screen.queryByText("No sites connected yet.")).toBeNull();
});

test("the reconnect count opens that organization", async () => {
  byOrganization = {
    org_acme: [
      connection({ id: "jrc_2", siteName: "Revoked", healthy: false }),
    ],
  };
  const onOpen = vi.fn();

  render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={onOpen}
    />,
  );

  await userEvent.click(await screen.findByText("1 site needs reconnecting"));

  expect(onOpen).toHaveBeenCalledWith(acme);
});

test("only unhealthy connections says nothing is readable", async () => {
  // The page-level line is about working connections: there are none, but the
  // group is still shown, because a broken connection is something to act on.
  byOrganization = {
    org_acme: [
      connection({ id: "jrc_2", siteName: "Revoked", healthy: false }),
    ],
  };

  render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText(/Nothing readable yet/)).toBeTruthy();
  });
  expect(screen.getByText("1 site needs reconnecting")).toBeTruthy();
});

// ---- organizations with nothing to show are left out -----------------------
//
// This is a list of connections, not of organizations. A card reading "no
// sites connected yet" is a row about an absence, and several of them bury the
// sites that do exist.

test("an organization with no connections is not shown", async () => {
  byOrganization = {
    org_personal: [],
    org_acme: [connection({ id: "jrc_1", siteName: "Client" })],
  };

  render(
    <Home
      organizations={[personal, acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  expect(await screen.findByText("Client")).toBeTruthy();
  expect(screen.queryByText("Personal")).toBeNull();
  expect(screen.queryByText("No sites connected yet.")).toBeNull();
});

test("an organization that failed to load is still shown", async () => {
  // A failure is something to act on, unlike an absence — and hiding it would
  // claim there is nothing there when nobody knows.
  byOrganization = {
    org_acme: [connection({ id: "jrc_1", siteName: "Client" })],
  };

  render(
    <Home
      organizations={[personal, acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  expect(await screen.findByText("Client")).toBeTruthy();
  expect(screen.getByText("Personal")).toBeTruthy();
});

test("an organization holding only broken connections is still shown", async () => {
  byOrganization = {
    org_personal: [],
    org_acme: [
      connection({ id: "jrc_2", siteName: "Revoked", healthy: false }),
    ],
  };

  render(
    <Home
      organizations={[personal, acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  expect(await screen.findByText("1 site needs reconnecting")).toBeTruthy();
  expect(screen.queryByText("Personal")).toBeNull();
});

test("with nothing connected, the page is onboarding", async () => {
  byOrganization = { org_personal: [], org_acme: [] };

  render(
    <Home
      organizations={[personal, acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  expect(
    await screen.findByRole("heading", { level: 1, name: "Onboarding" }),
  ).toBeTruthy();
});

test("with something connected, the page is still Connections", async () => {
  byOrganization = { org_acme: [connection({ id: "jrc_1", siteName: "C" })] };

  render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  expect(await screen.findByText("C")).toBeTruthy();
  expect(
    screen.getByRole("heading", { level: 1, name: "Connections" }),
  ).toBeTruthy();
});

test("Connect Jira opens the workspace chosen in the switcher", async () => {
  // Connecting happens on an organization's own page, because a site belongs
  // to one owner. The switcher at the head of the rail names that owner, so
  // the button follows it rather than guessing, and rather than asking again.
  byOrganization = { org_personal: [], org_acme: [] };
  const onOpen = vi.fn();

  render(
    <Home
      organizations={[personal, acme]}
      organizationsLoading={false}
      activeOrganization={acme}
      onOpen={onOpen}
    />,
  );

  await userEvent.click(
    await screen.findByRole("button", { name: "Connect Jira" }),
  );
  expect(onOpen).toHaveBeenCalledWith(acme);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("button", { name: /Personal/ })).toBeNull();
});

// ---- the page opens like every other one ----------------------------------

test("home has the same top padding as the other pages", async () => {
  // It used `p-6`, which put its heading 48px higher than every other page's
  // — a jump on each navigation. The trail above also pulls its bottom margin
  // back by `-mb-6 sm:-mb-8`, which needs the page's own padding to exceed it.
  byOrganization = { org_acme: [connection({ id: "jrc_1", siteName: "C" })] };

  const { container } = render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("Connections")).toBeTruthy();
  });

  const main = container.querySelector("main");
  expect(main?.className).toContain("py-10");
  expect(main?.className).toContain("sm:py-14");
});

// ---- a listed site is a way to its boards ---------------------------------
//
// The sites on this page were inert text. A site has no page of its own, so
// its row leads where its boards are: the Jira tab of the organization that
// owns it.

test("a listed site opens its organization's Jira tab", async () => {
  byOrganization = {
    org_acme: [connection({ id: "jrc_1", siteName: "Client" })],
  };
  const onOpen = vi.fn();

  render(
    <Home
      organizations={[acme]}
      organizationsLoading={false}
      activeOrganization={null}
      onOpen={onOpen}
    />,
  );

  const row = await screen.findByRole("link", { name: /Client/ });
  expect(row.getAttribute("href")).toBe("/o/acme/settings?connection=jira");
  await userEvent.click(row);

  // The organization, which is what the URL needs and the connection does
  // not carry.
  expect(onOpen).toHaveBeenCalledWith(acme);
});
