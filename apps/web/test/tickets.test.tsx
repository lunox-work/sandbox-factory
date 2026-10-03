import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { trailFor } from "../src/Breadcrumbs";
import { pathForScreen, screenForPath } from "../src/routes";
import { Tickets } from "../src/Tickets";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const stamp = "2026-10-03T00:00:00.000Z";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: "tkt_7",
    organizationId: "org_1",
    number: 7,
    key: "T-7",
    title: "Invitations are not sent",
    issueType: "Bug",
    priority: null,
    labels: ["email"],
    origin: "manual",
    repoId: null,
    revision: 1,
    jira: null,
    proposal: null,
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
  id: "tkt_1",
  number: 1,
  key: "APP-1",
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
    ticketId: "tkt_7",
    issueKey: "T-7",
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
    ticketId: "tkt_7",
    kind: "ticket",
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

/**
 * A server answering what the page asks, recording every request. `routes`
 * are tried first, by method and a substring of the URL.
 */
function server(
  routes: [string, string, (body: unknown) => Promise<Response>][] = [],
  tickets: unknown[] = [summary(), fromJira],
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
            fullName: "acme/app",
            role: "source",
            syncStatus: "ok",
          },
        ],
      });
    }
    if (method === "GET" && url.includes("/tickets?")) {
      return json({ tickets, nextCursor: null });
    }
    if (method === "GET" && url.includes("/tickets/tkt_7")) {
      return json({ ticket: detail() });
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
          issueType: "Bug",
          key: "T-7",
          url: null,
          inputTruncated: false,
        },
        writebackOperations: [],
      });
    }
    if (url.includes("/spec")) return json({ spec: null });
    if (url.includes("/profile")) return json({ profile: null });
    return json({ error: "Not found" }, 404);
  });
  return { fetchMock, calls };
}

test("the workspace's tickets list from any source, with their proposals", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  render(<Tickets organizationId="org_1" role="member" />);
  const list = await screen.findByTestId("ticket-list");

  const rows = within(list).getAllByRole("listitem");
  expect(within(rows[0]!).getByText("T-7")).toBeDefined();
  expect(within(rows[0]!).getByText("Written here")).toBeDefined();
  // A member may not propose: the row says there is none instead.
  expect(within(rows[0]!).getByText("No proposal")).toBeDefined();
  expect(within(rows[1]!).getByText("From Jira")).toBeDefined();
  expect(within(rows[1]!).getByText("Approved")).toBeDefined();
  expect(within(rows[1]!).getByText(/105\.00/)).toBeDefined();
});

test("an empty workspace is offered a ticket to write", async () => {
  vi.stubGlobal("fetch", server([], []).fetchMock);
  render(<Tickets organizationId="org_1" role="member" />);
  expect(await screen.findByText(/No tickets yet/)).toBeDefined();
});

