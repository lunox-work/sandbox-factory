import { chooseOption, openCombobox } from "./combobox";
import { act, cleanup, render, screen, waitFor, within } from "./render";
import { userEvent } from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { trailFor } from "../src/Breadcrumbs";
import { money } from "../src/lib/format";
import {
  pushLocation,
  replaceLocation,
  useLocation,
} from "../src/navigation/location";
import {
  BOUNTIES_PATH,
  bountiesUrl,
  bountyForPath,
  bountyForSearch,
  bountyPagePath,
  canonicalUrl,
  NEW_BOUNTY_PATH,
  pathForScreen,
  screenForPath,
} from "../src/routes";
import { Bounties, BountyPage, NewBountyPage } from "../src/Bounties";
import { assessRubric, COMPLEXITY_PROFILE_VERSION } from "sandbox-factory";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const stamp = "2026-10-03T00:00:00.000Z";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: "bty_7",
    organizationId: "org_1",
    title: "Invitations are not sent",
    origin: "manual",
    repoId: null,
    stack: [],
    revision: 1,
    version: 1,
    approval: null,
    jira: null,
    proposal: null,
    sandbox: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...summary(),
    description: "Scheduling an interview sends the candidate one email.",
    components: [],
    inputTruncated: false,
    createdBy: "user_1",
    stages: { overview: { version: 1 }, bounty: null, sandbox: null },
    ...overrides,
  };
}

const jiraLink = {
  issueId: "jri_1",
  boardId: "jrb_1",
  connectionId: "jrc_1",
  key: "APP-1",
  url: "https://acme.atlassian.net/browse/APP-1",
  removedAt: null,
};

const fromJira = summary({
  id: "bty_1",
  title: "Export to CSV",
  origin: "jira",
  jira: jiraLink,
  proposal: {
    id: "bpr_1",
    status: "approved",
    complexity: "M",
    amountMinor: 10_500,
    currency: "USD",
  },
});

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "bpr_9",
    organizationId: "org_1",
    runId: "brn_1",
    bountyId: "bty_7",
    issueKey: null,
    title: "Invitations are not sent",
    specHash: "a".repeat(64),
    specHashVersion: 1,
    rateCard: {
      currency: "USD",
      xsMinor: 100,
      sMinor: 100,
      mMinor: 200,
      lMinor: 300,
      xlMinor: 400,
      revision: 1,
    },
    modelComplexity: "M",
    modelConfidence: "high",
    modelRationale: "A few files.",
    unsizedReason: null,
    inputTruncated: false,
    actualModel: "model",
    promptVersion: "jira-size-v1",
    complexity: "M",
    sizedBy: "model",
    resizedBy: null,
    resizedAt: null,
    amountMinor: 200,
    currency: "USD",
    status: "proposed",
    revision: 1,
    specRevision: null,
    step: null,
    repoSnapshotId: null,
    decidedAt: null,
    decidedBy: null,
    decisionDeliveryPolicy: null,
    createdAt: stamp,
    updatedAt: stamp,
    categories: [],
    ...overrides,
  };
}

function run(outcomes: unknown[] = [], status = "queued") {
  return {
    id: "brn_1",
    organizationId: "org_1",
    boardId: null,
    bountyId: "bty_7",
    kind: "bounty",
    sourceProposalId: null,
    sourceRevision: null,
    respec: null,
    requestId: "8f0b4a1e-9a77-4c35-9a52-3f0f5b2d3c11",
    status,
    selection: {},
    rateCard: proposal().rateCard,
    requestedModel: "model",
    promptVersion: "v1",
    planned: [],
    outcomes,
    candidatesScanned: 1,
    skippedLive: 0,
    scanLimitReached: false,
    fatalErrorCode: null,
    startedAt: null,
    deadlineAt: null,
    finishedAt: null,
    createdAt: stamp,
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const acme = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team" as const,
};

/** Whoever is looking: the owner of their personal workspace. */
const viewer = { id: "user_1", image: null };

/** The page as someone in Acme alone sees it, holding `role` there. */
function inAcme(role: string) {
  const membership = { ...acme, role };
  return {
    organizations: [membership],
    active: membership,
    organizationsLoading: false,
    viewer,
    onCreate: () => {},
    onOpenPage: (path: string) => pushLocation(path),
  };
}

/**
 * The bounties page, the page a new one is written on and a bounty's own
 * page, switched by path as the app's shell switches them.
 */
function Shell(props: Omit<ComponentProps<typeof Bounties>, "onCreate">) {
  const { pathname } = useLocation();
  return pathname === NEW_BOUNTY_PATH ? (
    <NewBountyPage
      {...props}
      viewer={viewer}
      onCancel={() => pushLocation(BOUNTIES_PATH)}
      onConnectRepository={() => {}}
    />
  ) : bountyForPath(pathname) !== undefined ? (
    <BountyPage
      organizations={props.organizations}
      organizationsLoading={props.organizationsLoading}
      viewer={viewer}
      onTitle={() => {}}
      onOpenBounties={() => pushLocation(BOUNTIES_PATH)}
      onOpenSettings={(organization, tab) =>
        pushLocation(
          pathForScreen(
            "org-settings",
            organization.slug,
            undefined,
            undefined,
            tab,
          ),
        )
      }
    />
  ) : (
    <Bounties {...props} onCreate={() => pushLocation(NEW_BOUNTY_PATH)} />
  );
}

/** Follows the list's New bounty link to the form on its own page. */
async function openNewBounty() {
  await screen.findByTestId("bounty-list");
  await userEvent.click(
    screen.getAllByRole("link", { name: "New bounty" })[0]!,
  );
  return screen.findByTestId("bounty-form");
}

/**
 * A server answering what the page asks, recording every request. `routes`
 * are tried first, by method and a substring of the URL.
 */
function server(
  routes: [string, string, (body: unknown) => Promise<Response>][] = [],
  bounties: unknown[] = [summary(), fromJira],
) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    for (const [m, part, answer] of routes) {
      if (m === method && url.includes(part)) return answer(body);
    }
    if (url.includes("/github/repositories")) {
      return json({
        repositories: [
          {
            id: "ghr_1",
            connectionId: "ghc_1",
            externalId: "1",
            defaultBranch: "main",
            isPrivate: true,
            sizeKb: null,
            headSha: null,
            pushedAt: null,
            lastSyncedAt: null,
            syncError: null,
            stack: ["TypeScript", "PostgreSQL"],
            createdAt: "2026-09-30T00:00:00.000Z",
            fullName: "acme/app",
            role: "source",
            syncStatus: "ok",
          },
        ],
      });
    }
    if (method === "GET" && url.includes("/bounties?")) {
      return json({ bounties, nextCursor: null });
    }
    if (method === "GET" && url.includes("/bounties/bty_7")) {
      return json({ bounty: detail() });
    }
    if (url.includes("/proposal-categories")) {
      return json({ total: 0, uncategorized: 0, categories: [] });
    }
    if (url.includes("/proposals?")) {
      return json({ proposals: [proposal()], nextCursor: null });
    }
    if (url.match(/\/proposals\/bpr_9$/)) {
      return json({
        proposal: proposal(),
        freshness: { freshness: "current", checkedAt: stamp },
        liveSpec: {
          summary: "Invitations are not sent",
          descriptionText: "Retries must not send twice.",
          key: null,
          url: null,
          inputTruncated: false,
        },
        writebackOperations: [],
      });
    }
    if (url.includes("/spec")) return json({ spec: null });
    if (url.includes("/profile")) return json({ profile: null });
    if (method === "GET" && /\/sandboxes\/[^/]+\/versions$/.test(url))
      return json({ versions: [] });
    return json({ error: "Not found" }, 404);
  });
  return { fetchMock, calls };
}

test("the workspace's bounties list from any source, with their proposals", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  render(<Bounties {...inAcme("member")} />);
  const list = await screen.findByTestId("bounty-list");

  const rows = within(list).getAllByRole("listitem");
  expect(within(rows[0]!).getByText("Invitations are not sent")).toBeDefined();
  expect(within(rows[0]!).getByText("Created in Lunox")).toBeDefined();
  // A member may not propose: the row says there is none instead.
  expect(within(rows[0]!).getByText("No proposal")).toBeDefined();
  expect(within(rows[1]!).getByText("From Jira")).toBeDefined();
  expect(within(rows[1]!).getByText("Approved")).toBeDefined();
  expect(within(rows[1]!).getByText(/105\.00/)).toBeDefined();
});

test("each bounty is a card linking its own page, and a click opens it over the list", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  window.history.replaceState(null, "", BOUNTIES_PATH);
  render(<Bounties {...inAcme("member")} />);
  const list = await screen.findByTestId("bounty-list");
  const card = within(list).getByRole("link", {
    name: "Invitations are not sent",
  });
  // Its own page, for a new tab; a plain click opens it over the list.
  expect(card.getAttribute("href")).toBe("/bounties/acme/bty_7");
  expect(card.textContent).toContain("Invitations are not sent");
  // Its proposal is part of the card, not a control of its own: the bounty
  // opens with it.
  expect(within(list).getByTestId("proposal-brief").closest("li")).toBe(
    within(list).getByRole("link", { name: "Export to CSV" }).closest("li"),
  );
  expect(within(list).queryByRole("button", { name: /proposal/i })).toBeNull();

  const entries = window.history.length;
  await userEvent.click(card);
  expect(window.location.pathname + window.location.search).toBe(
    "/bounties?peek=acme/bty_7",
  );
  // Its own entry, so Back closes it.
  expect(window.history.length).toBe(entries + 1);
  expect(await screen.findByTestId("bounty-detail")).toBeDefined();
});

test("with a bounty open, the list stays live and another card shows in the same panel", async () => {
  const exported = detail({
    id: "bty_1",
    title: "Export to CSV",
    origin: "jira",
    jira: jiraLink,
  });
  vi.stubGlobal(
    "fetch",
    server([["GET", "/bounties/bty_1", () => json({ bounty: exported })]])
      .fetchMock,
  );
  window.history.replaceState(null, "", BOUNTIES_PATH);
  render(<Bounties {...inAcme("member")} />);
  const list = await screen.findByTestId("bounty-list");
  const first = within(list).getByRole("link", {
    name: "Invitations are not sent",
  });
  await userEvent.click(first);
  const panel = await screen.findByTestId("bounty-panel");
  await within(panel).findByTestId("bounty-detail");
  // Beside the list, not over it: nothing modal hides the list from use.
  expect(panel.getAttribute("aria-modal")).toBeNull();
  expect(first.getAttribute("aria-current")).toBe("true");

  const entries = window.history.length;
  await userEvent.click(
    within(list).getByRole("link", { name: "Export to CSV" }),
  );
  expect(window.location.search).toBe("?peek=acme/bty_1");
  // The same panel, now on the other bounty; the move replaced the entry,
  // so Back still closes the panel.
  expect(screen.getByTestId("bounty-panel")).toBe(panel);
  expect(window.history.length).toBe(entries);
  await waitFor(() => {
    expect(within(panel).getByText("APP-1")).toBeDefined();
  });
  expect(first.getAttribute("aria-current")).toBeNull();
  expect(
    within(list)
      .getByRole("link", { name: "Export to CSV" })
      .getAttribute("aria-current"),
  ).toBe("true");
});

test("a bounty in the panel is a glance, and opens as a page of its own for its proposal", async () => {
  vi.stubGlobal("fetch", server([proposed]).fetchMock);
  window.history.replaceState(null, "", "/bounties?peek=acme/bty_7");
  render(<Shell {...inAcme("member")} />);
  const panel = await screen.findByTestId("bounty-panel");
  const detail = await within(panel).findByTestId("bounty-detail");
  // Its text, sandbox, context and workspace, with no tabs between them;
  // its proposal is on its page.
  for (const part of ["Description", "Sandbox", "Context", "Workspace"]) {
    expect(within(detail).getByRole("region", { name: part })).toBeDefined();
  }
  expect(within(detail).queryByRole("region", { name: "Proposal" })).toBeNull();
  expect(within(detail).queryByTestId("proposal-detail")).toBeNull();
  expect(within(panel).queryByRole("tab")).toBeNull();
  const open = within(panel).getByRole("link", { name: "Open as page" });
  expect(open.getAttribute("href")).toBe("/bounties/acme/bty_7");

  await userEvent.click(open);
  expect(window.location.pathname + window.location.search).toBe(
    "/bounties/acme/bty_7",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    await screen.findByRole("heading", {
      level: 1,
      name: "Invitations are not sent",
    }),
  ).toBeDefined();
  // A page splits it into tabs, its proposal under Bounty.
  const page = await screen.findByTestId("bounty-detail");
  await userEvent.click(within(page).getByRole("tab", { name: "Bounty" }));
  expect(await within(page).findByTestId("proposal-detail")).toBeDefined();
});

