import { act, render, renderHook, screen, within } from "./render";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { ProposalSpec, useProposalSpec } from "../src/ProposalSpec";
import { respecResult, useRespec } from "../src/SpecChanges";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BASE = "/api/v1/orgs/org_1";

function scenario(id: string, kind: string, title: string, weight = "light") {
  return {
    id,
    kind,
    title,
    steps: [{ keyword: "Then", text: `the outcome of ${id}` }],
    origin: "draft",
    weight,
  };
}

function spec(revision: number, overrides: object = {}) {
  return {
    id: `bsp_${revision}`,
    organizationId: "org_1",
    proposalId: "bpr_1",
    revision,
    specHash: "a".repeat(64),
    specHashVersion: 1,
    draft: {
      feature: "Interview invitation delivery",
      background: [],
      scenarios: [
        scenario("s1", "happy", "An invitation is delivered", "moderate"),
        scenario("s2", "unhappy", "The mail provider is down"),
      ],
      openQuestions: [
        "Which timezone is the slot shown in?",
        "Can a candidate decline?",
      ],
      assumptions: [],
    },
    origin: "draft",
    instruction: null,
    createdBy: null,
    runId: "brn_1",
    actualModel: "claude-sonnet-5",
    promptVersion: "draft-v2",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function finished(outcome: object | null, overrides: object = {}) {
  return {
    run: {
      id: "brn_respec",
      organizationId: "org_1",
      boardId: null,
      bountyId: null,
      sourceProposalId: "bpr_1",
      sourceRevision: 4,
      respec: null,
      requestId: "00000000-0000-4000-8000-000000000001",
      selection: {},
      rateCard: {
        currency: "USD",
        xsMinor: 100,
        sMinor: 200,
        mMinor: 400,
        lMinor: 800,
        xlMinor: 1600,
        revision: 1,
      },
      requestedModel: "test",
      promptVersion: "test",
      planned: [],
      candidatesScanned: 0,
      skippedLive: 0,
      scanLimitReached: false,
      startedAt: null,
      deadlineAt: null,
      finishedAt: null,
      createdAt: "2026-10-02T00:00:00.000Z",
      kind: "respec",
      status: "succeeded",
      outcomes: outcome === null ? [] : [outcome],
      fatalErrorCode: null,
      ...overrides,
    },
  };
}

const landed = {
  externalIssueId: "100",
  issueKey: "APP-1",
  status: "proposed",
  previousComplexity: "S",
  pointsDelta: 4,
};

interface Request {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/**
 * A server for the tab: the spec at any revision, its history, the change
 * endpoint and the run it starts. Records what it was asked.
 */
function server(
  options: {
    respec?: () => Response;
    run?: () => object;
    revisions?: object[];
    specFor?: (revision: string | null) => object;
  } = {},
) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith("/respec")) {
        return Promise.resolve(
          options.respec?.() ??
            Response.json(finished(null, { status: "queued" }), {
              status: 202,
            }),
        );
      }
      if (url.includes("/runs/")) {
        return Promise.resolve(
          Response.json(options.run?.() ?? finished(landed)),
        );
      }
      if (url.endsWith("/spec/revisions")) {
        return Promise.resolve(
          Response.json({ revisions: options.revisions ?? [] }),
        );
      }
      const revision = new URL(url, "http://test").searchParams.get("revision");
      return Promise.resolve(
        Response.json({
          spec: options.specFor?.(revision) ?? spec(Number(revision ?? 3)),
        }),
      );
    }),
  );
  return requests;
}

/** The tab wired as the peek wires it, with a size that a landing moves. */
function Wired({
  specRevision = 3,
  canChange = true,
  onLanded,
}: {
  specRevision?: number;
  canChange?: boolean;
  onLanded?: () => void;
}) {
  const [size, setSize] = useState("S");
  const { read, retry } = useProposalSpec(BASE, "bpr_1", specRevision);
  const control = useRespec(BASE, "bpr_1", 4, () => {
    onLanded?.();
    setSize("S+");
  });
  return (
    <ProposalSpec
      read={read}
      onRetry={retry}
      canAnalyze={canChange}
      history={{ base: BASE, proposalId: "bpr_1", specRevision }}
      {...(canChange ? { changes: { control, size } } : {})}
    />
  );
}