test("writing a ticket sends what the form holds and opens it", async () => {
  const state = server([
    ["POST", "/tickets", () => json({ ticket: detail() }, 201)],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  render(<Tickets organizationId="org_1" role="member" />);
  await screen.findByTestId("ticket-list");

  await userEvent.click(
    screen.getAllByRole("button", { name: "New ticket" })[0]!,
  );
  const form = await screen.findByTestId("ticket-form");
  await userEvent.type(
    within(form).getByLabelText("Title"),
    "Invitations are not sent",
  );
  const type = within(form).getByLabelText("Type");
  await userEvent.clear(type);
  await userEvent.type(type, "Bug");
  await userEvent.selectOptions(
    within(form).getByLabelText("Priority"),
    "High",
  );
  await userEvent.type(within(form).getByLabelText("Labels"), "email, ui");
  await waitFor(() =>
    expect(
      within(form).getByRole("option", { name: "acme/app" }),
    ).toBeDefined(),
  );
  await userEvent.selectOptions(
    within(form).getByLabelText("Repository"),
    "ghr_1",
  );
  await userEvent.type(
    within(form).getByLabelText("Description"),
    "One email per interview.",
  );
  await userEvent.click(
    within(form).getByRole("button", { name: "Create ticket" }),
  );

  await waitFor(() =>
    expect(state.calls.find(({ method }) => method === "POST")?.body).toEqual({
      title: "Invitations are not sent",
      description: "One email per interview.",
      issueType: "Bug",
      priority: "High",
      labels: ["email", "ui"],
      repoId: "ghr_1",
    }),
  );
  // The new ticket opens, with its text.
  const panel = await screen.findByTestId("ticket-detail");
  expect(
    within(panel).getByText(
      "Scheduling an interview sends the candidate one email.",
    ),
  ).toBeDefined();
  expect(window.location.search).toBe("?ticket=tkt_7");
});

test("a ticket with no title is not sent", async () => {
  const state = server();
  vi.stubGlobal("fetch", state.fetchMock);
  render(<Tickets organizationId="org_1" role="member" />);
  await screen.findByTestId("ticket-list");
  await userEvent.click(
    screen.getAllByRole("button", { name: "New ticket" })[0]!,
  );
  const form = await screen.findByTestId("ticket-form");
  // Submitted past the browser's own check, as a script could.
  act(() => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  expect(
    await within(form).findByText("A ticket needs a title."),
  ).toBeDefined();
  expect(state.calls.some(({ method }) => method === "POST")).toBe(false);
});

test("an admin proposes a ticket, follows its sizing, and lands on the proposal", async () => {
  let polls = 0;
  const state = server([
    ["POST", "/tickets/tkt_7/propose", () => json({ run: run() }, 202)],
    [
      "GET",
      "/runs/brn_1",
      () => {
        polls += 1;
        return json({
          run: run(
            [
              {
                externalIssueId: "tkt_7",
                issueKey: "T-7",
                ticketId: "tkt_7",
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
  render(<Tickets organizationId="org_1" role="admin" />);
  const list = await screen.findByTestId("ticket-list");

  await userEvent.click(within(list).getByRole("button", { name: "Propose" }));
  expect(await within(list).findByText("Sizing…")).toBeDefined();

  // The proposal opens in the proposals tab, read from the organization.
  const panel = await screen.findByTestId(
    "proposal-panel",
    {},
    { timeout: 3_000 },
  );
  expect(polls).toBe(1);
  expect(window.location.search).toBe("?tab=proposals&proposal=bpr_9");
  const proposals = state.calls.map(({ url }) => url);
  expect(proposals.some((url) => url.endsWith("/proposals?limit=50"))).toBe(
    true,
  );
  // No board: no board runs, and no live titles from Jira.
  expect(proposals.some((url) => url.includes("/jira/boards/"))).toBe(false);
  expect(proposals.some((url) => url.includes("/proposal-titles"))).toBe(false);

  // The Spec tab shows the ticket as stored: there is no Jira to read.
  await userEvent.click(within(panel).getByRole("tab", { name: "Spec" }));
  expect(
    await within(panel).findByText("Retries must not send twice."),
  ).toBeDefined();
  expect(within(panel).queryByText("Open in Jira")).toBeNull();
});

test("a ticket that already has a proposal opens it without sizing", async () => {
  const state = server([
    ["POST", "/tickets/tkt_7/propose", () => json({ proposalId: "bpr_9" })],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  render(<Tickets organizationId="org_1" role="owner" />);
  const list = await screen.findByTestId("ticket-list");
  await userEvent.click(within(list).getByRole("button", { name: "Propose" }));
  await screen.findByTestId("proposal-panel");
  expect(state.calls.some(({ url }) => url.includes("/runs/"))).toBe(false);
});

test("a ticket already being sized follows the run under way", async () => {
  const state = server([
    [
      "POST",
      "/tickets/tkt_7/propose",
      () =>
        json(
          {
            code: "run_active",
            error: "This ticket is already being sized.",
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
                externalIssueId: "tkt_7",
                issueKey: "T-7",
                ticketId: "tkt_7",
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
  render(<Tickets organizationId="org_1" role="admin" />);
  const list = await screen.findByTestId("ticket-list");
  await userEvent.click(within(list).getByRole("button", { name: "Propose" }));

  await screen.findByTestId("proposal-panel");
  expect(window.location.search).toBe("?tab=proposals&proposal=bpr_9");
  expect(screen.queryByText("This ticket is already being sized.")).toBeNull();
});

test("a proposal that could not start, or ended without one, says why", async () => {
  const refused = server([
    [
      "POST",
      "/tickets/tkt_7/propose",
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
  const { unmount } = render(<Tickets organizationId="org_1" role="owner" />);
  const list = await screen.findByTestId("ticket-list");
  await userEvent.click(within(list).getByRole("button", { name: "Propose" }));
  expect(
    await within(list).findByText("Set a rate card before proposing."),
  ).toBeDefined();
  unmount();

  const failed = server([
    [
      "POST",
      "/tickets/tkt_7/propose",
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
  render(<Tickets organizationId="org_1" role="owner" />);
  const again = await screen.findByTestId("ticket-list");
  await userEvent.click(within(again).getByRole("button", { name: "Propose" }));
  expect(await within(again).findByText(/needs reconnecting/)).toBeDefined();
});

test("a ticket following Jira is edited for its repository only", async () => {
  const state = server([
    [
      "GET",
      "/tickets/tkt_1",
      () =>
        json({
          ticket: detail({
            ...fromJira,
            description: "Export the filtered table.",
          }),
        }),
    ],
    [
      "PATCH",
      "/tickets/tkt_1",
      () =>
        json({
          ticket: detail({ ...fromJira, repoId: "ghr_1", revision: 2 }),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/o/acme/tickets?ticket=tkt_1");
  render(<Tickets organizationId="org_1" role="member" />);

  const panel = await screen.findByTestId("ticket-detail");
  expect(within(panel).getByText("Follows its Jira issue")).toBeDefined();
  expect(
    within(panel)
      .getByRole("link", { name: /Open in Jira/ })
      .getAttribute("href"),
  ).toBe("https://acme.atlassian.net/browse/APP-1");

  await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));
  const form = await screen.findByTestId("ticket-form");
  expect(
    (within(form).getByLabelText("Title") as HTMLInputElement).disabled,
  ).toBe(true);
  await waitFor(() =>
    expect(
      within(form).getByRole("option", { name: "acme/app" }),
    ).toBeDefined(),
  );
  await userEvent.selectOptions(
    within(form).getByLabelText("Repository"),
    "ghr_1",
  );
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(state.calls.find(({ method }) => method === "PATCH")?.body).toEqual({
      expectedRevision: 1,
      repoId: "ghr_1",
    }),
  );
  expect(await screen.findByTestId("ticket-detail")).toBeDefined();
});

test("a stale edit says so and shows the ticket as it is now", async () => {
  const state = server([
    [
      "PATCH",
      "/tickets/tkt_7",
      () =>
        json(
          {
            code: "ticket_changed",
            error: "The ticket changed. Reload it before saving.",
            ticket: detail({
              revision: 3,
              title: "Invitations go to the wrong address",
            }),
          },
          409,
        ),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/o/acme/tickets?ticket=tkt_7");
  render(<Tickets organizationId="org_1" role="member" />);
  const panel = await screen.findByTestId("ticket-detail");
  await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));
  const form = await screen.findByTestId("ticket-form");
  await userEvent.type(within(form).getByLabelText("Title"), "!");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));

  // The form holds their version now, so a second save cannot undo it.
  const reopened = await screen.findByTestId("ticket-form");
  expect(
    await within(reopened).findByText(/Someone changed this ticket/),
  ).toBeDefined();
  const title = within(reopened).getByLabelText("Title") as HTMLInputElement;
  expect(title.value).toBe("Invitations go to the wrong address");
  await userEvent.type(title, "!");
  await userEvent.click(within(reopened).getByRole("button", { name: "Save" }));
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
      "/tickets/tkt_7",
      () =>
        json({
          ticket: detail({ title: "Invitations are not sent!", revision: 2 }),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/o/acme/tickets?ticket=tkt_7");
  render(<Tickets organizationId="org_1" role="member" />);

  const panel = await screen.findByTestId("ticket-detail");
  await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));
  const unchanged = await screen.findByTestId("ticket-form");
  await userEvent.click(
    within(unchanged).getByRole("button", { name: "Save" }),
  );
  const again = await screen.findByTestId("ticket-detail");
  expect(state.calls.some(({ method }) => method === "PATCH")).toBe(false);

  await userEvent.click(within(again).getByRole("button", { name: "Edit" }));
  const form = await screen.findByTestId("ticket-form");
  await userEvent.type(within(form).getByLabelText("Title"), "!");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(state.calls.find(({ method }) => method === "PATCH")?.body).toEqual({
      expectedRevision: 1,
      title: "Invitations are not sent!",
    }),
  );
});

test("labels past the limit are refused before they are sent", async () => {
  const state = server();
  vi.stubGlobal("fetch", state.fetchMock);
  render(<Tickets organizationId="org_1" role="member" />);
  await screen.findByTestId("ticket-list");
  await userEvent.click(
    screen.getAllByRole("button", { name: "New ticket" })[0]!,
  );
  const form = await screen.findByTestId("ticket-form");
  await userEvent.type(within(form).getByLabelText("Title"), "Many labels");
  await userEvent.click(within(form).getByLabelText("Labels"));
  await userEvent.paste(
    Array.from({ length: 21 }, (_, index) => `label${index}`).join(", "),
  );
  await userEvent.click(
    within(form).getByRole("button", { name: "Create ticket" }),
  );
  expect(
    await within(form).findByText("A ticket takes at most 20 labels."),
  ).toBeDefined();

  const labels = within(form).getByLabelText("Labels");
  await userEvent.clear(labels);
  await userEvent.click(labels);
  await userEvent.paste("x".repeat(65));
  await userEvent.click(
    within(form).getByRole("button", { name: "Create ticket" }),
  );
  expect(
    await within(form).findByText("A label is at most 64 characters long."),
  ).toBeDefined();
  expect(state.calls.some(({ method }) => method === "POST")).toBe(false);
});

test("an admin deletes a ticket with no proposal", async () => {
  const state = server([
    [
      "DELETE",
      "/tickets/tkt_7",
      () => Promise.resolve(new Response(null, { status: 204 })),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/o/acme/tickets?ticket=tkt_7");
  render(<Tickets organizationId="org_1" role="admin" />);
  const panel = await screen.findByTestId("ticket-detail");
  await userEvent.click(
    within(panel).getByRole("button", { name: "Delete ticket" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Delete ticket" }),
  );
  await waitFor(() =>
    expect(state.calls.some(({ method }) => method === "DELETE")).toBe(true),
  );
  await waitFor(() => expect(window.location.search).toBe(""));
});

test("a ticket that cannot be deleted says why, once", async () => {
  const state = server([
    [
      "DELETE",
      "/tickets/tkt_7",
      () =>
        json(
          {
            code: "ticket_in_use",
            error:
              "This ticket has a proposal or a sandbox, or is being sized, so it cannot be deleted.",
          },
          409,
        ),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/o/acme/tickets?ticket=tkt_7");
  render(<Tickets organizationId="org_1" role="admin" />);
  const panel = await screen.findByTestId("ticket-detail");
  await userEvent.click(
    within(panel).getByRole("button", { name: "Delete ticket" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Delete ticket" }),
  );
  await screen.findByText(/is being sized, so it cannot be deleted/);
  expect(
    screen.getAllByText(/is being sized, so it cannot be deleted/),
  ).toHaveLength(1);
  expect(window.location.search).toBe("?ticket=tkt_7");
});

test("a ticket that no longer exists says so", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      ["GET", "/tickets/tkt_gone", () => json({ error: "Not found" }, 404)],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/o/acme/tickets?ticket=tkt_gone");
  render(<Tickets organizationId="org_1" role="member" />);
  expect(
    await screen.findByText("This ticket no longer exists."),
  ).toBeDefined();
});

test("a ticket that could not be read is offered again, not called gone", async () => {
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    server([
      [
        "GET",
        "/tickets/tkt_7",
        () => {
          reads += 1;
          return reads === 1
            ? json({ error: "Internal" }, 500)
            : json({ ticket: detail() });
        },
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/o/acme/tickets?ticket=tkt_7");
  render(<Tickets organizationId="org_1" role="member" />);
  expect(await screen.findByText("Could not load the ticket.")).toBeDefined();
  expect(screen.queryByText("This ticket no longer exists.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByTestId("ticket-detail")).toBeDefined();
});

test("a link to a ticket past the loaded rows still names its panel", async () => {
  vi.stubGlobal("fetch", server([], []).fetchMock);
  window.history.replaceState(null, "", "/o/acme/tickets?ticket=tkt_7");
  render(<Tickets organizationId="org_1" role="member" />);
  await screen.findByTestId("ticket-detail");
  const panel = screen.getByTestId("ticket-panel");
  expect(within(panel).getByText("Invitations are not sent")).toBeDefined();
  expect(within(panel).getByText("T-7")).toBeDefined();
});

test("the tabs are in the URL, and Back moves between them", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  window.history.replaceState(null, "", "/o/acme/tickets");
  render(<Tickets organizationId="org_1" role="member" />);
  await screen.findByTestId("ticket-list");
  await userEvent.click(screen.getByRole("tab", { name: "Proposals" }));
  expect(window.location.search).toBe("?tab=proposals");
  expect(await screen.findByTestId("proposal-list")).toBeDefined();

  window.history.replaceState(null, "", "/o/acme/tickets");
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(await screen.findByTestId("ticket-list")).toBeDefined();
});

test("the tickets page has a path and a trail of its own", () => {
  expect(screenForPath("/o/acme/tickets")).toBe("org-tickets");
  expect(screenForPath("/o/acme/tickets/")).toBe("org-tickets");
  expect(screenForPath("/o/acme/tickets/more")).toBe("org-settings");
  expect(pathForScreen("org-tickets", "acme")).toBe("/o/acme/tickets");
  expect(pathForScreen("org-tickets")).toBe("/workspaces");
  expect(
    trailFor("org-tickets", { name: "Acme", slug: "acme" }).map(
      ({ label }) => label,
    ),
  ).toEqual(["Home", "Workspaces", "Acme", "Tickets"]);
  expect(trailFor("org-tickets").map(({ label }) => label)).toEqual([
    "Home",
    "Workspaces",
    "Tickets",
  ]);
});