test("an address from when the proposal was a tab still opens its bounty", async () => {
  vi.stubGlobal("fetch", server([proposed]).fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7/proposal");
  render(<Shell {...inAcme("member")} />);
  expect(await screen.findByTestId("bounty-detail")).toBeDefined();
  // The app's shell then brings the address bar up to date, on the tab the
  // proposal is in now.
  const current = canonicalUrl("/bounties/acme/bty_7/proposal", "");
  expect(current).toBe("/bounties/acme/bty_7?tab=bounty");
  act(() => replaceLocation(current!));
  const page = await screen.findByTestId("bounty-detail");
  expect(
    within(page).getByRole("tab", { name: "Bounty", selected: true }),
  ).toBeDefined();
  expect(await within(page).findByTestId("proposal-detail")).toBeDefined();
});

test("a bounty's own page opens on its overview, and names it for the trail", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  const onTitle = vi.fn();
  const { organizations } = inAcme("member");
  render(
    <BountyPage
      organizations={organizations}
      organizationsLoading={false}
      viewer={viewer}
      onTitle={onTitle}
      onOpenBounties={() => {}}
      onOpenSettings={() => {}}
    />,
  );
  expect(
    await screen.findByRole("heading", {
      level: 1,
      name: "Invitations are not sent",
    }),
  ).toBeDefined();
  const detail = await screen.findByTestId("bounty-detail");
  const text = within(detail).getByRole("region", { name: "Describe task" });
  expect(
    within(text).getByText(
      "Scheduling an interview sends the candidate one email.",
    ),
  ).toBeDefined();
  expect(
    within(text).getByRole("button", { name: "Edit description" }),
  ).toBeDefined();
  expect(
    within(detail).getByRole("tab", { name: /^Overview/, selected: true }),
  ).toBeDefined();
  // Its text, where it came from and whose it is; the rest in other tabs.
  for (const part of ["Workspace", "Context"]) {
    expect(within(detail).getByRole("region", { name: part })).toBeDefined();
  }
  for (const part of ["Proposal", "Sandbox", "Code"]) {
    expect(within(detail).queryByRole("region", { name: part })).toBeNull();
  }
  expect(onTitle).toHaveBeenLastCalledWith("Invitations are not sent");
  // A team's, so the page says whose, once, under its parts; and a page,
  // not a panel.
  expect(screen.getAllByText("Acme")).toHaveLength(1);
  expect(
    within(within(detail).getByRole("region", { name: "Workspace" })).getByText(
      "Acme",
    ),
  ).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a bounty deleted from its page returns to the list", async () => {
  const state = server([
    [
      "DELETE",
      "/bounties/bty_7",
      () => Promise.resolve(new Response(null, { status: 204 })),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  const onOpenBounties = vi.fn();
  render(
    <BountyPage
      organizations={inAcme("admin").organizations}
      organizationsLoading={false}
      viewer={viewer}
      onTitle={() => {}}
      onOpenBounties={onOpenBounties}
      onOpenSettings={() => {}}
    />,
  );
  const detail = await screen.findByTestId("bounty-detail");
  await userEvent.click(
    within(detail).getByRole("button", { name: "Delete bounty" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Delete bounty" }),
  );
  await waitFor(() => expect(onOpenBounties).toHaveBeenCalled());
});

test("a bounty's page in a workspace one is not in says so", async () => {
  const state = server();
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/elsewhere/bty_7");
  render(
    <BountyPage
      organizations={inAcme("member").organizations}
      organizationsLoading={false}
      viewer={viewer}
      onTitle={() => {}}
      onOpenBounties={() => {}}
      onOpenSettings={() => {}}
    />,
  );
  expect(
    await screen.findByText("This bounty is not in any of your workspaces."),
  ).toBeDefined();
  expect(state.calls.some(({ url }) => url.includes("/bounties/"))).toBe(false);
});

/**
 * Someone in three workspaces: their own, Acme as a member and Beta as an
 * admin, with Acme the one in the rail.
 */
function inThree() {
  const own = {
    id: "org_me",
    name: "Ada Lovelace",
    slug: "ada",
    kind: "personal" as const,
    role: "owner",
  };
  const member = { ...acme, role: "member" };
  const beta = {
    id: "org_2",
    name: "Beta",
    slug: "beta",
    kind: "team" as const,
    role: "admin",
  };
  return {
    organizations: [own, member, beta],
    active: member,
    organizationsLoading: false,
    viewer,
    onCreate: () => {},
    onOpenPage: (path: string) => pushLocation(path),
  };
}

const fromEach = [
  summary({
    id: "bty_3",
    title: "Tidy the notes",
    organizationId: "org_me",
  }),
  summary(),
  summary({
    id: "bty_2",
    title: "Retry failed webhooks",
    organizationId: "org_2",
  }),
];

test("every workspace's bounties list together, a team's tagged with its name", async () => {
  const state = server([], fromEach);
  vi.stubGlobal("fetch", state.fetchMock);
  render(<Bounties {...inThree()} />);
  const list = await screen.findByTestId("bounty-list");

  // One read, across all of them.
  expect(state.calls.map(({ url }) => url)).toContain(
    "/api/v1/me/bounties?limit=50",
  );
  const rows = within(list).getAllByRole("listitem");
  expect(rows).toHaveLength(3);
  // The person's own workspace is not named: the bounty is simply theirs.
  expect(within(rows[0]!).queryByText("Ada Lovelace")).toBeNull();
  expect(within(rows[1]!).getByText("Acme")).toBeDefined();
  expect(within(rows[2]!).getByText("Beta")).toBeDefined();
});

test("a bounty opens through its own workspace, as the role held there allows", async () => {
  const state = server(
    [
      [
        "GET",
        "/orgs/org_2/bounties/bty_2",
        () =>
          json({ bounty: detail({ id: "bty_2", organizationId: "org_2" }) }),
      ],
    ],
    fromEach,
  );
  vi.stubGlobal("fetch", state.fetchMock);
  render(<Shell {...inThree()} />);
  const list = await screen.findByTestId("bounty-list");

  await userEvent.click(
    within(list).getByRole("link", { name: "Retry failed webhooks" }),
  );
  expect(window.location.search).toBe("?peek=beta/bty_2");
  await screen.findByTestId("bounty-detail");
  // An admin in Beta, though only a member in the workspace in the rail; the
  // panel is read, so its page is where that is offered.
  await userEvent.click(screen.getByRole("link", { name: "Open as page" }));
  await userEvent.click(
    within(await screen.findByTestId("bounty-detail")).getByRole("tab", {
      name: "Sandbox",
    }),
  );
  expect(
    within(screen.getByTestId("bounty-detail")).getByRole("button", {
      name: "Create sandbox",
    }),
  ).toBeDefined();
  expect(
    state.calls.some(({ url }) => url.includes("/orgs/org_1/bounties/bty_2")),
  ).toBe(false);
});

test("a link to a bounty in a workspace one is not in says so", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  window.history.replaceState(null, "", "/bounties?peek=elsewhere/bty_7");
  render(<Bounties {...inAcme("member")} />);
  expect(
    await screen.findByText("This bounty is not in any of your workspaces."),
  ).toBeDefined();
});

test("a new bounty goes to the workspace in the rail unless another is chosen", async () => {
  const state = server(
    [
      [
        "POST",
        "/orgs/org_2/bounties",
        () =>
          json(
            { bounty: detail({ id: "bty_2", organizationId: "org_2" }) },
            201,
          ),
      ],
    ],
    fromEach,
  );
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", BOUNTIES_PATH);
  render(<Shell {...inThree()} />);
  const form = await openNewBounty();
  const workspace = within(form).getByRole("combobox", { name: "Workspace" });
  expect(workspace.textContent).toBe("Acme");
  // A repository is the workspace's own, so choosing another clears it.
  await chooseOption(
    within(form).getByRole("combobox", { name: "Repository" }),
    "acme/app",
  );
  await chooseOption(workspace, "Beta");
  expect(workspace.textContent).toBe("Beta");
  expect(
    within(form).getByRole("combobox", { name: "Repository" }).textContent,
  ).toBe("None");
  await waitFor(() =>
    expect(
      state.calls.some(({ url }) =>
        url.includes("/orgs/org_2/github/repositories"),
      ),
    ).toBe(true),
  );

  await userEvent.type(within(form).getByLabelText("Title"), "Export");
  await userEvent.click(
    within(form).getByRole("button", { name: "Create bounty" }),
  );
  await waitFor(() => expect(window.location.search).toBe("?peek=beta/bty_2"));
  expect(window.location.pathname).toBe(BOUNTIES_PATH);
  expect(
    state.calls.filter(({ method }) => method === "POST").map(({ url }) => url),
  ).toEqual(["/api/v1/orgs/org_2/bounties"]);
});

test("a new bounty is written on a page of its own, not in a panel", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  window.history.replaceState(null, "", BOUNTIES_PATH);
  render(<Shell {...inAcme("member")} />);
  await screen.findByTestId("bounty-list");

  // A link, so it can be opened in another tab.
  const links = screen.getAllByRole("link", { name: "New bounty" });
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    NEW_BOUNTY_PATH,
  ]);
  await userEvent.click(links[0]!);
  expect(window.location.pathname).toBe(NEW_BOUNTY_PATH);
  expect(
    await screen.findByRole("heading", { name: "New bounty", level: 1 }),
  ).toBeDefined();
  expect(screen.getByTestId("bounty-form")).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();

  // Cancelling returns to the list.
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(window.location.pathname).toBe(BOUNTIES_PATH);
  expect(await screen.findByTestId("bounty-list")).toBeDefined();
});

test("the new bounty page waits for the workspace in the rail", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  const loading = { ...inAcme("member"), active: null };
  const { rerender } = render(
    <NewBountyPage
      {...loading}
      organizationsLoading
      onCancel={() => {}}
      onConnectRepository={() => {}}
    />,
  );
  // The form would otherwise open on whichever workspace came first, and
  // keep it once the one in the rail arrived.
  expect(screen.getByRole("status")).toBeDefined();
  expect(screen.queryByTestId("bounty-form")).toBeNull();

  rerender(
    <NewBountyPage
      {...inAcme("member")}
      onCancel={() => {}}
      onConnectRepository={() => {}}
    />,
  );
  expect(await screen.findByTestId("bounty-form")).toBeDefined();
});

test("one workspace alone is still shown, so the form says where it goes", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  render(
    <NewBountyPage
      {...inAcme("member")}
      onCancel={() => {}}
      onConnectRepository={() => {}}
    />,
  );
  const form = await screen.findByTestId("bounty-form");
  const workspace = within(form).getByRole("combobox", { name: "Workspace" });
  expect(workspace.textContent).toBe("Acme");
  const list = await openCombobox(workspace);
  expect(
    within(list)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Acme"]);
});

test("workspaces are offered as the rail shows them, personal first and each with its face", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  render(
    <NewBountyPage
      {...inThree()}
      onCancel={() => {}}
      onConnectRepository={() => {}}
    />,
  );
  const form = await screen.findByTestId("bounty-form");
  const workspace = within(form).getByRole("combobox", { name: "Workspace" });
  // The chosen one wears its face in the field too.
  expect(workspace.querySelector('[data-slot="avatar"]')).not.toBeNull();
  const list = await openCombobox(workspace);
  const options = within(list).getAllByRole("option");
  // The person's own is "Personal", not their name.
  expect(options.map((option) => option.textContent)).toEqual([
    "Personal",
    "Acme",
    "Beta",
  ]);
  for (const option of options) {
    expect(option.querySelector('[data-slot="avatar"]')).not.toBeNull();
  }
  // Still found by the name it no longer shows.
  await userEvent.type(
    screen.getByRole("combobox", { name: "Search workspace" }),
    "Ada",
  );
  expect(
    within(list)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Personal"]);
});

