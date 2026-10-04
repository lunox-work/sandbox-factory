import { act, render, screen, waitFor, within } from "./render";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { trailFor } from "../src/Breadcrumbs";
import { money } from "../src/lib/format";
import { canonicalUrl, pathForScreen, screenForPath } from "../src/routes";
import { Bounties } from "../src/Bounties";

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
    number: 7,
    key: "B-7",
    title: "Invitations are not sent",
    issueType: "Bug",
    priority: null,
    labels: ["email"],
    origin: "manual",
    repoId: null,
    revision: 1,
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
    bountyId: "bty_7",
    issueKey: "B-7",
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
          issueType: "Bug",
          key: "B-7",
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

test("the workspace's bounties list from any source, with their proposals", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  render(<Bounties organizationId="org_1" role="member" />);
  const list = await screen.findByTestId("bounty-list");

  const rows = within(list).getAllByRole("listitem");
  expect(within(rows[0]!).getByText("B-7")).toBeDefined();
  expect(within(rows[0]!).getByText("Written here")).toBeDefined();
  // A member may not propose: the row says there is none instead.
  expect(within(rows[0]!).getByText("No proposal")).toBeDefined();
  expect(within(rows[1]!).getByText("From Jira")).toBeDefined();
  expect(within(rows[1]!).getByText("Approved")).toBeDefined();
  expect(within(rows[1]!).getByText(/105\.00/)).toBeDefined();
});

test("an empty workspace is offered a bounty to write", async () => {
  vi.stubGlobal("fetch", server([], []).fetchMock);
  render(<Bounties organizationId="org_1" role="member" />);
  expect(await screen.findByText(/No bounties yet/)).toBeDefined();
});