const respecPosts = (requests: Request[]) =>
  requests.filter(
    ({ url, method }) => method === "POST" && url.endsWith("/respec"),
  );

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: /add scenarios/i }),
  );
  return screen.findByRole("menu");
}

test("more of a kind is asked for, followed, and said in one line once it lands", async () => {
  const requests = server();
  const onLanded = vi.fn();
  const user = userEvent.setup();
  render(<Wired onLanded={onLanded} />);

  const menu = await openMenu(user);
  // Every kind is offered, so "more of a kind" needs no second menu.
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Happy path",
    "Boundary",
    "Unhappy path",
    "Recovery",
    "Permission",
    "Concurrency",
    "Non-functional",
    "Answer open questions…",
    "Describe what to add…",
  ]);
  await user.click(within(menu).getByRole("menuitem", { name: "Boundary" }));

  expect(
    await screen.findByText("Writing more boundary scenarios…"),
  ).toBeDefined();
  const [post] = respecPosts(requests);
  expect(post?.url).toBe(`${BASE}/proposals/bpr_1/respec`);
  expect(post?.body).toEqual({
    expectedRevision: 4,
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    request: { mode: "expand", kinds: ["boundary"] },
  });
  // While it runs, nothing else can be asked for.
  expect(
    (
      screen.getByRole("button", {
        name: /add scenarios/i,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  // The run is followed to its end, the proposal read again, and then the
  // line says what the change did to the size.
  const status = await screen.findByText("S → S+", {}, { timeout: 3_000 });
  expect(status.parentElement?.textContent).toBe("S → S+: +4 points");
  expect(onLanded).toHaveBeenCalledOnce();
  expect(requests.some(({ url }) => url === `${BASE}/runs/brn_respec`)).toBe(
    true,
  );
});

test("answers are sent for the questions filled in, and the rest stay open", async () => {
  const requests = server();
  const user = userEvent.setup();
  render(<Wired />);

  const menu = await openMenu(user);
  await user.click(
    within(menu).getByRole("menuitem", { name: "Answer open questions…" }),
  );
  const form = await screen.findByRole("form", {
    name: "Answer open questions",
  });
  const submit = within(form).getByRole("button", { name: /revise for/i });
  expect((submit as HTMLButtonElement).disabled).toBe(true);

  await user.type(
    within(form).getByLabelText("Can a candidate decline?"),
    "Yes, until the day before.",
  );
  await user.click(submit);

  expect(respecPosts(requests)[0]?.body).toMatchObject({
    request: {
      mode: "answer",
      answers: [
        {
          question: "Can a candidate decline?",
          answer: "Yes, until the day before.",
        },
      ],
    },
  });
  // The form closes once it is sent.
  expect(
    screen.queryByRole("form", { name: "Answer open questions" }),
  ).toBeNull();
  expect(
    await screen.findByText("Revising the spec for your answer…"),
  ).toBeDefined();
});

test("a free instruction asks for the scenarios it describes", async () => {
  const requests = server();
  const user = userEvent.setup();
  render(<Wired />);

  // Cancelled, it sends nothing.
  await user.click(
    within(await openMenu(user)).getByRole("menuitem", {
      name: "Describe what to add…",
    }),
  );
  await user.click(
    within(
      await screen.findByRole("form", { name: "Describe what to add" }),
    ).getByRole("button", { name: "Cancel" }),
  );
  expect(
    screen.queryByRole("form", { name: "Describe what to add" }),
  ).toBeNull();

  await user.click(
    within(await openMenu(user)).getByRole("menuitem", {
      name: "Describe what to add…",
    }),
  );
  const form = await screen.findByRole("form", {
    name: "Describe what to add",
  });
  await user.type(
    within(form).getByLabelText("What should the new scenarios cover?"),
    "  A recruiter on a phone.  ",
  );
  await user.click(within(form).getByRole("button", { name: "Add scenarios" }));

  expect(respecPosts(requests)).toHaveLength(1);
  expect(respecPosts(requests)[0]?.body).toMatchObject({
    request: { mode: "expand", instruction: "A recruiter on a phone." },
  });
  expect(
    await screen.findByText("Writing the scenarios you asked for…"),
  ).toBeDefined();
});

test("a scenario is taken out after the reviewer confirms", async () => {
  const requests = server();
  const user = userEvent.setup();
  render(<Wired />);

  await user.click(
    await screen.findByRole("button", {
      name: "Remove scenario: The mail provider is down",
    }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("The mail provider is down");
  // Not yet: only the confirmation sends it.
  expect(respecPosts(requests)).toHaveLength(0);
  await user.click(
    within(dialog).getByRole("button", { name: "Remove scenario" }),
  );

  expect(respecPosts(requests)[0]?.body).toMatchObject({
    request: { mode: "trim", removeScenarioIds: ["s2"] },
  });
  expect(
    await screen.findByText("Removing “The mail provider is down”…"),
  ).toBeDefined();
});

test("a refused change says why, and one already running is followed instead", async () => {
  server({
    respec: () =>
      Response.json(
        {
          code: "proposal_stale",
          error:
            "The bounty changed since it was sized. Re-analyze it before changing its scenarios.",
        },
        { status: 409 },
      ),
  });
  const user = userEvent.setup();
  const { unmount } = render(<Wired />);
  await user.click(
    within(await openMenu(user)).getByRole("menuitem", { name: "Recovery" }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The bounty changed since it was sized. Re-analyze it before changing its scenarios.",
  );
  unmount();

  const requests = server({
    respec: () =>
      Response.json(
        { code: "run_active", error: "Busy.", runId: "brn_9" },
        { status: 409 },
      ),
  });
  render(<Wired />);
  await user.click(
    within(await openMenu(user)).getByRole("menuitem", { name: "Recovery" }),
  );
  expect(
    await screen.findByText("Waiting for the change already under way…"),
  ).toBeDefined();
  await screen.findByText("S → S+", {}, { timeout: 3_000 });
  expect(requests.some(({ url }) => url === `${BASE}/runs/brn_9`)).toBe(true);
});

test("a run that ends without a change says why", () => {
  expect(
    respecResult(
      finished({ ...landed, status: "skipped", code: "nothing_added" })
        .run as never,
    ),
  ).toEqual({
    phase: "ended",
    tone: "note",
    line: "Nothing new to add: the spec already covers that.",
  });
  expect(
    respecResult(
      finished({ ...landed, status: "failed", code: "proposal_stale" })
        .run as never,
    ),
  ).toMatchObject({
    tone: "error",
    line: expect.stringMatching(/^The bounty changed/),
  });
  expect(
    respecResult(
      finished({ ...landed, status: "failed", code: "something_new" })
        .run as never,
    ),
  ).toMatchObject({ line: "The change could not be made. Try again." });
  expect(
    respecResult(
      finished(null, { status: "failed", fatalErrorCode: "reconnect" })
        .run as never,
    ),
  ).toMatchObject({ line: "Reconnect Jira, then try again." });
  expect(
    respecResult(
      finished(null, { status: "failed", fatalErrorCode: "sizing_provider" })
        .run as never,
    ),
  ).toMatchObject({ line: "The model could not be reached. Try again later." });
  expect(
    respecResult(finished(null, { status: "failed" }).run as never),
  ).toMatchObject({ line: "The change could not be made. Try again." });
});

test("a landed change that did not move the size says so, with the points it moved", async () => {
  server({
    run: () =>
      finished({ ...landed, previousComplexity: "S+", pointsDelta: -1 }),
  });
  const user = userEvent.setup();
  render(<Wired />);
  await user.click(
    await screen.findByRole("button", {
      name: "Remove scenario: An invitation is delivered",
    }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove scenario",
    }),
  );
  const status = await screen.findByText("Still S+", {}, { timeout: 3_000 });
  expect(status.parentElement?.textContent).toBe("Still S+: −1 point");
});

test("a reader who may not change the spec has no controls", async () => {
  server();
  render(<Wired canChange={false} />);
  await screen.findByText("Interview invitation delivery");
  expect(screen.queryByRole("button", { name: /add scenarios/i })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /^remove scenario/i }),
  ).toBeNull();
});

test("an earlier revision is read from the picker, read-only, and the current one is a click away", async () => {
  const requests = server({
    revisions: [
      {
        revision: 3,
        origin: "expand",
        instruction: "More boundary scenarios",
        scenarioCount: 2,
        openQuestionCount: 2,
        createdBy: "user_1",
        createdAt: "2026-10-01T02:00:00.000Z",
        current: true,
      },
      {
        revision: 2,
        origin: "trim",
        instruction: "Removed A",
        scenarioCount: 1,
        openQuestionCount: 2,
        createdBy: "user_1",
        createdAt: "2026-10-01T01:00:00.000Z",
        current: false,
      },
      {
        revision: 1,
        origin: "draft",
        instruction: null,
        scenarioCount: 2,
        openQuestionCount: 2,
        createdBy: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        current: false,
      },
    ],
    specFor: (revision) =>
      revision === "1"
        ? spec(1)
        : spec(3, { origin: "expand", instruction: "More boundary scenarios" }),
  });
  const user = userEvent.setup();
  render(<Wired />);

  // The revision the reviewer asked for says what was asked.
  expect((await screen.findByTestId("spec-instruction")).textContent).toBe(
    "Asked for: More boundary scenarios",
  );
  const picker = await screen.findByRole("combobox", { name: "Revision" });
  expect(
    within(picker)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual([
    "revision 3, expanded (current)",
    "revision 2, trimmed",
    "revision 1, drafted",
  ]);

  await user.selectOptions(picker, "1");
  expect((await screen.findByTestId("spec-earlier")).textContent).toContain(
    "An earlier revision. The size goes with revision 3.",
  );
  expect(
    requests.some(
      ({ url }) => url === `${BASE}/proposals/bpr_1/spec?revision=1`,
    ),
  ).toBe(true);
  // Read-only: an earlier revision is not what a change would change.
  expect(screen.queryByRole("button", { name: /add scenarios/i })).toBeNull();
  expect(screen.queryByTestId("spec-instruction")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Show current" }));
  expect(
    await screen.findByRole("button", { name: /add scenarios/i }),
  ).toBeDefined();
  expect(screen.queryByTestId("spec-earlier")).toBeNull();
});

test("a spec at its first revision has no history to read", async () => {
  const requests = server();
  render(<Wired specRevision={1} />);
  await screen.findByText("Interview invitation delivery");
  expect(screen.queryByRole("combobox", { name: "Revision" })).toBeNull();
  expect(requests.some(({ url }) => url.endsWith("/spec/revisions"))).toBe(
    false,
  );
});

test("a late spec-change POST cannot attach its run after changing workspace or proposal", async () => {
  let release: ((response: Response) => void) | undefined;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const onLanded = vi.fn();
  const hook = renderHook(
    ({ base, proposalId }) => useRespec(base, proposalId, 4, onLanded),
    { initialProps: { base: BASE, proposalId: "bpr_1" } },
  );
  await act(async () => {
    hook.result.current.request(
      { mode: "expand", kinds: ["boundary"] },
      "Changing",
    );
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  hook.rerender({ base: "/api/v1/orgs/org_2", proposalId: "bpr_2" });
  await act(async () => {
    release?.(
      Response.json(finished(null, { status: "queued" }), { status: 202 }),
    );
  });
  expect(hook.result.current.state.phase).toBe("idle");
  expect(onLanded).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