test("the repositories offered are the chosen workspace's, each marked as GitHub's", async () => {
  const betaRepo = {
    id: "ghr_2",
    connectionId: "ghc_2",
    externalId: "2",
    defaultBranch: "main",
    isPrivate: true,
    sizeKb: null,
    headSha: null,
    pushedAt: null,
    lastSyncedAt: null,
    syncError: null,
    stack: [],
    createdAt: "2026-09-30T00:00:00.000Z",
    fullName: "beta/api",
    role: "source",
    syncStatus: "ok",
  };
  vi.stubGlobal(
    "fetch",
    server([
      [
        "GET",
        "/orgs/org_2/github/repositories",
        () => json({ repositories: [betaRepo] }),
      ],
    ]).fetchMock,
  );
  render(
    <NewBountyPage
      {...inThree()}
      onCancel={() => {}}
      onConnectRepository={() => {}}
    />,
  );
  const form = await screen.findByTestId("bounty-form");
  const repository = within(form).getByRole("combobox", {
    name: "Repository",
  });
  const names = async () => {
    const list = await openCombobox(repository);
    await within(list).findByRole("option", { name: /\// });
    const options = within(list).getAllByRole("option", { name: /\// });
    // Each led by GitHub's mark; "None" is no repository, so it has none.
    for (const option of options) {
      expect(option.querySelector("svg")).not.toBeNull();
    }
    const shown = options.map((option) => option.textContent);
    await userEvent.keyboard("{Escape}");
    return shown;
  };

  expect(await names()).toEqual(["acme/app"]);
  await chooseOption(
    within(form).getByRole("combobox", { name: "Workspace" }),
    "Beta",
  );
  expect(await names()).toEqual(["beta/api"]);

  await chooseOption(repository, "beta/api");
  // The chosen one carries the mark in the field too.
  expect(repository.textContent).toBe("beta/api");
  expect(repository.querySelector("svg path")).not.toBeNull();
});

test("a repository the workspace lacks is connected in its GitHub settings", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  const onConnectRepository = vi.fn();
  render(
    <NewBountyPage
      {...inThree()}
      onCancel={() => {}}
      onConnectRepository={onConnectRepository}
    />,
  );
  const form = await screen.findByTestId("bounty-form");
  await chooseOption(
    within(form).getByRole("combobox", { name: "Workspace" }),
    "Beta",
  );
  const list = await openCombobox(
    within(form).getByRole("combobox", { name: "Repository" }),
  );
  // A link, so it can be opened in another tab; a plain click stays in the
  // app, in the workspace chosen rather than the one in the rail.
  const link = within(list).getByRole("option", { name: "New repository" });
  expect(link.getAttribute("href")).toBe("/o/beta/settings?connection=github");
  await userEvent.click(link);
  expect(onConnectRepository).toHaveBeenCalledWith(
    expect.objectContaining({ id: "org_2", slug: "beta" }),
  );
});

test("an empty workspace is offered a bounty to write", async () => {
  vi.stubGlobal("fetch", server([], []).fetchMock);
  render(<Bounties {...inAcme("member")} />);
  expect(await screen.findByText(/No bounties yet/)).toBeDefined();
});

test("writing a bounty sends what the form holds and opens it", async () => {
  const state = server([
    ["POST", "/bounties", () => json({ bounty: detail() }, 201)],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", BOUNTIES_PATH);
  render(<Shell {...inAcme("member")} />);
  const form = await openNewBounty();
  const entries = window.history.length;
  await userEvent.type(
    within(form).getByLabelText("Title"),
    "Invitations are not sent",
  );
  await chooseOption(
    within(form).getByRole("combobox", { name: "Repository" }),
    "acme/app",
  );
  await userEvent.type(
    within(form).getByLabelText("Description"),
    "One email per interview.",
  );
  await userEvent.click(
    within(form).getByRole("button", { name: "Create bounty" }),
  );

  await waitFor(() =>
    expect(state.calls.find(({ method }) => method === "POST")?.body).toEqual({
      title: "Invitations are not sent",
      description: "One email per interview.",
      repoId: "ghr_1",
      stack: [],
    }),
  );
  // The new bounty opens on the bounties page, by its title.
  const panel = await screen.findByTestId("bounty-detail");
  expect(
    within(panel).getByRole("heading", {
      level: 2,
      name: "Invitations are not sent",
    }),
  ).toBeDefined();
  expect(window.location.pathname).toBe(BOUNTIES_PATH);
  expect(window.location.search).toBe("?peek=acme/bty_7");
  // In the form's place, so Back returns to the list, not to an empty form.
  expect(window.history.length).toBe(entries);
});

test("a repository's stack carries over locked, and the person adds to it", async () => {
  const state = server([
    ["POST", "/bounties", () => json({ bounty: detail() }, 201)],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  render(
    <NewBountyPage
      {...inAcme("member")}
      onCancel={() => {}}
      onConnectRepository={() => {}}
    />,
  );
  const form = await screen.findByTestId("bounty-form");
  await userEvent.type(within(form).getByLabelText("Title"), "Export");
  const stack = within(form).getByRole("combobox", { name: "Tech stack" });

  // Something added before a repository is chosen is the person's own.
  await userEvent.type(stack, "postgres");
  await userEvent.click(
    within(form).getByRole("option", { name: "PostgreSQL" }),
  );
  expect(
    within(form).getByRole("button", { name: "Remove PostgreSQL" }),
  ).toBeDefined();

  await chooseOption(
    within(form).getByRole("combobox", { name: "Repository" }),
    "acme/app",
  );
  // The repository's chips arrive locked: no way to remove them, and the
  // PostgreSQL added earlier is now the repository's.
  const chosen = within(form).getByRole("list", {
    name: "Chosen technologies",
  });
  expect(within(chosen).getByText("TypeScript")).toBeDefined();
  expect(within(chosen).getAllByText(/detected in acme\/app/)).toHaveLength(2);
  for (const name of ["TypeScript", "PostgreSQL"]) {
    expect(
      within(form).queryByRole("button", { name: `Remove ${name}` }),
    ).toBeNull();
  }

  // The catalog no longer offers what is already there; it offers the rest,
  // and a name it lacks as typed.
  await userEvent.type(stack, "type");
  expect(within(form).queryByRole("option", { name: "TypeScript" })).toBeNull();
  await userEvent.clear(stack);
  await userEvent.type(stack, "redis");
  await userEvent.keyboard("{Enter}");
  await userEvent.type(stack, "Our mailer{Enter}");
  expect(
    within(form).getByRole("button", { name: "Remove Our mailer" }),
  ).toBeDefined();
  // Backspace in the empty field takes the last added, never a locked one.
  await userEvent.keyboard("{Backspace}");
  expect(
    within(form).queryByRole("button", { name: "Remove Our mailer" }),
  ).toBeNull();
  await userEvent.keyboard("{Backspace}{Backspace}");
  expect(within(chosen).getByText("TypeScript")).toBeDefined();
  await userEvent.type(stack, "redis{Enter}");

  await userEvent.click(
    within(form).getByRole("button", { name: "Create bounty" }),
  );
  // Only what the bounty adds is sent: the repository's follow it.
  await waitFor(() =>
    expect(
      state.calls.find(({ method }) => method === "POST")?.body,
    ).toMatchObject({ repoId: "ghr_1", stack: ["Redis"] }),
  );
});

test("a bounty is shown with its repository's stack and its own", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      [
        "GET",
        "/bounties/bty_7",
        () => json({ bounty: detail({ repoId: "ghr_1", stack: ["Redis"] }) }),
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("member")} />);
  const panel = await screen.findByTestId("bounty-detail");
  // Read as chips, the repository's locked before its own, and no picker
  // until its pencil asks for one.
  await waitFor(() =>
    expect(
      within(within(panel).getByRole("list", { name: "Tech stack" }))
        .getAllByRole("listitem")
        .map((item) => item.title),
    ).toEqual(["Detected in acme/app", "Detected in acme/app", ""]),
  );
  expect(
    within(panel).queryByRole("combobox", { name: "Tech stack" }),
  ).toBeNull();
  const pencil = within(panel).getByRole("button", {
    name: "Edit tech stack",
  });
  await userEvent.click(pencil);
  // In the picker it is changed in, the same, its own removable.
  const stack = within(panel).getByRole("list", {
    name: "Chosen technologies",
  });
  expect(
    within(stack)
      .getAllByRole("listitem")
      .map((item) => item.title),
  ).toEqual(["Detected in acme/app", "Detected in acme/app", ""]);
  expect(stack.textContent).toContain("TypeScript");
  expect(stack.textContent).toContain("PostgreSQL");
  expect(
    within(stack).getByRole("button", { name: "Remove Redis" }),
  ).toBeDefined();
  // Opened on its list; Escape closes that, then the picker, back to the
  // pencil, and the panel stays.
  const field = within(panel).getByRole("combobox", { name: "Tech stack" });
  expect(document.activeElement).toBe(field);
  expect(field.getAttribute("aria-expanded")).toBe("true");
  await userEvent.keyboard("{Escape}");
  expect(field.getAttribute("aria-expanded")).toBe("false");
  await userEvent.keyboard("{Escape}");
  expect(
    within(panel).queryByRole("combobox", { name: "Tech stack" }),
  ).toBeNull();
  expect(document.activeElement).toBe(
    within(panel).getByRole("button", { name: "Edit tech stack" }),
  );
  expect(screen.getByTestId("bounty-detail")).toBeDefined();
});

test("a bounty with no title is not sent", async () => {
  const state = server();
  vi.stubGlobal("fetch", state.fetchMock);
  render(
    <NewBountyPage
      {...inAcme("member")}
      onCancel={() => {}}
      onConnectRepository={() => {}}
    />,
  );
  const form = await screen.findByTestId("bounty-form");
  // Submitted past the browser's own check, as a script could.
  act(() => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  expect(
    await within(form).findByText("A bounty needs a title."),
  ).toBeDefined();
  expect(state.calls.some(({ method }) => method === "POST")).toBe(false);
});

test("a bounty opened mid-sizing says so, and lands on its proposal without a second Propose", async () => {
  let polls = 0;
  const state = server([
    ["GET", "/bounties/bty_7/sizing", () => json({ run: run() })],
    [
      "GET",
      "/runs/brn_1",
      () => {
        polls += 1;
        // Still at work the first time it is read.
        return json({
          run:
            polls === 1
              ? run()
              : run(
                  [
                    {
                      externalIssueId: "bty_7",
                      issueKey: null,
                      bountyId: "bty_7",
                      proposalId: "bpr_9",
                      status: "proposed",
                    },
                  ],
                  "succeeded",
                ),
        });
      },
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("admin")} />);
  const detail = await screen.findByTestId("bounty-detail");
  const part = within(detail).getByRole("region", { name: "Proposal" });
  // Nothing pressed: the bounty's own read named the run at work.
  expect(await within(part).findByText("Sizing…")).toBeDefined();
  expect(
    await within(detail).findByTestId(
      "proposal-detail",
      {},
      { timeout: 3_000 },
    ),
  ).toBeDefined();
  expect(
    state.calls.some(
      ({ method, url }) => method === "POST" && url.endsWith("/propose"),
    ),
  ).toBe(false);
});

test("an admin proposes a bounty from inside it, follows its sizing, and lands on its proposal", async () => {
  let polls = 0;
  const state = server([
    ["POST", "/bounties/bty_7/propose", () => json({ run: run() }, 202)],
    [
      "GET",
      "/runs/brn_1",
      () => {
        polls += 1;
        return json({
          run: run(
            [
              {
                externalIssueId: "bty_7",
                issueKey: null,
                bountyId: "bty_7",
                proposalId: "bpr_9",
                status: "proposed",
              },
            ],
            "succeeded",
          ),
        });
      },
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("admin")} />);
  const detail = await screen.findByTestId("bounty-detail");
  const part = within(detail).getByRole("region", { name: "Proposal" });
  await userEvent.click(within(part).getByRole("button", { name: "Propose" }));
  expect(await within(part).findByText("Sizing…")).toBeDefined();

  // The proposal takes the part's place inside the bounty, read by id, with
  // no list around it.
  const proposal = await within(detail).findByTestId(
    "proposal-detail",
    {},
    { timeout: 3_000 },
  );
  expect(polls).toBe(1);
  expect(
    within(detail).getByRole("region", { name: "Proposal" }).contains(proposal),
  ).toBe(true);
  expect(window.location.search).toBe("?tab=bounty");
  const urls = state.calls.map(({ url }) => url);
  expect(urls.some((url) => url.endsWith("/proposals/bpr_9"))).toBe(true);
  expect(urls.some((url) => url.includes("/proposals?"))).toBe(false);
  // No board: no board runs, and no live titles from Jira.
  expect(urls.some((url) => url.includes("/jira/boards/"))).toBe(false);
  expect(urls.some((url) => url.includes("/proposal-titles"))).toBe(false);

  // The bounty's text is a tab of its page already, so the proposal has no
  // Spec tab to say it again; and there is no Jira to link. Its price and
  // its scenarios share one page, with no tabs between them.
  expect(within(proposal).queryByRole("tab")).toBeNull();
  expect(within(proposal).getByTestId("proposal-bounty")).toBeDefined();
  expect(
    within(proposal)
      .getByTestId("proposal-bounty")
      .contains(within(proposal).getByTestId("proposal-spec")),
  ).toBe(true);
  expect(within(proposal).queryByText("Open in Jira")).toBeNull();
  expect(
    within(detail).queryByText(
      "Scheduling an interview sends the candidate one email.",
    ),
  ).toBeNull();
});

test("a bounty that already has a proposal opens it without sizing", async () => {
  const state = server([
    ["POST", "/bounties/bty_7/propose", () => json({ proposalId: "bpr_9" })],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("owner")} />);
  const detail = await screen.findByTestId("bounty-detail");
  await userEvent.click(
    within(detail).getByRole("button", { name: "Propose" }),
  );
  await screen.findByTestId("proposal-detail");
  expect(state.calls.some(({ url }) => url.includes("/runs/"))).toBe(false);
});

test("a bounty already being sized follows the run under way", async () => {
  const state = server([
    [
      "POST",
      "/bounties/bty_7/propose",
      () =>
        json(
          {
            code: "run_active",
            error: "This bounty is already being sized.",
            runId: "brn_1",
          },
          409,
        ),
    ],
    [
      "GET",
      "/runs/brn_1",
      () =>
        json({
          run: run(
            [
              {
                externalIssueId: "bty_7",
                issueKey: null,
                bountyId: "bty_7",
                proposalId: "bpr_9",
                status: "proposed",
              },
            ],
            "succeeded",
          ),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("admin")} />);
  const detail = await screen.findByTestId("bounty-detail");
  await userEvent.click(
    within(detail).getByRole("button", { name: "Propose" }),
  );

  await screen.findByTestId("proposal-detail");
  expect(window.location.search).toBe("?tab=bounty");
  expect(screen.queryByText("This bounty is already being sized.")).toBeNull();
});

test("a proposal that could not start, or ended without one, says why", async () => {
  const refused = server([
    [
      "POST",
      "/bounties/bty_7/propose",
      () =>
        json(
          {
            code: "rate_card_required",
            error: "Set a rate card before proposing.",
          },
          409,
        ),
    ],
  ]);
  vi.stubGlobal("fetch", refused.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  const { unmount } = render(<Shell {...inAcme("owner")} />);
  const detail = await screen.findByTestId("bounty-detail");
  await userEvent.click(
    within(detail).getByRole("button", { name: "Propose" }),
  );
  expect(
    await within(detail).findByText("Set a rate card before proposing."),
  ).toBeDefined();
  unmount();

  const failed = server([
    [
      "POST",
      "/bounties/bty_7/propose",
      () =>
        json(
          {
            run: {
              ...run([], "failed"),
              fatalErrorCode: "reconnect",
            },
          },
          202,
        ),
    ],
  ]);
  vi.stubGlobal("fetch", failed.fetchMock);
  render(<Shell {...inAcme("owner")} />);
  const again = await screen.findByTestId("bounty-detail");
  await userEvent.click(within(again).getByRole("button", { name: "Propose" }));
  expect(await within(again).findByText(/needs reconnecting/)).toBeDefined();
});

test("a bounty following Jira is edited for its repository only", async () => {
  const state = server([
    [
      "GET",
      "/bounties/bty_1",
      () =>
        json({
          bounty: detail({
            ...fromJira,
            description: "Export the filtered table.",
          }),
        }),
    ],
    [
      "PATCH",
      "/bounties/bty_1",
      () =>
        json({
          bounty: detail({ ...fromJira, repoId: "ghr_1", revision: 2 }),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_1");
  render(<Shell {...inAcme("member")} />);

  const panel = await screen.findByTestId("bounty-detail");
  const links = within(panel).getByRole("region", { name: "Links" });
  expect(
    within(links).getByText(/Its title and description follow/),
  ).toBeDefined();
  expect(
    within(links).getByRole("link", { name: /APP-1/ }).getAttribute("href"),
  ).toBe("https://acme.atlassian.net/browse/APP-1");

  // Its text is Jira's: shown, and not offered.
  expect(within(panel).queryByRole("button", { name: "Rename" })).toBeNull();
  expect(
    within(panel).queryByRole("button", { name: "Edit description" }),
  ).toBeNull();
  // Its repository is picked from its card under the text, and saved on
  // the pick.
  await chooseOption(
    within(links).getByRole("combobox", { name: "Repository" }),
    "acme/app",
  );
  await waitFor(() =>
    expect(state.calls.find(({ method }) => method === "PATCH")?.body).toEqual({
      expectedRevision: 1,
      repoId: "ghr_1",
    }),
  );
  expect(await screen.findByTestId("bounty-detail")).toBeDefined();
});

const jiraConnection = {
  id: "jrc_1",
  cloudId: "cloud-1",
  siteUrl: "https://acme.atlassian.net",
  siteName: "Acme",
  email: "dana@example.test",
  healthy: true,
  scopes: ["read:jira-work"],
  resourceScopes: ["read:jira-work"],
  writeGranted: false,
  createdAt: stamp,
};

function foundIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "100",
    key: "APP-9",
    summary: "Export the table",
    status: "To Do",
    issueType: "Task",
    boardId: "jrb_1",
    boardName: "App board",
    bountyId: null,
    ...overrides,
  };
}

test("a bounty's Jira issue is found across the boards and linked once asked", async () => {
  const state = server([
    ["GET", "/jira/connections", () => json({ connections: [jiraConnection] })],
    [
      "GET",
      "/jira/search?q=",
      () =>
        json({
          issues: [
            foundIssue(),
            foundIssue({ id: "200", key: "APP-3", bountyId: "bty_other" }),
          ],
        }),
    ],
    [
      "PUT",
      "/bounties/bty_7/jira",
      () =>
        json({
          bounty: detail({
            title: "Export the table",
            revision: 2,
            jira: {
              ...jiraLink,
              key: "APP-9",
              url: "https://acme.atlassian.net/browse/APP-9",
            },
          }),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  render(<Shell {...inAcme("member")} />);
  const page = await screen.findByTestId("bounty-detail");
  const links = within(page).getByRole("region", { name: "Links" });

  const list = await openCombobox(
    await within(links).findByRole("button", { name: "Jira issue" }),
  );
  // Under the results, the way to the workspace's Jira settings.
  expect(
    within(list)
      .getByRole("option", { name: "Manage Jira accounts" })
      .getAttribute("href"),
  ).toBe("/o/acme/settings?connection=jira");

  await userEvent.type(
    screen.getByRole("combobox", { name: "Search jira issue" }),
    "export",
  );
  // Each row as the board's own search lists them: key, summary, board.
  const found = await within(list).findByRole("option", {
    name: /APP-9.*Export the table.*App board/,
  });
  // Every board is searched at once, by what was typed.
  expect(
    state.calls.some(({ url }) => url.endsWith("/jira/search?q=export")),
  ).toBe(true);
  // An issue that is another bounty's is listed, and not offered.
  expect(
    within(list)
      .getByRole("option", { name: /APP-3/ })
      .getAttribute("aria-disabled"),
  ).toBe("true");

  // Its own text would be replaced, so it asks first.
  await userEvent.click(found);
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Link APP-9?")).toBeDefined();
  expect(state.calls.some(({ method }) => method === "PUT")).toBe(false);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Link issue" }),
  );
  await waitFor(() =>
    expect(state.calls.find(({ method }) => method === "PUT")?.body).toEqual({
      boardId: "jrb_1",
      issueId: "100",
    }),
  );
  expect(
    await within(links).findByText(/Its title and description follow/),
  ).toBeDefined();
  expect(
    within(links).getByRole("link", { name: /APP-9/ }).getAttribute("href"),
  ).toBe("https://acme.atlassian.net/browse/APP-9");
});

test("a bounty's Jira issue is let go from the same list, keeping its text", async () => {
  const state = server([
    ["GET", "/jira/connections", () => json({ connections: [jiraConnection] })],
    [
      "GET",
      "/bounties/bty_1",
      () => json({ bounty: detail({ ...fromJira, description: "Jira's." }) }),
    ],
    [
      "DELETE",
      "/bounties/bty_1/jira",
      () =>
        json({
          bounty: detail({ ...fromJira, description: "Jira's.", jira: null }),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_1");
  render(<Shell {...inAcme("member")} />);
  const page = await screen.findByTestId("bounty-detail");
  const links = within(page).getByRole("region", { name: "Links" });
  await chooseOption(
    await within(links).findByRole("button", { name: "Jira issue" }),
    "Remove the link",
  );
  await waitFor(() =>
    expect(
      state.calls.some(
        ({ method, url }) => method === "DELETE" && url.endsWith("/jira"),
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(
      within(links).getByRole("button", { name: "Jira issue" }).textContent,
    ).toBe("None"),
  );
});

test("with no Jira account, the picker says so and leads to settings", async () => {
  vi.stubGlobal(
    "fetch",
    server([["GET", "/jira/connections", () => json({ connections: [] })]])
      .fetchMock,
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  render(<Shell {...inAcme("member")} />);
  const page = await screen.findByTestId("bounty-detail");
  const links = within(page).getByRole("region", { name: "Links" });
  expect(
    await within(links).findByText(
      "No Jira account is connected to the workspace.",
    ),
  ).toBeDefined();
  const list = await openCombobox(
    within(links).getByRole("button", { name: "Jira issue" }),
  );
  expect(within(list).getByText("No Jira account is connected.")).toBeDefined();
  const connect = within(list).getByRole("option", {
    name: "Connect Jira in settings",
  });
  expect(connect.getAttribute("href")).toBe("/o/acme/settings?connection=jira");
  await userEvent.click(connect);
  expect(window.location.pathname + window.location.search).toBe(
    "/o/acme/settings?connection=jira",
  );
});

test("a stale edit says so and shows the bounty as it is now", async () => {
  const state = server([
    [
      "PATCH",
      "/bounties/bty_7",
      () =>
        json(
          {
            code: "bounty_changed",
            error: "The bounty changed. Reload it before saving.",
            bounty: detail({
              revision: 3,
              title: "Invitations go to the wrong address",
            }),
          },
          409,
        ),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("member")} />);
  const panel = await screen.findByTestId("bounty-detail");
  await userEvent.click(within(panel).getByRole("button", { name: "Rename" }));
  await userEvent.type(within(panel).getByLabelText("Title"), "!{Enter}");

  // The field holds their version now, so a second save cannot undo it.
  expect(
    await within(panel).findByText(/Someone changed this bounty/),
  ).toBeDefined();
  const title = within(panel).getByLabelText("Title") as HTMLInputElement;
  expect(title.value).toBe("Invitations go to the wrong address");
  await userEvent.type(title, "!{Enter}");
  await waitFor(() =>
    expect(
      state.calls.filter(({ method }) => method === "PATCH").at(-1)?.body,
    ).toEqual({
      expectedRevision: 3,
      title: "Invitations go to the wrong address!",
    }),
  );
});

test("an edit sends only what changed, and nothing when nothing did", async () => {
  const state = server([
    [
      "PATCH",
      "/bounties/bty_7",
      () =>
        json({
          bounty: detail({ title: "Invitations are not sent!", revision: 2 }),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("member")} />);

  const panel = await screen.findByTestId("bounty-detail");
  const rename = () =>
    userEvent.click(within(panel).getByRole("button", { name: "Rename" }));
  // Opened and left as it was: nothing to send.
  await rename();
  await userEvent.type(within(panel).getByLabelText("Title"), "{Enter}");
  expect(within(panel).queryByLabelText("Title")).toBeNull();
  // Opened, changed and put back with Escape: nothing either.
  await rename();
  await userEvent.type(within(panel).getByLabelText("Title"), "?{Escape}");
  expect(within(panel).queryByLabelText("Title")).toBeNull();
  expect(state.calls.some(({ method }) => method === "PATCH")).toBe(false);

  await rename();
  await userEvent.type(within(panel).getByLabelText("Title"), "!{Enter}");
  await waitFor(() =>
    expect(state.calls.find(({ method }) => method === "PATCH")?.body).toEqual({
      expectedRevision: 1,
      title: "Invitations are not sent!",
    }),
  );
});

test("a bounty is not asked for a type, a priority or labels", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  render(
    <NewBountyPage
      {...inAcme("member")}
      onCancel={() => {}}
      onConnectRepository={() => {}}
    />,
  );
  const form = await screen.findByTestId("bounty-form");
  for (const label of ["Type", "Priority", "Labels"]) {
    expect(within(form).queryByLabelText(label)).toBeNull();
  }
});

test("a bounty that cannot be deleted says why, once", async () => {
  const state = server([
    [
      "DELETE",
      "/bounties/bty_7",
      () =>
        json(
          {
            code: "bounty_in_use",
            error:
              "This bounty has a proposal or a sandbox, or is being sized, so it cannot be deleted.",
          },
          409,
        ),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  render(<Shell {...inAcme("admin")} />);
  const page = await screen.findByTestId("bounty-detail");
  await userEvent.click(
    within(page).getByRole("button", { name: "Delete bounty" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Delete bounty" }),
  );
  await screen.findByText(/is being sized, so it cannot be deleted/);
  expect(
    screen.getAllByText(/is being sized, so it cannot be deleted/),
  ).toHaveLength(1);
  expect(window.location.pathname).toBe("/bounties/acme/bty_7");
});

test("a bounty that no longer exists says so", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      ["GET", "/bounties/bty_gone", () => json({ error: "Not found" }, 404)],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties?peek=acme/bty_gone");
  render(<Bounties {...inAcme("member")} />);
  expect(
    await screen.findByText("This bounty no longer exists."),
  ).toBeDefined();
});

test("a bounty that could not be read is offered again, not called gone", async () => {
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    server([
      [
        "GET",
        "/bounties/bty_7",
        () => {
          reads += 1;
          return reads === 1
            ? json({ error: "Internal" }, 500)
            : json({ bounty: detail() });
        },
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties?peek=acme/bty_7");
  render(<Bounties {...inAcme("member")} />);
  expect(await screen.findByText("Could not load the bounty.")).toBeDefined();
  expect(screen.queryByText("This bounty no longer exists.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByTestId("bounty-detail")).toBeDefined();
});

test("a link to a bounty past the loaded rows still names its panel", async () => {
  vi.stubGlobal("fetch", server([], []).fetchMock);
  window.history.replaceState(null, "", "/bounties?peek=acme/bty_7");
  render(<Bounties {...inAcme("member")} />);
  await screen.findByTestId("bounty-detail");
  expect(
    screen.getByRole("dialog", { name: "Invitations are not sent" }),
  ).toBeDefined();
});

test("a bounty's description is written where it is read", async () => {
  const state = server([
    [
      "PATCH",
      "/bounties/bty_7",
      () =>
        json({
          bounty: detail({ description: "Send it once.", revision: 2 }),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  render(<Shell {...inAcme("member")} />);
  const page = await screen.findByTestId("bounty-detail");
  const section = within(page).getByRole("region", { name: "Describe task" });

  // The text is read, not a way in: its pencil is.
  await userEvent.click(
    within(section).getByText(
      "Scheduling an interview sends the candidate one email.",
    ),
  );
  expect(within(section).queryByRole("textbox")).toBeNull();
  // Opened and put back with Cancel, focus back on the pencil.
  await userEvent.click(
    within(section).getByRole("button", { name: "Edit description" }),
  );
  await userEvent.click(
    within(section).getByRole("button", { name: "Cancel" }),
  );
  expect(within(section).queryByRole("textbox")).toBeNull();
  expect(document.activeElement).toBe(
    within(section).getByRole("button", { name: "Edit description" }),
  );

  await userEvent.click(
    within(section).getByRole("button", { name: "Edit description" }),
  );
  const field = within(section).getByRole("textbox", { name: "Describe task" });
  await userEvent.clear(field);
  await userEvent.type(field, "Send it once.");
  await userEvent.click(within(section).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(state.calls.find(({ method }) => method === "PATCH")?.body).toEqual({
      expectedRevision: 1,
      description: "Send it once.",
    }),
  );
  expect(await within(section).findByText("Send it once.")).toBeDefined();
  expect(within(section).queryByRole("textbox")).toBeNull();
});

test("a bounty from Jira is named by its issue's key, and one written here by its title alone", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      [
        "GET",
        "/bounties/bty_1",
        () => json({ bounty: detail({ ...fromJira, description: "Export." }) }),
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties?peek=acme/bty_1");
  const { unmount } = render(<Bounties {...inAcme("member")} />);
  await screen.findByTestId("bounty-detail");
  expect(
    within(screen.getByTestId("bounty-panel")).getByText("APP-1"),
  ).toBeDefined();
  unmount();

  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  render(
    <BountyPage
      organizations={inAcme("member").organizations}
      organizationsLoading={false}
      viewer={viewer}
      onTitle={() => {}}
      onOpenBounties={() => {}}
      onOpenSettings={() => {}}
    />,
  );
  await screen.findByTestId("bounty-detail");
  expect(screen.queryByText(/^B-\d+$/)).toBeNull();
});

test("the page lists bounties alone; a bounty opens over them without its proposal, and Back steps out", async () => {
  vi.stubGlobal(
    "fetch",
    server(
      [],
      [
        summary({
          proposal: {
            id: "bpr_9",
            status: "proposed",
            complexity: "M",
            amountMinor: 10_500,
            currency: "USD",
          },
        }),
      ],
    ).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties");
  render(<Bounties {...inAcme("member")} />);
  const list = await screen.findByTestId("bounty-list");
  expect(screen.queryByRole("tab", { name: "Proposals" })).toBeNull();
  // Not proposable from the row: a proposal is made inside its bounty.
  expect(within(list).queryByRole("button", { name: "Propose" })).toBeNull();
  // Not approved, so its price is not settled: a dash, not $105.
  const brief = within(list).getByTestId("proposal-brief");
  expect(brief.textContent).toContain("—");
  expect(brief.textContent).not.toContain("105");

  await userEvent.click(
    within(list).getByRole("link", { name: "Invitations are not sent" }),
  );
  expect(window.location.search).toBe("?peek=acme/bty_7");
  const detail = await screen.findByTestId("bounty-detail");
  // Read on its page, which the panel opens.
  expect(within(detail).queryByTestId("proposal-detail")).toBeNull();

  window.history.replaceState(null, "", "/bounties");
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => expect(screen.queryByTestId("bounty-detail")).toBeNull());
});

test("an address from when proposals had a tab opens the proposal on its bounty's page", async () => {
  vi.stubGlobal("fetch", server([proposed]).fetchMock);
  window.history.replaceState(
    null,
    "",
    "/bounties?workspace=acme&tab=proposals&proposal=bpr_9",
  );
  render(<Shell {...inAcme("member")} />);
  await waitFor(() =>
    expect(window.location.pathname + window.location.search).toBe(
      "/bounties/acme/bty_7?tab=bounty",
    ),
  );
  expect(await screen.findByTestId("proposal-detail")).toBeDefined();
});

test("the bounties page has a path and a trail of its own", () => {
  // Every workspace's, so under none of them.
  expect(screenForPath("/bounties")).toBe("bounties");
  expect(screenForPath("/bounties/")).toBe("bounties");
  expect(pathForScreen("bounties", "acme")).toBe("/bounties");
  expect(pathForScreen("bounties")).toBe("/bounties");
  // Where one workspace's bounties lived, and where they lived while they
  // were called tickets, still land here. An open bounty is carried over
  // under its new name, with the workspace the path named.
  expect(screenForPath("/o/acme/bounties")).toBe("bounties");
  expect(screenForPath("/o/acme/tickets")).toBe("bounties");
  expect(screenForPath("/o/acme/bounties/more")).toBe("org-settings");
  expect(canonicalUrl("/o/acme/bounties", "")).toBe("/bounties");
  expect(canonicalUrl("/o/acme/tickets", "")).toBe("/bounties");
  expect(canonicalUrl("/o/acme/bounties", "?bounty=bty_1")).toBe(
    "/bounties?peek=acme/bty_1",
  );
  expect(canonicalUrl("/o/acme/tickets/", "?ticket=tkt_1&tab=proposals")).toBe(
    "/bounties?peek=acme/tkt_1",
  );
  // A proposal with no bounty keeps its workspace; the page reads it for
  // the bounty it belongs to.
  expect(canonicalUrl("/o/acme/bounties", "?proposal=bpr_9")).toBe(
    "/bounties?workspace=acme&proposal=bpr_9",
  );
  expect(
    canonicalUrl("/bounties", "?workspace=acme&proposal=bpr_9"),
  ).toBeUndefined();
  expect(canonicalUrl("/o/acme/tickets/more", "")).toBeUndefined();
  // The query the page wrote before `?peek=`, in either order.
  expect(canonicalUrl("/bounties", "?bounty=bty_1&workspace=acme")).toBe(
    "/bounties?peek=acme/bty_1",
  );
  // With its proposal, on the bounty's page, where the proposal is read.
  expect(
    canonicalUrl("/bounties", "?workspace=acme&bounty=bty_1&proposal=bpr_9"),
  ).toBe("/bounties/acme/bty_1?tab=bounty");
  // `/proposal` after a bounty's address named its Proposal tab; the
  // proposal is part of the bounty now, on its page's Bounty tab, which a
  // panel's address opens too, as the panel does not show it.
  expect(canonicalUrl("/bounties", "?peek=acme/bty_1/proposal")).toBe(
    "/bounties/acme/bty_1?tab=bounty",
  );
  expect(canonicalUrl("/bounties", "?peek=acme%2Fbty_1%2Fproposal")).toBe(
    "/bounties/acme/bty_1?tab=bounty",
  );
  expect(canonicalUrl("/bounties/acme/bty_1/proposal/", "?x=1")).toBe(
    "/bounties/acme/bty_1?x=1&tab=bounty",
  );
  // A bounty whose id is the word is that bounty, and left alone.
  expect(canonicalUrl("/bounties/acme/proposal", "")).toBeUndefined();
  expect(canonicalUrl("/bounties", "?peek=acme/proposal")).toBeUndefined();
  expect(canonicalUrl("/bounties/acme/bty_1/sandbox", "")).toBeUndefined();
  // Naming no workspace, it names nothing that can be opened.
  expect(canonicalUrl("/bounties", "?bounty=bty_1")).toBe("/bounties");
  expect(canonicalUrl("/bounties", "?tab=proposals")).toBe("/bounties");
  expect(canonicalUrl("/bounties", "?peek=acme/bty_1")).toBeUndefined();
  expect(canonicalUrl("/bounties", "")).toBeUndefined();
  expect(
    trailFor("bounties", { name: "Acme", slug: "acme" }).map(
      ({ label }) => label,
    ),
  ).toEqual(["Home", "Bounties"]);
});

test("a bounty is addressed the same in the panel and on its own page", () => {
  const address = { workspace: "acme", id: "bty_1" };
  expect(bountiesUrl(address)).toBe("/bounties?peek=acme/bty_1");
  expect(bountyPagePath(address)).toBe("/bounties/acme/bty_1");
  expect(bountiesUrl(null)).toBe("/bounties");

  // `/proposal` after it is the same bounty: its proposal was a tab once.
  for (const path of [
    "/bounties/acme/bty_1",
    "/bounties/acme/bty_1/",
    "/bounties/acme/bty_1/proposal",
  ]) {
    expect(screenForPath(path)).toBe("bounty");
    expect(bountyForPath(path)).toEqual(address);
  }
  expect(bountyForSearch("?peek=acme/bty_1")).toEqual(address);
  // As `URLSearchParams` would write it.
  expect(bountyForSearch("?peek=acme%2Fbty_1%2Fproposal")).toEqual(address);
  // A workspace named "new" does not take the form's page, nor it theirs.
  expect(bountyForPath("/bounties/new")).toBeUndefined();
  expect(bountyForPath("/bounties/new/bty_1")?.workspace).toBe("new");
  for (const nothing of [
    "/bounties",
    "/bounties/acme",
    "/bounties/acme/bty_1/sandbox",
    "/bounties/acme/bty_1/proposal/more",
    "/o/acme/bounties/bty_1",
  ]) {
    expect(bountyForPath(nothing)).toBeUndefined();
  }
  expect(bountyForSearch("")).toBeUndefined();
  expect(bountyForSearch("?peek=acme")).toBeUndefined();
  expect(pathForScreen("bounty")).toBe("/bounties");
  expect(canonicalUrl("/bounties/acme/bty_1", "")).toBeUndefined();

  const trail = trailFor("bounty", undefined, undefined, "Export to CSV");
  expect(trail.map(({ label }) => label)).toEqual([
    "Home",
    "Bounties",
    "Export to CSV",
  ]);
  expect(trail[1]?.screen).toBe("bounties");
  // Then the workspace it is in, once known, leading to its page.
  const inWorkspace = trailFor(
    "bounty",
    undefined,
    undefined,
    "Export to CSV",
    {
      name: "Personal",
      slug: "lovelace-ada",
    },
  );
  expect(inWorkspace.map(({ label }) => label)).toEqual([
    "Home",
    "Bounties",
    "Personal",
    "Export to CSV",
  ]);
  expect(inWorkspace[2]).toMatchObject({
    screen: "org-settings",
    slug: "lovelace-ada",
  });
  // Until the bounty is read, the crumb says what it will be.
  expect(trailFor("bounty").at(-1)?.label).toBe("Bounty");
});

test("a new bounty's page sits under the bounties", () => {
  expect(screenForPath("/bounties/new")).toBe("new-bounty");
  expect(screenForPath("/bounties/new/")).toBe("new-bounty");
  expect(pathForScreen("new-bounty", "acme")).toBe("/bounties/new");
  expect(canonicalUrl("/bounties/new", "")).toBeUndefined();
  const trail = trailFor("new-bounty");
  expect(trail.map(({ label }) => label)).toEqual([
    "Home",
    "Bounties",
    "New bounty",
  ]);
  expect(trail[1]?.screen).toBe("bounties");
});

test("a bounty's panel is read, its text over its sandbox, with context that is optional", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  window.history.replaceState(null, "", "/bounties?peek=acme/bty_7");
  // An admin, who could change all of it on its page.
  render(<Bounties {...inAcme("admin")} />);

  const panel = await screen.findByTestId("bounty-detail");
  const text = within(panel).getByRole("region", { name: "Description" });
  expect(
    within(text).getByText(
      "Scheduling an interview sends the candidate one email.",
    ),
  ).toBeDefined();
  // Read, not changed: no pencil and no button anywhere in it.
  expect(within(panel).queryByRole("button")).toBeNull();
  expect(within(panel).queryByRole("combobox")).toBeNull();
  // Its proposal is on its page.
  expect(within(panel).queryByRole("region", { name: "Proposal" })).toBeNull();
  // Named where it lives, with no way to move it.
  const workspacePart = within(panel).getByRole("region", {
    name: "Workspace",
  });
  expect(within(workspacePart).getByText("Acme")).toBeDefined();
  expect(within(workspacePart).queryByRole("combobox")).toBeNull();
  expect(within(panel).queryByRole("region", { name: "Bounty" })).toBeNull();
  // Its price heads its sandbox, where the work it pays for is done.
  const sandboxPart = within(panel).getByRole("region", { name: "Sandbox" });
  // With no approved proposal, neither its price nor its size is settled.
  expect(within(sandboxPart).getAllByText("—")).toHaveLength(2);
  // Said plainly: making one is offered on its page.
  expect(within(sandboxPart).getByText("No sandbox yet.")).toBeDefined();
  const context = within(panel).getByRole("region", { name: "Context" });
  // No Jira issue, no repository and no stack, each read as none.
  expect(within(context).getAllByText("None")).toHaveLength(3);
});

test("an admin makes a bounty's sandbox from its repository, and sees it after", async () => {
  let made = false;
  const state = server([
    [
      "POST",
      "/sandboxes",
      () => {
        made = true;
        return json(
          {
            sandbox: {
              id: "sbx_1",
              slug: "abc123def456",
              status: "draft",
              publicRepoId: null,
              currentVersionId: null,
              expiresAt: null,
              bountyId: "bty_7",
              sourceRepoId: "ghr_1",
              createdAt: stamp,
              updatedAt: stamp,
            },
          },
          201,
        );
      },
    ],
    [
      "GET",
      "/bounties/bty_7",
      () =>
        json({
          bounty: detail({
            repoId: "ghr_1",
            sandbox: made ? sandboxOf({ sourceRepoId: "ghr_1" }) : null,
          }),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("owner")} />);

  const panel = await screen.findByTestId("bounty-detail");
  const sandboxPart = within(panel).getByRole("region", { name: "Sandbox" });
  await userEvent.click(
    within(sandboxPart).getByRole("button", { name: "Create sandbox" }),
  );
  await waitFor(() =>
    expect(
      state.calls.find(
        ({ method, url }) => method === "POST" && url.includes("/sandboxes"),
      )?.body,
    ).toEqual({ bountyId: "bty_7", sourceRepoId: "ghr_1" }),
  );
  // Where it stands is in the page's summary, beside the tabs.
  const after = within(await screen.findByTestId("bounty-detail")).getByRole(
    "region",
    { name: "Bounty" },
  );
  await waitFor(() => expect(within(after).getByText("Draft")).toBeDefined());
  expect(within(after).getByText("No version published yet.")).toBeDefined();
});

test("a sandbox that could not be made says why, and the bounty stays as it was", async () => {
  const state = server([
    [
      "POST",
      "/sandboxes",
      () =>
        json(
          {
            error: "This bounty already has a sandbox.",
            code: "bounty_has_sandbox",
          },
          409,
        ),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("owner")} />);

  const panel = await screen.findByTestId("bounty-detail");
  const sandboxPart = within(panel).getByRole("region", { name: "Sandbox" });
  await userEvent.click(
    within(sandboxPart).getByRole("button", { name: "Create sandbox" }),
  );
  expect((await within(sandboxPart).findByRole("alert")).textContent).toContain(
    "This bounty already has a sandbox.",
  );
  // Written here with no repository: the sandbox is asked for without one.
  expect(state.calls.find(({ method }) => method === "POST")?.body).toEqual({
    bountyId: "bty_7",
    sourceRepoId: null,
  });
});

test("a bounty's row leaves its sandbox to the bounty", async () => {
  vi.stubGlobal(
    "fetch",
    server(
      [],
      [
        summary({
          sandbox: sandboxOf({
            status: "published",
            currentVersionId: "sbv_1",
            sourceRepoId: "ghr_1",
          }),
        }),
        fromJira,
      ],
    ).fetchMock,
  );
  render(<Bounties {...inAcme("member")} />);
  const rows = within(await screen.findByTestId("bounty-list")).getAllByRole(
    "listitem",
  );
  // A sandbox is shown inside the bounty, not on its row.
  expect(within(rows[0]!).queryByText(/^Sandbox /)).toBeNull();
  expect(within(rows[1]!).queryByText(/^Sandbox /)).toBeNull();
});

/** A bounty's sandbox in brief, as the bounty reads with it. */
/** The bounty's proposal, as its detail names it: approved unless said. */
const approvedSummary = {
  id: "bpr_7",
  status: "approved",
  complexity: "S",
  amountMinor: 5_800,
  currency: "USD",
};
/** A sandbox as its own routes answer it: no build, which a bounty's adds. */
function sandboxRecord(overrides: Record<string, unknown> = {}) {
  const { build: _build, ...record } = sandboxOf(overrides);
  return record;
}

function sandboxOf(overrides: Record<string, unknown> = {}) {
  return {
    id: "sbx_1",
    status: "draft",
    currentVersionId: null,
    expiresAt: null,
    sourceRepoId: null,
    build: null,
    ...overrides,
  };
}

test("a bounty with a sandbox is kept, and its panel says how far the sandbox got", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      [
        "GET",
        "/bounties/bty_7",
        () =>
          json({
            bounty: detail({
              repoId: "ghr_1",
              sandbox: sandboxOf({
                status: "published",
                currentVersionId: "sbv_1",
                sourceRepoId: "ghr_1",
              }),
            }),
          }),
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties?peek=acme/bty_7");
  render(<Bounties {...inAcme("admin")} />);
  const panel = await screen.findByTestId("bounty-detail");
  const part = within(panel).getByRole("region", { name: "Sandbox" });
  // The pill opens the published sandbox, in a tab of its own.
  const pill = within(part).getByRole("link", { name: /Published/ });
  expect(pill.getAttribute("href")).toBe("/sandboxes/acme/sbv_1");
  expect(pill.getAttribute("target")).toBe("_blank");
  expect(pill.querySelector("svg")).not.toBeNull();
  expect(
    within(part).getByText("Contributors can work in its published version."),
  ).toBeDefined();
  // Cut from its repository: nothing is generated for it.
  expect(within(part).queryByRole("button", { name: /Generate/ })).toBeNull();
  // Deleting it would only be refused: a sandbox keeps its bounty.
  expect(
    within(panel).queryByRole("button", { name: "Delete bounty" }),
  ).toBeNull();
});

test("an admin links the bounty's repository to a sandbox made without one", async () => {
  let linked = false;
  const state = server([
    [
      "PUT",
      "/sandboxes/sbx_1/source",
      () => {
        linked = true;
        return json({
          sandbox: {
            id: "sbx_1",
            slug: "abc123def456",
            status: "draft",
            publicRepoId: null,
            currentVersionId: null,
            expiresAt: null,
            bountyId: "bty_7",
            sourceRepoId: "ghr_1",
            createdAt: stamp,
            updatedAt: stamp,
          },
        });
      },
    ],
    [
      "GET",
      "/bounties/bty_7",
      () =>
        json({
          bounty: detail({
            repoId: "ghr_1",
            sandbox: sandboxOf({ sourceRepoId: linked ? "ghr_1" : null }),
          }),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("admin")} />);

  const panel = await screen.findByTestId("bounty-detail");
  const part = within(panel).getByRole("region", { name: "Sandbox" });
  // It can be generated from the bounty, or sliced once the repository is linked.
  expect(
    await within(part).findByRole("button", { name: "Generate" }),
  ).toBeDefined();
  expect(
    within(part).getByText(/Or link the bounty's repository/),
  ).toBeDefined();
  await userEvent.click(
    await within(part).findByRole("button", { name: "Link acme/app" }),
  );
  await waitFor(() =>
    expect(state.calls.find(({ method }) => method === "PUT")?.body).toEqual({
      sourceRepoId: "ghr_1",
    }),
  );
  await waitFor(() =>
    expect(
      within(
        within(screen.getByTestId("bounty-detail")).getByRole("region", {
          name: "Sandbox",
        }),
      ).queryByText(/Or link the bounty's repository/),
    ).toBeNull(),
  );
  // Its versions are sliced from the repository now, not generated.
  expect(
    within(screen.getByTestId("bounty-detail")).queryByRole("button", {
      name: /Generate/,
    }),
  ).toBeNull();
});

test("a sandbox without a repository says what links one, and a refused link says why", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      [
        "PUT",
        "/sandboxes/sbx_1/source",
        () =>
          json(
            {
              error: "This sandbox is already cut from another repository.",
              code: "source_linked",
            },
            409,
          ),
      ],
      [
        "GET",
        "/bounties/bty_7",
        () =>
          json({ bounty: detail({ repoId: "ghr_1", sandbox: sandboxOf() }) }),
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("owner")} />);
  const part = within(await screen.findByTestId("bounty-detail")).getByRole(
    "region",
    { name: "Sandbox" },
  );
  await userEvent.click(
    await within(part).findByRole("button", { name: "Link acme/app" }),
  );
  expect((await within(part).findByRole("alert")).textContent).toContain(
    "already cut from another repository",
  );
  expect(
    within(part).getByText(/Or link the bounty's repository/),
  ).toBeDefined();
});

test("a sandbox whose bounty names no repository generates its versions instead", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      [
        "GET",
        "/bounties/bty_7",
        () =>
          json({
            bounty: detail({ sandbox: sandboxOf(), proposal: approvedSummary }),
          }),
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("admin")} />);
  const part = within(await screen.findByTestId("bounty-detail")).getByRole(
    "region",
    { name: "Sandbox" },
  );
  expect(
    await within(part).findByText(
      /No version yet\. Generate one: an agent writes a starter from the bounty's title, description and tech stack/,
    ),
  ).toBeDefined();
  // Nothing to link: the only way forward is to generate.
  expect(
    within(part)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Generate"]);
});

test("a member is told who generates a sandbox's versions", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      [
        "GET",
        "/bounties/bty_7",
        () =>
          json({
            bounty: detail({
              repoId: "ghr_1",
              sandbox: sandboxOf(),
              proposal: approvedSummary,
            }),
          }),
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("member")} />);
  const part = within(await screen.findByTestId("bounty-detail")).getByRole(
    "region",
    { name: "Sandbox" },
  );
  expect(
    await within(part).findByText(
      /No version yet\. An owner or admin can generate one from the bounty\./,
    ),
  ).toBeDefined();
  expect(within(part).queryByRole("button")).toBeNull();
});

/** A generated version, its private source and its starter run. */
const generatedVersion = {
  id: "sbv_1",
  sandboxId: "sbx_1",
  version: 1,
  title: "Invitations are not sent",
  specSummary: "Scheduling an interview sends the candidate one email.",
  complexity: "unsized",
  tags: [],
  testSummary: [],
  publicBaseCommitSha: null,
  readme: null,
  languages: null,
  frozenAt: null,
  createdAt: stamp,
};
const generatedSource = {
  sandboxVersionId: "sbv_1",
  origin: "starter",
  sourceSnapshotId: null,
  sourceCommitSha: null,
  sliceRunId: null,
  manifestSha256: null,
  contractSha256: null,
  starterRunId: "arn_starter",
  starterSha256: null,
  transformConfigSha256: "t".repeat(64),
  approvedTaskSha256: "a".repeat(64),
  proposalVersion: 1,
  aliasRules: [],
  dependencyChoices: {},
  acceptanceTests: [],
  fixtures: null,
  approvedTask: {
    schemaVersion: 3,
    title: "Invitations are not sent",
    summary: "Scheduling an interview sends the candidate one email.",
    spec: null,
    pricing: {
      proposalId: "bpr_7",
      proposalRevision: 2,
      complexity: "M",
      amountMinor: 200,
      currency: "USD",
      status: "approved",
      decidedAt: stamp,
    },
    selectedBy: "user_1",
    selectedAt: stamp,
    bountyId: "bty_7",
  },
  scope: {
    editablePaths: [],
    generatedPaths: [],
    permittedOperations: ["edit", "add"],
    dependencies: [],
    blockers: [],
  },
  harnessSha256: null,
  toolchainDigest: null,
  buildRunId: "arn_starter",
  roundTripRunId: null,
  disclosureRunId: null,
  approvedBy: null,
  approvedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
};
function starterRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "arn_starter",
    snapshotId: null,
    repoId: null,
    tool: "sandbox_starter",
    toolVersion: "sandbox_starter@1",
    params: {
      deadlineMinutes: 60,
      agent: "starter",
      sandboxVersionId: "sbv_1",
      approvedTaskSha256: "a".repeat(64),
      stack: [],
    },
    status: "running",
    attempt: 0,
    maxAttempts: 2,
    errorCode: null,
    errorDetail: null,
    startedAt: stamp,
    finishedAt: null,
    deadlineAt: null,
    createdAt: stamp,
    ...overrides,
  };
}
function artifactOf(kind: string, meta: Record<string, unknown>) {
  return {
    id: `art_${kind}`,
    runId: "arn_starter",
    kind,
    path: `${kind}.json`,
    contentType: "application/json",
    sizeBytes: 1,
    sha256: "f".repeat(64),
    meta,
    createdAt: stamp,
  };
}
/** A sandbox with no repository, whose versions and run answer as given. */
function generatingServer(input: {
  versions: () => unknown[];
  run?: () => Record<string, unknown>;
  artifacts?: unknown[];
  generate?: () => Promise<Response>;
  /** Its proposal; approved by default, since a draft is not generated from. */
  proposal?: Record<string, unknown> | null;
  sandbox?: () => Record<string, unknown>;
  publish?: () => Promise<Response>;
  unpublish?: () => Promise<Response>;
  /** A version's provenance, as owners read it. */
  source?: () => Record<string, unknown>;
  /** Where each step stands; the overview alone by default. */
  stages?: Record<string, unknown> | (() => Record<string, unknown>);
}) {
  const stages = () =>
    typeof input.stages === "function" ? input.stages() : input.stages;
  return server([
    [
      "GET",
      "/bounties/bty_7",
      () =>
        json({
          bounty: detail({
            sandbox: sandboxOf(input.sandbox?.()),
            proposal:
              input.proposal === undefined ? approvedSummary : input.proposal,
            ...(stages() === undefined ? {} : { stages: stages() }),
          }),
        }),
    ],
    [
      "POST",
      "/sandboxes/versions/sbv_1/publish",
      () =>
        input.publish?.() ??
        json({
          sandbox: {
            ...sandboxRecord({
              status: "published",
              currentVersionId: "sbv_1",
            }),
            slug: "abc123def456",
            publicRepoId: null,
            bountyId: "bty_7",
            createdAt: stamp,
            updatedAt: stamp,
          },
          version: { ...generatedVersion, frozenAt: stamp },
          source: {
            ...generatedSource,
            approvedBy: "user_1",
            approvedAt: stamp,
          },
        }),
    ],
    [
      "POST",
      "/sandboxes/sbx_1/unpublish",
      () =>
        input.unpublish?.() ??
        json({
          sandbox: {
            ...sandboxRecord(),
            slug: "abc123def456",
            publicRepoId: null,
            bountyId: "bty_7",
            createdAt: stamp,
            updatedAt: stamp,
          },
        }),
    ],
    [
      "POST",
      "/sandboxes/sbx_1/starter",
      () =>
        input.generate?.() ??
        json(
          {
            version: generatedVersion,
            source: generatedSource,
            run: starterRun({ status: "queued" }),
          },
          202,
        ),
    ],
    [
      "GET",
      "/sandboxes/sbx_1/versions",
      () => json({ versions: input.versions() }),
    ],
    [
      "GET",
      "/sandboxes/versions/sbv_1",
      () =>
        json({
          version: generatedVersion,
          source: input.source?.() ?? generatedSource,
        }),
    ],
    [
      "GET",
      "/github/runs/arn_starter/artifacts",
      () => json({ artifacts: input.artifacts ?? [] }),
    ],
    [
      "GET",
      "/github/runs/arn_starter",
      () => json({ run: starterRun(input.run?.()) }),
    ],
  ]);
}
async function sandboxPart() {
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("owner")} />);
  return within(await screen.findByTestId("bounty-detail")).getByRole(
    "region",
    { name: "Sandbox" },
  );
}

test("an admin generates a version for a sandbox with no repository, and follows it", async () => {
  let generated = false;
  const state = generatingServer({
    versions: () => (generated ? [generatedVersion] : []),
    generate: () => {
      generated = true;
      return json(
        {
          version: generatedVersion,
          source: generatedSource,
          run: starterRun({ status: "queued" }),
        },
        202,
      );
    },
  });
  vi.stubGlobal("fetch", state.fetchMock);
  const part = await sandboxPart();
  await userEvent.click(
    await within(part).findByRole("button", { name: "Generate" }),
  );
  await waitFor(() =>
    expect(
      state.calls.some(
        ({ method, url }) =>
          method === "POST" &&
          url.endsWith("/orgs/org_1/sandboxes/sbx_1/starter"),
      ),
    ).toBe(true),
  );
  expect(await within(part).findByText("Generating")).toBeDefined();
  expect(
    within(part).getByText(/An agent is writing the starter and its tests/),
  ).toBeDefined();
  // Nothing to browse until its build has written it.
  expect(within(part).queryByRole("link", { name: "Open Sandbox" })).toBeNull();
  // It cannot be generated twice at once.
  expect(
    (
      within(part).getByRole("button", {
        name: /Generating/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("a version generated from the latest bounty takes back the sandbox's warning at once", async () => {
  let generated = false;
  const state = generatingServer({
    versions: () => [generatedVersion],
    run: () => ({ status: "succeeded", finishedAt: stamp }),
    generate: () => {
      generated = true;
      return json(
        {
          version: { ...generatedVersion, id: "sbv_2", version: 2 },
          source: { ...generatedSource, sandboxVersionId: "sbv_2" },
          run: starterRun({ status: "queued" }),
        },
        202,
      );
    },
    // Built on bounty v1 until the new version, built on v2, is generated.
    stages: () => ({
      overview: { version: 1 },
      bounty: { version: 2, overviewVersion: 1 },
      sandbox: generated
        ? { version: 2, bountyVersion: 2 }
        : { version: 1, bountyVersion: 1 },
    }),
  });
  vi.stubGlobal("fetch", state.fetchMock);
  const part = await sandboxPart();
  expect(await screen.findByTestId("sandbox-lineage")).toBeDefined();
  await userEvent.click(
    await within(part).findByRole("button", { name: "Generate again" }),
  );
  // The bounty is read again, with no refresh, and warns of nothing.
  await waitFor(() =>
    expect(screen.queryByTestId("sandbox-lineage")).toBeNull(),
  );
  expect(
    within(screen.getByRole("tablist", { name: "Steps" }))
      .getByRole("tab", { name: /^Sandbox/ })
      .hasAttribute("data-behind"),
  ).toBe(false);
});

test("a generated version says whether its baseline passes, and what the starter holds", async () => {
  vi.stubGlobal(
    "fetch",
    generatingServer({
      versions: () => [generatedVersion],
      run: () => ({ status: "succeeded", finishedAt: stamp }),
      artifacts: [
        artifactOf("build_manifest", {
          ready: true,
          baseline: { ok: true, reasons: [], steps: [] },
        }),
        artifactOf("starter_set", {
          files: 3,
          hiddenTests: 1,
          summary: "An invitations module whose send step is left to write.",
        }),
      ],
    }).fetchMock,
  );
  const part = await sandboxPart();
  expect(await within(part).findByText("Baseline passes")).toBeDefined();
  const facts = (term: string) =>
    within(part).getByText(term).nextElementSibling?.textContent;
  expect(facts("Source files")).toBe("3");
  expect(facts("Hidden tests")).toBe("1");
  // The starter's summary is not repeated here; its files say it.
  expect(
    within(part).queryByText(
      "An invitations module whose send step is left to write.",
    ),
  ).toBeNull();
  expect(
    within(part).getByRole("button", { name: "Generate again" }),
  ).toBeDefined();
  // What its build wrote opens in a tab of its own.
  const browse = within(part).getByRole("link", { name: "Open Sandbox" });
  expect(browse.getAttribute("href")).toBe("/sandboxes/acme/sbv_1");
  expect(browse.getAttribute("target")).toBe("_blank");
});

test("a generated version whose baseline fails says why", async () => {
  vi.stubGlobal(
    "fetch",
    generatingServer({
      versions: () => [generatedVersion],
      run: () => ({ status: "succeeded", finishedAt: stamp }),
      artifacts: [
        artifactOf("build_manifest", {
          ready: false,
          baseline: {
            ok: false,
            reasons: ["public-tests exited with 1."],
            steps: [],
          },
        }),
      ],
    }).fetchMock,
  );
  const part = await sandboxPart();
  expect(await within(part).findByText("Baseline fails")).toBeDefined();
  expect(within(part).getByText("public-tests exited with 1.")).toBeDefined();
});

test("a failed generation says why it stopped", async () => {
  for (const [code, said] of [
    ["agent_unavailable", "The worker has no agent model configured."],
    ["evaluation_failed", "it needs an evaluation provider."],
    ["agent_incomplete", "ran out of budget"],
    ["tool_failed", "The version changed while it was being written."],
    ["tool_timeout", "longer than its deadline"],
    ["worker_lost", "The worker stopped while writing it."],
    ["upload_failed", "It stopped (upload_failed)."],
  ] as const) {
    vi.stubGlobal(
      "fetch",
      generatingServer({
        versions: () => [generatedVersion],
        run: () => ({ status: "failed", errorCode: code, finishedAt: stamp }),
      }).fetchMock,
    );
    const part = await sandboxPart();
    expect(await within(part).findByText("Failed")).toBeDefined();
    expect(part.textContent).toContain(said);
    cleanup();
  }
});

test("a sandbox is its slice and its submissions", async () => {
  vi.stubGlobal(
    "fetch",
    generatingServer({
      versions: () => [
        { ...generatedVersion, id: "sbv_2", version: 2 },
        generatedVersion,
      ],
      run: () => ({ status: "succeeded", finishedAt: stamp }),
      artifacts: [artifactOf("build_manifest", { ready: true })],
    }).fetchMock,
  );
  const part = await sandboxPart();
  for (const name of ["Slice", "Submission"])
    expect(within(part).getByRole("region", { name })).toBeDefined();
  expect(within(part).queryByRole("region", { name: "Public" })).toBeNull();
  const slice = within(part).getByRole("region", { name: "Slice" });
  // The version is over the card, as a bounty's proposal has its version:
  // the latest first, and an earlier one can be chosen.
  await userEvent.click(
    await within(part).findByRole("button", { name: /^Version 2/ }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: /Version 1/ }),
  );
  expect(
    await within(part).findByRole("button", { name: /^Version 1/ }),
  ).toBeDefined();
  expect(within(part).queryByText("· Latest")).toBeNull();
  expect(await within(slice).findByText("Baseline passes")).toBeDefined();
  expect(
    within(slice)
      .getByRole("link", { name: "Open Sandbox" })
      .getAttribute("href"),
  ).toBe("/sandboxes/acme/sbv_1");
});

test("a refused generation says why", async () => {
  vi.stubGlobal(
    "fetch",
    generatingServer({
      versions: () => [],
      generate: () =>
        json(
          {
            error:
              "A starter runs on Node.js and TypeScript; this bounty's stack names Python.",
            code: "stack_unsupported",
          },
          409,
        ),
    }).fetchMock,
  );
  const part = await sandboxPart();
  await userEvent.click(
    await within(part).findByRole("button", { name: "Generate" }),
  );
  expect((await within(part).findByRole("alert")).textContent).toContain(
    "this bounty's stack names Python",
  );
});

/** A live proposal in brief, as a bounty and its row show it. */
function liveProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "bpr_9",
    status: "proposed",
    complexity: "M",
    amountMinor: 200,
    currency: "USD",
    ...overrides,
  };
}

/**
 * The bounty read naming its proposal, `bpr_9`: the address names only the
 * bounty, and the bounty says which proposal is in it.
 */
const proposed: [string, string, () => Promise<Response>] = [
  "GET",
  "/bounties/bty_7",
  () => json({ bounty: detail({ proposal: liveProposal() }) }),
];
/** The same bounty with its proposal approved: its price is settled. */
const approved: [string, string, () => Promise<Response>] = [
  "GET",
  "/bounties/bty_7",
  () =>
    json({
      bounty: detail({ proposal: liveProposal({ status: "approved" }) }),
    }),
];

test("a bounty's sandbox in the panel says what it pays and its size, at its head", async () => {
  vi.stubGlobal("fetch", server([approved]).fetchMock);
  window.history.replaceState(null, "", "/bounties?peek=acme/bty_7");
  render(<Shell {...inAcme("member")} />);
  const page = await screen.findByTestId("bounty-detail");
  const sandboxPart = await within(page).findByRole("region", {
    name: "Sandbox",
  });
  const price = money(200, "USD");
  await waitFor(() => expect(sandboxPart.textContent).toContain(price));
  expect(within(sandboxPart).getByText("M")).toBeDefined();
  // Above what the sandbox itself is.
  const said = sandboxPart.textContent ?? "";
  expect(said.indexOf(price)).toBeLessThan(said.indexOf("No sandbox yet"));
  // The workspace the bounty is in comes last, under its context.
  const workspacePart = within(page).getByRole("region", {
    name: "Workspace",
  });
  const contextPart = within(page).getByRole("region", { name: "Context" });
  expect(
    contextPart.compareDocumentPosition(workspacePart) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("a bounty's page splits into tabs, each one in the address", async () => {
  vi.stubGlobal("fetch", server([proposed]).fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  render(<Shell {...inAcme("member")} />);
  const page = await screen.findByTestId("bounty-detail");
  // The steps in order, numbered, each with the version it is at.
  expect(
    within(page)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["1Overviewv1", "2Bounty", "3Sandbox"]);
  // The number is drawn, not read: each is named for its step and version.
  expect(within(page).getAllByRole("tab")[0]?.textContent).toMatch(/Overview/);
  expect(
    within(page).getByRole("tab", { name: "Overview v1", selected: true }),
  ).toBeDefined();

  // The bounty: what it pays and why.
  const entries = window.history.length;
  await userEvent.click(within(page).getByRole("tab", { name: "Bounty" }));
  expect(window.location.search).toBe("?tab=bounty");
  expect(window.history.length).toBe(entries + 1);
  const proposal = await within(page).findByTestId("proposal-detail");
  await waitFor(() =>
    expect(proposal.textContent).toContain(money(200, "USD")),
  );
  expect(within(proposal).getByText("Why this size")).toBeDefined();
  expect(
    within(page).queryByRole("region", { name: "Describe task" }),
  ).toBeNull();

  // The sandbox, without the price the Bounty tab says.
  await userEvent.click(within(page).getByRole("tab", { name: "Sandbox" }));
  expect(window.location.search).toBe("?tab=sandbox");
  const sandbox = within(page).getByRole("region", { name: "Sandbox" });
  expect(sandbox.textContent).not.toContain(money(200, "USD"));

  // The overview is the page's own address.
  await userEvent.click(within(page).getByRole("tab", { name: /^Overview/ }));
  expect(window.location.search).toBe("");
  expect(
    within(page).getByRole("region", { name: "Describe task" }),
  ).toBeDefined();
});

test("a proposal waiting on its code is read again once the code is measured, and shows the rubric's size", async () => {
  const spec = {
    feature: "Invitations",
    background: [],
    scenarios: [
      {
        id: "s1",
        kind: "happy",
        title: "One invitation",
        steps: [{ keyword: "Then", text: "one email" }],
        origin: "draft",
        weight: "heavy",
      },
    ],
    openQuestions: [],
    assumptions: [],
  } as const;
  const measured = {
    version: COMPLEXITY_PROFILE_VERSION,
    slice: {
      files: 2,
      bytes: 2_000,
      modules: ["src/mailer"],
      stubCoverage: "full",
      blockers: 0,
      ready: true,
    },
    touchedModules: ["src/mailer"],
    externals: { services: [], environment: 0, seams: 0 },
    spec: {
      scenarios: 1,
      kinds: {
        happy: 1,
        boundary: 0,
        unhappy: 0,
        recovery: 0,
        permission: 0,
        concurrency: 0,
        "non-functional": 0,
      },
      openQuestions: 0,
      assumptions: 0,
    },
    tests: { files: 1, untestedModules: [] },
    pattern: null,
    nonFunctional: { scenarios: 0, migrations: false, ci: false },
    risks: [],
  } as const;
  // Sized by the model at M, the code still to measure...
  const waiting = proposal({
    specRevision: 1,
    rubric: assessRubric({ spec, code: { status: "pending" } }),
  });
  // ...then, the code measured, sized by the rubric: 4 + 1 = 5 points, XS+.
  const sized = proposal({
    specRevision: 1,
    revision: 2,
    sizedBy: "rubric",
    complexity: "XS+",
    amountMinor: 100,
    rubric: assessRubric({
      spec,
      code: { status: "measured", profile: measured, specRevision: 1 },
    }),
  });
  let settled = false;
  const detailFor = (body: unknown) =>
    json({
      proposal: body,
      freshness: { freshness: "current", checkedAt: stamp },
      liveSpec: null,
      writebackOperations: [],
    });
  const { fetchMock, calls } = server([
    [
      "GET",
      "/bounties/bty_7",
      () => json({ bounty: detail({ proposal: liveProposal() }) }),
    ],
    [
      "GET",
      "/profile",
      () => {
        settled = true;
        return json({
          profile: {
            id: "bpf_1",
            proposalId: "bpr_9",
            specRevision: 1,
            status: "ready",
            errorCode: null,
            runErrorCode: null,
            snapshotId: "rsn_1",
            scopeRunId: "arn_1",
            sliceRunId: "arn_2",
            profile: measured,
            createdAt: stamp,
            updatedAt: stamp,
          },
        });
      },
    ],
    ["GET", "/spec", () => json({ spec: null })],
    ["GET", "/proposals/bpr_9", () => detailFor(settled ? sized : waiting)],
  ]);
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("admin")} />);
  const page = await screen.findByTestId("bounty-detail");
  const rubric = await within(page).findByRole("region", {
    name: "Why this price",
  });
  await waitFor(
    () =>
      expect(within(rubric).getByTestId("rubric-source").textContent).toBe(
        "The rubric set this size.",
      ),
    { timeout: 4_000 },
  );
  expect(within(page).getByText("set by the rubric")).toBeDefined();
  expect(within(page).getByText("The model's read: M")).toBeDefined();
  const reads = calls.filter(
    ({ method, url }) => method === "GET" && /\/proposals\/bpr_9$/.test(url),
  );
  expect(reads.length).toBeGreaterThanOrEqual(2);
});

test("a bounty's page keeps it at a glance, its context and workspace beside every tab", async () => {
  vi.stubGlobal("fetch", server([approved]).fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  render(<Shell {...inAcme("admin")} />);
  const page = await screen.findByTestId("bounty-detail");
  for (const tab of ["Overview", "Bounty", "Sandbox"]) {
    await userEvent.click(
      within(page).getByRole("tab", { name: new RegExp(`^${tab}`) }),
    );
    // What it pays and its size, over where its sandbox stands.
    const summary = await within(page).findByRole("region", { name: "Bounty" });
    await waitFor(() =>
      expect(summary.textContent).toContain(money(200, "USD")),
    );
    expect(within(summary).getByText("M")).toBeDefined();
    expect(within(summary).getByText("No sandbox yet.")).toBeDefined();
    // Its sources are linked under its text; beside it, its stack.
    const context = within(page).getByRole("region", { name: "Context" });
    expect(within(context).getByText("Tech stack")).toBeDefined();
    expect(within(context).queryByText("Repository")).toBeNull();
    expect(
      within(page).getByRole("region", { name: "Workspace" }),
    ).toBeDefined();
  }
});

test("a bounty's page opens on the tab its address names", async () => {
  vi.stubGlobal("fetch", server([proposed]).fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=sandbox");
  render(<Shell {...inAcme("member")} />);
  const page = await screen.findByTestId("bounty-detail");
  expect(
    within(page).getByRole("tab", { name: "Sandbox", selected: true }),
  ).toBeDefined();
  expect(within(page).getByRole("region", { name: "Sandbox" })).toBeDefined();
});

test("a bounty not yet approved shows no price at a glance, however it is resized", async () => {
  let resized = false;
  const live = () =>
    resized
      ? liveProposal({ complexity: "L", amountMinor: 300 })
      : liveProposal();
  const state = server([
    [
      "POST",
      "/proposals/bpr_9/resize",
      () => {
        resized = true;
        return json({
          proposal: proposal({
            complexity: "L",
            amountMinor: 300,
            sizedBy: "reviewer",
            revision: 2,
          }),
        });
      },
    ],
    [
      "GET",
      "/bounties?",
      () =>
        json({ bounties: [summary({ proposal: live() })], nextCursor: null }),
    ],
    [
      "GET",
      "/bounties/bty_7",
      () => json({ bounty: detail({ proposal: live() }) }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("admin")} />);
  const page = await screen.findByTestId("bounty-detail");
  const row = () => within(page).getByRole("region", { name: "Bounty" });
  // Proposed: its price and size are not settled until it is approved.
  await waitFor(() => expect(within(row()).getAllByText("—")).toHaveLength(2));
  expect(row().textContent).not.toContain(money(200, "USD"));

  const peek = await screen.findByTestId("proposal-detail");
  const resize = await within(peek).findByRole("group", { name: "Resize" });
  await userEvent.click(within(resize).getByRole("button", { name: "L" }));
  expect(
    state.calls.find(({ url }) => url.endsWith("/proposals/bpr_9/resize"))
      ?.body,
  ).toEqual({ expectedRevision: 1, complexity: "L" });
  // Read again for the bounty, which still is not approved.
  await waitFor(() =>
    expect(
      state.calls.filter(
        ({ method, url }) =>
          method === "GET" && url.endsWith("/bounties/bty_7"),
      ).length,
    ).toBeGreaterThanOrEqual(2),
  );
  expect(within(row()).getAllByText("—")).toHaveLength(2);
  expect(row().textContent).not.toContain(money(300, "USD"));
});

test("a removed proposal returns to its bounty, which then has none", async () => {
  let removed = false;
  const live = () => (removed ? null : liveProposal());
  const state = server([
    [
      "POST",
      "/proposals/bpr_9/remove",
      () => {
        removed = true;
        return json({});
      },
    ],
    [
      "GET",
      "/bounties?",
      () =>
        json({ bounties: [summary({ proposal: live() })], nextCursor: null }),
    ],
    [
      "GET",
      "/bounties/bty_7",
      () => json({ bounty: detail({ proposal: live() }) }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("admin")} />);
  const peek = await screen.findByTestId("proposal-detail");
  await userEvent.click(within(peek).getByRole("button", { name: "Remove" }));
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));

  await waitFor(() =>
    expect(screen.queryByTestId("proposal-detail")).toBeNull(),
  );
  expect(
    state.calls.find(({ url }) => url.endsWith("/proposals/bpr_9/remove"))
      ?.body,
  ).toEqual({ expectedRevision: 1 });
  // Still open on the bounty, whose proposal part offers to make another.
  expect(window.location.pathname + window.location.search).toBe(
    "/bounties/acme/bty_7?tab=bounty",
  );
  const part = within(screen.getByTestId("bounty-detail")).getByRole("region", {
    name: "Proposal",
  });
  expect(within(part).getByText(/No proposal yet/)).toBeDefined();
  expect(screen.queryByText("This proposal no longer exists.")).toBeNull();
});

test("a bounty's proposal that is gone says so", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      ["GET", "/proposals/bpr_9", () => json({ error: "Not found" }, 404)],
      proposed,
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("member")} />);
  expect(
    await screen.findByText("This proposal no longer exists."),
  ).toBeDefined();
});

test("a bounty's proposal that could not be read is offered again, not called gone", async () => {
  const base = server([proposed]);
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      // The proposal itself, not its spec or profile.
      if (/\/proposals\/bpr_9$/.test(String(input)) && reads++ === 0)
        return json({ error: "Internal" }, 500);
      return base.fetchMock(input, init);
    }),
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("member")} />);
  expect(await screen.findByText("Could not load the proposal.")).toBeDefined();
  expect(screen.queryByText("This proposal no longer exists.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByTestId("proposal-detail")).toBeDefined();
});

test("a bounty's proposal puts its decision first and its way out last", async () => {
  vi.stubGlobal("fetch", server([proposed]).fetchMock);
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("admin")} />);
  const proposal = await screen.findByTestId("proposal-detail");
  const approve = await within(proposal).findByRole("button", {
    name: "Approve",
  });
  const revision = within(proposal).getByText("Not approved yet");
  const reasoning = within(proposal).getByText("Why this size");
  const remove = within(proposal).getByRole("button", { name: "Remove" });
  const before = (a: Node, b: Node) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  // The version and Approve over the read, Remove under it.
  expect(before(revision, reasoning)).toBe(true);
  expect(before(approve, reasoning)).toBe(true);
  expect(before(reasoning, remove)).toBe(true);
});

test("an approved proposal names its version and when it was approved", async () => {
  const versionedAt = "2026-10-01T09:30:00.000Z";
  const state = server([proposed]);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) =>
      /\/proposals\/bpr_9$/.test(String(input))
        ? json({
            // Its sixth write, and its second version.
            proposal: proposal({
              status: "approved",
              revision: 6,
              version: 2,
              versionedAt,
            }),
            freshness: { freshness: "current", checkedAt: stamp },
            liveSpec: null,
            writebackOperations: [],
          })
        : state.fetchMock(input, init),
    ),
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("admin")} />);
  const proposalDetail = await screen.findByTestId("proposal-detail");
  expect(await within(proposalDetail).findByText("Version 2")).toBeDefined();
  expect(within(proposalDetail).queryByText(/Revision/)).toBeNull();
  const time = proposalDetail.querySelector("time");
  expect(time?.getAttribute("datetime")).toBe(versionedAt);
  expect(time?.parentElement?.textContent).toMatch(/^Approved /);
  expect(
    within(proposalDetail).getByRole("button", { name: "Unapprove" }),
  ).toBeDefined();
});

test("a version whose build passed is published for a while from over the slice, and unpublished", async () => {
  const ready = {
    ...generatedSource,
    harnessSha256: "h".repeat(64),
    toolchainDigest: "d".repeat(64),
  };
  const week = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  let published = false;
  const state = generatingServer({
    versions: () => [generatedVersion],
    run: () => ({ status: "succeeded", finishedAt: stamp }),
    artifacts: [artifactOf("build_manifest", { ready: true })],
    source: () =>
      published ? { ...ready, approvedBy: "user_1", approvedAt: stamp } : ready,
    sandbox: () =>
      published
        ? { status: "published", currentVersionId: "sbv_1", expiresAt: week }
        : {},
  });
  vi.stubGlobal("fetch", state.fetchMock);
  const part = await sandboxPart();
  expect(await within(part).findByText("Not published yet")).toBeDefined();
  // Publish asks until when, rather than publishing outright.
  await userEvent.click(
    await within(part).findByRole("button", { name: "Publish" }),
  );
  const until = await screen.findByRole("dialog", { name: "Publish until" });
  expect(state.calls.some(({ url }) => url.endsWith("/publish"))).toBe(false);
  // Quick actions open beside it: a day, three, or a week from now.
  await userEvent.click(
    within(until).getByRole("button", { name: "Quick actions" }),
  );
  const quick = await screen.findByRole("menu");
  expect(
    within(quick)
      .getAllByRole("menuitem")
      .map((item) => item.firstElementChild?.textContent),
  ).toEqual(["1 day", "3 days", "7 days"]);
  published = true;
  const before = Date.now();
  await userEvent.click(
    within(quick).getByRole("menuitem", { name: /7 days/ }),
  );
  await waitFor(() =>
    expect(state.calls.some(({ url }) => url.endsWith("/publish"))).toBe(true),
  );
  const call = state.calls.find(
    ({ method, url }) =>
      method === "POST" && url.endsWith("/sandboxes/versions/sbv_1/publish"),
  );
  const expiresAt = Date.parse((call?.body as { expiresAt: string }).expiresAt);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  expect(expiresAt).toBeGreaterThanOrEqual(before - 60_000 + weekMs);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + weekMs);
  // Published, and until when.
  expect(await within(part).findByText(/Expires/)).toBeDefined();
  // Unpublishing takes the sandbox back to a draft.
  await userEvent.click(
    await within(part).findByRole("button", { name: "Unpublish" }),
  );
  expect(
    state.calls.some(
      ({ method, url }) =>
        method === "POST" && url.endsWith("/sandboxes/sbx_1/unpublish"),
    ),
  ).toBe(true);
});

test("a day picked on the calendar publishes until its end", async () => {
  const state = generatingServer({
    versions: () => [generatedVersion],
    run: () => ({ status: "succeeded", finishedAt: stamp }),
    artifacts: [artifactOf("build_manifest", { ready: true })],
    source: () => ({
      ...generatedSource,
      harnessSha256: "h".repeat(64),
      toolchainDigest: "d".repeat(64),
    }),
  });
  vi.stubGlobal("fetch", state.fetchMock);
  const part = await sandboxPart();
  await userEvent.click(
    await within(part).findByRole("button", { name: "Publish" }),
  );
  const until = await screen.findByRole("dialog", { name: "Publish until" });
  const named = (day: Date) =>
    day.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  const today = new Date();
  // A day gone by cannot be picked.
  if (today.getDate() > 1) {
    const yesterday = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - 1,
    );
    expect(
      within(until)
        .getByRole("button", { name: named(yesterday) })
        .hasAttribute("disabled"),
    ).toBe(true);
  }
  // The months before this one are not offered; the next ones are.
  expect(
    within(until)
      .getByRole("button", { name: "Previous month" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.click(
    within(until).getByRole("button", { name: "Next month" }),
  );
  const next = new Date(today.getFullYear(), today.getMonth() + 1, 15);
  await userEvent.click(
    within(until).getByRole("button", { name: named(next) }),
  );
  await waitFor(() =>
    expect(state.calls.some(({ url }) => url.endsWith("/publish"))).toBe(true),
  );
  const call = state.calls.find(({ url }) => url.endsWith("/publish"));
  expect(call?.body).toEqual({
    expiresAt: new Date(
      next.getFullYear(),
      next.getMonth(),
      next.getDate(),
      23,
      59,
      59,
      999,
    ).toISOString(),
  });
});

test("a publication past its date reads as expired, and can be published again", async () => {
  const lapsed = "2026-01-01T00:00:00.000Z";
  vi.stubGlobal(
    "fetch",
    generatingServer({
      versions: () => [{ ...generatedVersion, frozenAt: stamp }],
      run: () => ({ status: "succeeded", finishedAt: stamp }),
      artifacts: [artifactOf("build_manifest", { ready: true })],
      source: () => ({
        ...generatedSource,
        harnessSha256: "h".repeat(64),
        toolchainDigest: "d".repeat(64),
        approvedBy: "user_1",
        approvedAt: stamp,
      }),
      sandbox: () => ({
        status: "published",
        currentVersionId: "sbv_1",
        expiresAt: lapsed,
      }),
    }).fetchMock,
  );
  const part = await sandboxPart();
  const expired = await within(part).findByText(/^Expired/);
  expect(expired.querySelector("time")?.getAttribute("datetime")).toBe(lapsed);
  const publish = await within(part).findByRole("button", { name: "Publish" });
  expect(publish.hasAttribute("disabled")).toBe(false);
  expect(within(part).queryByRole("button", { name: "Unpublish" })).toBeNull();
});

test("a version without a passing build cannot be published", async () => {
  vi.stubGlobal(
    "fetch",
    generatingServer({
      versions: () => [generatedVersion],
      run: () => ({ status: "succeeded", finishedAt: stamp }),
      artifacts: [artifactOf("build_manifest", { ready: false })],
    }).fetchMock,
  );
  const part = await sandboxPart();
  const publish = await within(part).findByRole("button", { name: "Publish" });
  expect(publish.hasAttribute("disabled")).toBe(true);
});

test("a version taken from a bounty not approved cannot be published, and says why", async () => {
  vi.stubGlobal(
    "fetch",
    generatingServer({
      versions: () => [generatedVersion],
      run: () => ({ status: "succeeded", finishedAt: stamp }),
      artifacts: [artifactOf("build_manifest", { ready: true })],
      source: () => ({
        ...generatedSource,
        harnessSha256: "h".repeat(64),
        toolchainDigest: "d".repeat(64),
        proposalVersion: null,
        approvedTask: {
          ...generatedSource.approvedTask,
          pricing: {
            ...generatedSource.approvedTask.pricing,
            status: "proposed",
          },
        },
      }),
    }).fetchMock,
  );
  const part = await sandboxPart();
  const publish = await within(part).findByRole("button", { name: "Publish" });
  expect(publish.hasAttribute("disabled")).toBe(true);
  // The reason is on hover, from the span the disabled button sits in.
  await userEvent.hover(publish.parentElement!);
  expect(
    (
      await screen.findAllByText(
        "This version was not built from an approved bounty.",
      )
    ).length,
  ).toBeGreaterThan(0);
});

test("a version built from an approved bounty publishes while the bounty is a draft again", async () => {
  vi.stubGlobal(
    "fetch",
    generatingServer({
      versions: () => [generatedVersion],
      run: () => ({ status: "succeeded", finishedAt: stamp }),
      artifacts: [artifactOf("build_manifest", { ready: true })],
      source: () => ({
        ...generatedSource,
        harnessSha256: "h".repeat(64),
        toolchainDigest: "d".repeat(64),
      }),
      proposal: { ...approvedSummary, status: "proposed" },
    }).fetchMock,
  );
  const part = await sandboxPart();
  // Its header names the bounty version it was built on, once its
  // provenance is read; then it can be published.
  expect(await within(part).findByText("· Bounty v1")).toBeDefined();
  const publish = await within(part).findByRole("button", { name: "Publish" });
  await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
});

test("an approval a published sandbox stands on is taken back, and the sandbox reads as behind", async () => {
  const state = generatingServer({
    versions: () => [generatedVersion],
    sandbox: () => ({
      status: "published",
      currentVersionId: "sbv_1",
      build: { versionId: "sbv_1", version: 1, bountyVersion: 1 },
    }),
    // Approved again since, as version 2: the sandbox is on version 1.
    stages: {
      overview: { version: 1 },
      bounty: { version: 2, overviewVersion: 1 },
      sandbox: { version: 1, bountyVersion: 1 },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) =>
      /\/proposals\/bpr_7$/.test(String(input))
        ? json({
            proposal: proposal({ id: "bpr_7", status: "approved", version: 2 }),
            freshness: { freshness: "current", checkedAt: stamp },
            liveSpec: null,
            writebackOperations: [],
          })
        : state.fetchMock(input, init),
    ),
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("admin")} />);
  const proposalDetail = await screen.findByTestId("proposal-detail");
  // Nothing locks the bounty to its sandbox.
  const unapprove = await within(proposalDetail).findByRole("button", {
    name: "Unapprove",
  });
  expect(unapprove.hasAttribute("disabled")).toBe(false);
  // Approved, it is not sized again until it is unapproved.
  expect(
    within(proposalDetail).queryByRole("button", { name: "Re-analyze" }),
  ).toBeNull();

  // The sandbox's step warns, and its page says what it is behind.
  const steps = screen.getByRole("tablist", { name: "Steps" });
  const sandboxTab = within(steps).getByRole("tab", { name: /^Sandbox/ });
  expect(sandboxTab.getAttribute("data-behind")).toBe("true");
  expect(sandboxTab.textContent).toContain("v1");
  expect(
    within(steps)
      .getByRole("tab", { name: /^Bounty/ })
      .hasAttribute("data-behind"),
  ).toBe(false);
  // The approved bounty's version wears the gradient; the version behind
  // wears the warning instead.
  expect(
    within(steps)
      .getByRole("tab", { name: /^Bounty/ })
      .querySelector("[data-approved]")?.textContent,
  ).toBe("v2");
  expect(sandboxTab.querySelector("[data-approved]")).toBeNull();
  await userEvent.click(sandboxTab);
  // Chosen, it is the active tab, whatever its warning's tooltip is doing:
  // the underline follows `data-state="active"`.
  await waitFor(() =>
    expect(sandboxTab.getAttribute("data-state")).toBe("active"),
  );
  await userEvent.hover(within(sandboxTab).getByText("Sandbox"));
  expect(
    (await screen.findAllByText("Built on bounty v1; the bounty is now at v2."))
      .length,
  ).toBeGreaterThan(0);
  expect(sandboxTab.getAttribute("data-state")).toBe("active");
  const lineage = await screen.findByTestId("sandbox-lineage");
  expect(lineage.textContent).toContain("Bounty has moved ahead.");
  expect(lineage.textContent).toContain(
    "Built on Bounty v1; the bounty is now at v2.",
  );
  // The version named opens the step it belongs to.
  await userEvent.click(
    within(lineage).getByRole("button", { name: "Bounty v1" }),
  );
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get("tab")).toBe(
      "bounty",
    ),
  );
  // Current, the bounty warns of nothing: its version line names the
  // overview version it was sized from.
  const header = await within(
    await screen.findByTestId("proposal-detail"),
  ).findByText("Overview v1");
  expect(header).toBeDefined();
  expect(screen.queryByTestId("bounty-lineage")).toBeNull();
});

test("a bounty that is a draft, or has no proposal, generates no slice", async () => {
  vi.stubGlobal(
    "fetch",
    generatingServer({
      versions: () => [],
      proposal: { ...approvedSummary, status: "proposed" },
    }).fetchMock,
  );
  let part = await sandboxPart();
  expect(
    await within(part).findByText(
      /No version yet\. The bounty is a draft\. Approve it before generating its slice\./,
    ),
  ).toBeDefined();
  expect(
    within(part)
      .getByRole("button", { name: "Generate" })
      .hasAttribute("disabled"),
  ).toBe(true);
  cleanup();

  vi.stubGlobal(
    "fetch",
    generatingServer({ versions: () => [], proposal: null }).fetchMock,
  );
  part = await sandboxPart();
  expect(
    await within(part).findByText(
      /Size and approve the bounty before generating its slice\./,
    ),
  ).toBeDefined();
});

test("the overview is versioned: an earlier one is read as it was, and the bounty sized from it warns", async () => {
  const versionOf = (version: number, description: string) => ({
    version,
    title: "Invitations are not sent",
    description,
    createdBy: "user_1",
    createdAt: stamp,
  });
  vi.stubGlobal(
    "fetch",
    server([
      // Before the bounty's own route, which its address would also match.
      [
        "GET",
        "/bounties/bty_7/versions",
        () =>
          json({
            versions: [
              versionOf(
                2,
                "Scheduling an interview sends the candidate one email.",
              ),
              versionOf(1, "Interview emails are missing."),
            ],
          }),
      ],
      [
        "GET",
        "/bounties/bty_7",
        () =>
          json({
            bounty: detail({
              version: 2,
              proposal: liveProposal(),
              stages: {
                overview: { version: 2 },
                bounty: { version: 0, overviewVersion: 1 },
                sandbox: null,
              },
            }),
          }),
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  render(<Shell {...inAcme("member")} />);
  const page = await screen.findByTestId("bounty-detail");

  // The overview's version over its text, the latest until another is read.
  const header = await within(page).findByTestId("overview-version");
  await waitFor(() => expect(header.textContent).toContain("Edited"));
  expect(header.textContent).toContain("Version 2");
  expect(header.textContent).toContain("Latest");
  await userEvent.click(
    within(header).getByRole("button", { name: "Version 2, choose another" }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: /Version 1/ }),
  );
  const earlier = await within(page).findByTestId("overview-earlier");
  expect(earlier.textContent).toContain("Interview emails are missing.");
  // Read, not changed: no way to edit it, and the way back.
  expect(
    within(page).queryByRole("button", { name: "Edit description" }),
  ).toBeNull();
  expect(header.textContent).toContain("Read only");
  await userEvent.click(
    within(header).getByRole("button", { name: "Back to latest" }),
  );
  expect(within(page).queryByTestId("overview-earlier")).toBeNull();

  // Sized from version 1, a draft never approved: the Bounty step warns.
  const bountyTab = within(page).getByRole("tab", {
    name: "Bounty Draft (behind)",
  });
  await userEvent.click(bountyTab);
  const lineage = await within(page).findByTestId("bounty-lineage");
  expect(lineage.textContent).toContain("Overview has moved ahead.");
  expect(lineage.textContent).toContain(
    "Sized from Overview v1; the overview is now at v2.",
  );
  expect(lineage.getAttribute("role")).toBe("status");
});

test("an approved overview is held as it is until an admin unapproves it", async () => {
  let approved = false;
  const decided: string[] = [];
  const bountyNow = () =>
    detail({
      revision: approved ? 2 : 1,
      approval: approved
        ? { version: 1, approvedBy: "user_1", approvedAt: stamp }
        : null,
      proposal: liveProposal(),
    });
  vi.stubGlobal(
    "fetch",
    server([
      ...(["approve", "unapprove"] as const).map(
        (decision): [string, string, (body: unknown) => Promise<Response>] => [
          "POST",
          `/bounties/bty_7/${decision}`,
          (body) => {
            decided.push(
              `${decision}@${(body as { expectedRevision: number }).expectedRevision}`,
            );
            approved = decision === "approve";
            return json({ bounty: bountyNow() });
          },
        ],
      ),
      ["GET", "/bounties/bty_7", () => json({ bounty: bountyNow() })],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7");
  render(<Shell {...inAcme("admin")} />);
  const page = await screen.findByTestId("bounty-detail");
  // Open to change until approved.
  expect(
    await within(page).findByRole("button", { name: "Edit description" }),
  ).toBeDefined();

  await userEvent.click(within(page).getByRole("button", { name: "Approve" }));
  await within(page).findByRole("button", { name: "Unapprove" });
  expect(decided).toEqual(["approve@1"]);
  // Held: no way to edit its text, and its links are shown, not changed.
  expect(
    within(page).queryByRole("button", { name: "Edit description" }),
  ).toBeNull();
  expect(
    within(page).getByRole("combobox", { name: "Repository" }),
  ).toHaveProperty("disabled", true);
  expect(
    within(page).getByRole("button", { name: "Jira issue" }),
  ).toHaveProperty("disabled", true);
  expect(within(page).getByTestId("overview-version").textContent).toContain(
    "Approved",
  );
  // Its version wears the approved gradient on its step.
  expect(
    within(page)
      .getByRole("tab", { name: /^Overview/ })
      .querySelector("[data-approved]")?.textContent,
  ).toBe("v1");

  await userEvent.click(
    within(page).getByRole("button", { name: "Unapprove" }),
  );
  expect(
    await within(page).findByRole("button", { name: "Edit description" }),
  ).toBeDefined();
  expect(decided).toEqual(["approve@1", "unapprove@2"]);
});

test("a Jira update under way is read until it settles, with no refresh", async () => {
  let reads = 0;
  const writeback = (status: string) => ({
    id: "bwo_1",
    organizationId: "org_1",
    proposalId: "bpr_7",
    proposalRevision: 1,
    kind: "approved",
    status,
    step: "comment",
    payload: {
      complexity: "S",
      amountMinor: 5_800,
      currency: "USD",
      proposalUrl: "https://example.test/proposals/bpr_7",
    },
    jiraCommentId: status === "done" ? "10001" : null,
    errorCode: null,
    commentAttemptedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const state = generatingServer({ versions: () => [] });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      if (!/\/proposals\/bpr_7$/.test(String(input)))
        return state.fetchMock(input, init);
      reads += 1;
      return json({
        proposal: proposal({ id: "bpr_7", status: "approved", version: 1 }),
        freshness: { freshness: "current", checkedAt: stamp },
        liveSpec: null,
        // Posted in the background: pending when first read, then done.
        writebackOperations: [writeback(reads === 1 ? "pending" : "done")],
      });
    }),
  );
  window.history.replaceState(null, "", "/bounties/acme/bty_7?tab=bounty");
  render(<Shell {...inAcme("admin")} />);
  const proposalDetail = await screen.findByTestId("proposal-detail");
  expect(await within(proposalDetail).findByText("pending")).toBeDefined();
  expect(
    await within(proposalDetail).findByText("done", undefined, {
      timeout: 5_000,
    }),
  ).toBeDefined();
  // Settled, it is not read again.
  const settled = reads;
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  expect(reads).toBe(settled);
}, 15_000);