test("writing a bounty sends what the form holds and opens it", async () => {
  const state = server([
    ["POST", "/bounties", () => json({ bounty: detail() }, 201)],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  render(<Bounties organizationId="org_1" role="member" />);
  await screen.findByTestId("bounty-list");

  await userEvent.click(
    screen.getAllByRole("button", { name: "New bounty" })[0]!,
  );
  const form = await screen.findByTestId("bounty-form");
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
    within(form).getByRole("button", { name: "Create bounty" }),
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
  // The new bounty opens, with its text.
  const panel = await screen.findByTestId("bounty-detail");
  expect(
    within(panel).getByText(
      "Scheduling an interview sends the candidate one email.",
    ),
  ).toBeDefined();
  expect(window.location.search).toBe("?bounty=bty_7");
});

test("a bounty with no title is not sent", async () => {
  const state = server();
  vi.stubGlobal("fetch", state.fetchMock);
  render(<Bounties organizationId="org_1" role="member" />);
  await screen.findByTestId("bounty-list");
  await userEvent.click(
    screen.getAllByRole("button", { name: "New bounty" })[0]!,
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
                issueKey: "B-7",
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="admin" />);
  const panel = await screen.findByTestId("bounty-panel");
  // No proposal yet: its tab has nothing to open.
  expect(
    within(panel)
      .getByRole("tab", { name: "Proposal" })
      .hasAttribute("disabled"),
  ).toBe(true);

  const detail = await within(panel).findByTestId("bounty-detail");
  await userEvent.click(
    within(detail).getByRole("button", { name: "Propose" }),
  );
  expect(await within(detail).findByText("Sizing…")).toBeDefined();

  // The proposal opens inside the bounty, read by id, with no list around it.
  const proposal = await within(panel).findByTestId(
    "proposal-detail",
    {},
    { timeout: 3_000 },
  );
  expect(polls).toBe(1);
  expect(window.location.search).toBe("?bounty=bty_7&proposal=bpr_9");
  expect(
    within(panel)
      .getByRole("tab", { name: "Proposal" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  const urls = state.calls.map(({ url }) => url);
  expect(urls.some((url) => url.endsWith("/proposals/bpr_9"))).toBe(true);
  expect(urls.some((url) => url.includes("/proposals?"))).toBe(false);
  // No board: no board runs, and no live titles from Jira.
  expect(urls.some((url) => url.includes("/jira/boards/"))).toBe(false);
  expect(urls.some((url) => url.includes("/proposal-titles"))).toBe(false);

  // The Spec tab shows the bounty as stored: there is no Jira to read.
  await userEvent.click(within(proposal).getByRole("tab", { name: "Spec" }));
  expect(
    await within(proposal).findByText("Retries must not send twice."),
  ).toBeDefined();
  expect(within(proposal).queryByText("Open in Jira")).toBeNull();

  // Back to the bounty, one tab away.
  await userEvent.click(within(panel).getByRole("tab", { name: "Bounty" }));
  expect(window.location.search).toBe("?bounty=bty_7");
  expect(await within(panel).findByTestId("bounty-detail")).toBeDefined();
});

test("a bounty that already has a proposal opens it without sizing", async () => {
  const state = server([
    ["POST", "/bounties/bty_7/propose", () => json({ proposalId: "bpr_9" })],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="owner" />);
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
                issueKey: "B-7",
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="admin" />);
  const detail = await screen.findByTestId("bounty-detail");
  await userEvent.click(
    within(detail).getByRole("button", { name: "Propose" }),
  );

  await screen.findByTestId("proposal-detail");
  expect(window.location.search).toBe("?bounty=bty_7&proposal=bpr_9");
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  const { unmount } = render(<Bounties organizationId="org_1" role="owner" />);
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
  render(<Bounties organizationId="org_1" role="owner" />);
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_1");
  render(<Bounties organizationId="org_1" role="member" />);

  const panel = await screen.findByTestId("bounty-detail");
  expect(within(panel).getByText("Follows its Jira issue")).toBeDefined();
  expect(
    within(panel)
      .getByRole("link", { name: /Open in Jira/ })
      .getAttribute("href"),
  ).toBe("https://acme.atlassian.net/browse/APP-1");

  await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));
  const form = await screen.findByTestId("bounty-form");
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
  expect(await screen.findByTestId("bounty-detail")).toBeDefined();
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="member" />);
  const panel = await screen.findByTestId("bounty-detail");
  await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));
  const form = await screen.findByTestId("bounty-form");
  await userEvent.type(within(form).getByLabelText("Title"), "!");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));

  // The form holds their version now, so a second save cannot undo it.
  const reopened = await screen.findByTestId("bounty-form");
  expect(
    await within(reopened).findByText(/Someone changed this bounty/),
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
      "/bounties/bty_7",
      () =>
        json({
          bounty: detail({ title: "Invitations are not sent!", revision: 2 }),
        }),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="member" />);

  const panel = await screen.findByTestId("bounty-detail");
  await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));
  const unchanged = await screen.findByTestId("bounty-form");
  await userEvent.click(
    within(unchanged).getByRole("button", { name: "Save" }),
  );
  const again = await screen.findByTestId("bounty-detail");
  expect(state.calls.some(({ method }) => method === "PATCH")).toBe(false);

  await userEvent.click(within(again).getByRole("button", { name: "Edit" }));
  const form = await screen.findByTestId("bounty-form");
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
  render(<Bounties organizationId="org_1" role="member" />);
  await screen.findByTestId("bounty-list");
  await userEvent.click(
    screen.getAllByRole("button", { name: "New bounty" })[0]!,
  );
  const form = await screen.findByTestId("bounty-form");
  await userEvent.type(within(form).getByLabelText("Title"), "Many labels");
  await userEvent.click(within(form).getByLabelText("Labels"));
  await userEvent.paste(
    Array.from({ length: 21 }, (_, index) => `label${index}`).join(", "),
  );
  await userEvent.click(
    within(form).getByRole("button", { name: "Create bounty" }),
  );
  expect(
    await within(form).findByText("A bounty takes at most 20 labels."),
  ).toBeDefined();

  const labels = within(form).getByLabelText("Labels");
  await userEvent.clear(labels);
  await userEvent.click(labels);
  await userEvent.paste("x".repeat(65));
  await userEvent.click(
    within(form).getByRole("button", { name: "Create bounty" }),
  );
  expect(
    await within(form).findByText("A label is at most 64 characters long."),
  ).toBeDefined();
  expect(state.calls.some(({ method }) => method === "POST")).toBe(false);
});

test("an admin deletes a bounty with no proposal", async () => {
  const state = server([
    [
      "DELETE",
      "/bounties/bty_7",
      () => Promise.resolve(new Response(null, { status: 204 })),
    ],
  ]);
  vi.stubGlobal("fetch", state.fetchMock);
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="admin" />);
  const panel = await screen.findByTestId("bounty-detail");
  await userEvent.click(
    within(panel).getByRole("button", { name: "Delete bounty" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Delete bounty" }),
  );
  await waitFor(() =>
    expect(state.calls.some(({ method }) => method === "DELETE")).toBe(true),
  );
  await waitFor(() => expect(window.location.search).toBe(""));
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="admin" />);
  const panel = await screen.findByTestId("bounty-detail");
  await userEvent.click(
    within(panel).getByRole("button", { name: "Delete bounty" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Delete bounty" }),
  );
  await screen.findByText(/is being sized, so it cannot be deleted/);
  expect(
    screen.getAllByText(/is being sized, so it cannot be deleted/),
  ).toHaveLength(1);
  expect(window.location.search).toBe("?bounty=bty_7");
});

test("a bounty that no longer exists says so", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      ["GET", "/bounties/bty_gone", () => json({ error: "Not found" }, 404)],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_gone");
  render(<Bounties organizationId="org_1" role="member" />);
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="member" />);
  expect(await screen.findByText("Could not load the bounty.")).toBeDefined();
  expect(screen.queryByText("This bounty no longer exists.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByTestId("bounty-detail")).toBeDefined();
});

test("a link to a bounty past the loaded rows still names its panel", async () => {
  vi.stubGlobal("fetch", server([], []).fetchMock);
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="member" />);
  await screen.findByTestId("bounty-detail");
  const panel = screen.getByTestId("bounty-panel");
  expect(within(panel).getByText("Invitations are not sent")).toBeDefined();
  expect(within(panel).getByText("B-7")).toBeDefined();
});

test("the page lists bounties alone; a proposal opens inside its bounty, and Back steps out", async () => {
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
  window.history.replaceState(null, "", "/o/acme/bounties");
  render(<Bounties organizationId="org_1" role="member" />);
  const list = await screen.findByTestId("bounty-list");
  expect(screen.queryByRole("tab", { name: "Proposals" })).toBeNull();
  // Not proposable from the row: a proposal is made inside its bounty.
  expect(within(list).queryByRole("button", { name: "Propose" })).toBeNull();

  await userEvent.click(
    within(list).getByRole("button", { name: "Open the proposal for B-7" }),
  );
  expect(window.location.search).toBe("?bounty=bty_7&proposal=bpr_9");
  expect(await screen.findByTestId("proposal-detail")).toBeDefined();

  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(await screen.findByTestId("bounty-detail")).toBeDefined();
});

test("an address from when proposals had a tab opens the proposal inside its bounty", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  window.history.replaceState(
    null,
    "",
    "/o/acme/bounties?tab=proposals&proposal=bpr_9",
  );
  render(<Bounties organizationId="org_1" role="member" />);
  await waitFor(() =>
    expect(window.location.search).toBe("?proposal=bpr_9&bounty=bty_7"),
  );
  expect(await screen.findByTestId("proposal-detail")).toBeDefined();
});

test("the bounties page has a path and a trail of its own", () => {
  expect(screenForPath("/o/acme/bounties")).toBe("org-bounties");
  expect(screenForPath("/o/acme/bounties/")).toBe("org-bounties");
  expect(screenForPath("/o/acme/bounties/more")).toBe("org-settings");
  expect(pathForScreen("org-bounties", "acme")).toBe("/o/acme/bounties");
  expect(pathForScreen("org-bounties")).toBe("/workspaces");
  // Where bounties lived while they were called tickets still lands here,
  // with the open one carried over under its new name.
  expect(screenForPath("/o/acme/tickets")).toBe("org-bounties");
  expect(canonicalUrl("/o/acme/tickets", "")).toBe("/o/acme/bounties");
  expect(canonicalUrl("/o/acme/tickets/", "?ticket=tkt_1&tab=proposals")).toBe(
    "/o/acme/bounties?tab=proposals&bounty=tkt_1",
  );
  expect(canonicalUrl("/o/acme/bounties", "?bounty=bty_1")).toBeUndefined();
  expect(canonicalUrl("/o/acme/tickets/more", "")).toBeUndefined();
  expect(
    trailFor("org-bounties", { name: "Acme", slug: "acme" }).map(
      ({ label }) => label,
    ),
  ).toEqual(["Home", "Workspaces", "Acme", "Bounties"]);
  expect(trailFor("org-bounties").map(({ label }) => label)).toEqual([
    "Home",
    "Workspaces",
    "Bounties",
  ]);
});

test("a bounty is its proposal and its sandbox, with context that is optional", async () => {
  vi.stubGlobal("fetch", server().fetchMock);
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="member" />);

  const panel = await screen.findByTestId("bounty-detail");
  const proposalPart = within(panel).getByRole("region", { name: "Proposal" });
  expect(within(proposalPart).getByText(/No proposal yet/)).toBeDefined();
  const sandboxPart = within(panel).getByRole("region", { name: "Sandbox" });
  expect(within(sandboxPart).getByText(/No sandbox yet/)).toBeDefined();
  // A member is told who can make one, and offered nothing to press.
  expect(within(sandboxPart).queryByRole("button")).toBeNull();
  const context = within(panel).getByRole("region", { name: "Context" });
  expect(within(context).getByText("Not linked; written here")).toBeDefined();
  expect(within(context).getByText("None")).toBeDefined();
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="owner" />);

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
  const after = within(await screen.findByTestId("bounty-detail")).getByRole(
    "region",
    { name: "Sandbox" },
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="owner" />);

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

test("a bounty's row says when it has a sandbox, and how far it got", async () => {
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
  render(<Bounties organizationId="org_1" role="member" />);
  const rows = within(await screen.findByTestId("bounty-list")).getAllByRole(
    "listitem",
  );
  expect(within(rows[0]!).getByText("Sandbox Published")).toBeDefined();
  expect(within(rows[1]!).queryByText(/^Sandbox /)).toBeNull();
});

/** A bounty's sandbox in brief, as the bounty reads with it. */
function sandboxOf(overrides: Record<string, unknown> = {}) {
  return {
    id: "sbx_1",
    status: "draft",
    currentVersionId: null,
    sourceRepoId: null,
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="admin" />);
  const panel = await screen.findByTestId("bounty-detail");
  const part = within(panel).getByRole("region", { name: "Sandbox" });
  expect(within(part).getByText("Published")).toBeDefined();
  expect(
    within(part).getByText("Contributors can work in its published version."),
  ).toBeDefined();
  expect(within(part).queryByText(/No repository linked/)).toBeNull();
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="admin" />);

  const panel = await screen.findByTestId("bounty-detail");
  const part = within(panel).getByRole("region", { name: "Sandbox" });
  expect(within(part).getByText(/No repository linked/)).toBeDefined();
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
      ).queryByText(/No repository linked/),
    ).toBeNull(),
  );
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
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="owner" />);
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
  expect(within(part).getByText(/No repository linked/)).toBeDefined();
});

test("a bounty naming no repository is told to name one before linking it", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      [
        "GET",
        "/bounties/bty_7",
        () => json({ bounty: detail({ sandbox: sandboxOf() }) }),
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="admin" />);
  const part = within(await screen.findByTestId("bounty-detail")).getByRole(
    "region",
    { name: "Sandbox" },
  );
  expect(
    within(part).getByText(
      /Edit the bounty to name its repository, then link it\./,
    ),
  ).toBeDefined();
  expect(within(part).queryByRole("button")).toBeNull();
});

test("a member is told who links a sandbox's repository", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      [
        "GET",
        "/bounties/bty_7",
        () =>
          json({ bounty: detail({ repoId: "ghr_1", sandbox: sandboxOf() }) }),
      ],
    ]).fetchMock,
  );
  window.history.replaceState(null, "", "/o/acme/bounties?bounty=bty_7");
  render(<Bounties organizationId="org_1" role="member" />);
  const part = within(await screen.findByTestId("bounty-detail")).getByRole(
    "region",
    { name: "Sandbox" },
  );
  expect(
    within(part).getByText(/An owner or admin can link one\./),
  ).toBeDefined();
  expect(within(part).queryByRole("button")).toBeNull();
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

test("resizing a bounty's proposal moves the size and price its row shows", async () => {
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
  window.history.replaceState(
    null,
    "",
    "/o/acme/bounties?bounty=bty_7&proposal=bpr_9",
  );
  render(<Bounties organizationId="org_1" role="admin" />);
  const row = () => screen.getByLabelText("Open the proposal for B-7");
  await waitFor(() => expect(row().textContent).toContain(money(200, "USD")));

  const peek = await screen.findByTestId("proposal-detail");
  const resize = await within(peek).findByRole("group", { name: "Resize" });
  await userEvent.click(within(resize).getByRole("button", { name: "L" }));
  expect(
    state.calls.find(({ url }) => url.endsWith("/proposals/bpr_9/resize"))
      ?.body,
  ).toEqual({ expectedRevision: 1, complexity: "L" });
  // Applied in place to the proposal, and read again for the bounty's row.
  await waitFor(() => expect(row().textContent).toContain(money(300, "USD")));
  expect(row().textContent).toContain("L");
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
  window.history.replaceState(
    null,
    "",
    "/o/acme/bounties?bounty=bty_7&proposal=bpr_9",
  );
  render(<Bounties organizationId="org_1" role="admin" />);
  const peek = await screen.findByTestId("proposal-detail");
  await userEvent.click(within(peek).getByRole("button", { name: "Remove" }));
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));

  await waitFor(() => expect(window.location.search).toBe("?bounty=bty_7"));
  expect(
    state.calls.find(({ url }) => url.endsWith("/proposals/bpr_9/remove"))
      ?.body,
  ).toEqual({ expectedRevision: 1 });
  const part = within(await screen.findByTestId("bounty-detail")).getByRole(
    "region",
    { name: "Proposal" },
  );
  await waitFor(() =>
    expect(within(part).getByText(/No proposal yet/)).toBeDefined(),
  );
});

test("a bounty's proposal that is gone says so", async () => {
  vi.stubGlobal(
    "fetch",
    server([
      ["GET", "/proposals/bpr_9", () => json({ error: "Not found" }, 404)],
    ]).fetchMock,
  );
  window.history.replaceState(
    null,
    "",
    "/o/acme/bounties?bounty=bty_7&proposal=bpr_9",
  );
  render(<Bounties organizationId="org_1" role="member" />);
  expect(
    await screen.findByText("This proposal no longer exists."),
  ).toBeDefined();
});

test("a bounty's proposal that could not be read is offered again, not called gone", async () => {
  const base = server();
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
  window.history.replaceState(
    null,
    "",
    "/o/acme/bounties?bounty=bty_7&proposal=bpr_9",
  );
  render(<Bounties organizationId="org_1" role="member" />);
  expect(await screen.findByText("Could not load the proposal.")).toBeDefined();
  expect(screen.queryByText("This proposal no longer exists.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByTestId("proposal-detail")).toBeDefined();
});
