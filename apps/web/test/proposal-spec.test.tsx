import type { BountySpecDto } from "@sandbox-factory/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import {
  ProposalSpec,
  scenarioTotal,
  useProposalSpec,
} from "../src/ProposalSpec";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BASE = "/api/v1/orgs/org_1";

/** The read and the view, wired as the peek wires them. */
function Wired({
  base,
  proposalId,
  specRevision,
  canAnalyze,
}: {
  base: string;
  proposalId: string;
  specRevision: number | null | undefined;
  canAnalyze: boolean;
}) {
  const { read, retry } = useProposalSpec(base, proposalId, specRevision);
  return <ProposalSpec read={read} onRetry={retry} canAnalyze={canAnalyze} />;
}

function scenario(id: string, kind: string, title: string, overrides = {}) {
  return {
    id,
    kind,
    title,
    steps: [
      { keyword: "Given", text: `a precondition for ${id}` },
      { keyword: "When", text: `the action of ${id}` },
      { keyword: "Then", text: `the outcome of ${id}` },
    ],
    origin: "draft",
    ...overrides,
  };
}

function spec(draft: object = {}, overrides: object = {}) {
  return {
    id: "bsp_1",
    organizationId: "org_1",
    proposalId: "bpr_1",
    revision: 1,
    specHash: "a".repeat(64),
    specHashVersion: 1,
    draft: {
      feature: "Interview invitation delivery",
      background: ["a recruiter is signed in", "an open requisition exists"],
      // Out of kind order on purpose: the block orders by kind, not by id.
      scenarios: [
        scenario("s1", "unhappy", "The mail provider is down"),
        scenario("s2", "happy", "An invitation is delivered"),
        scenario("s3", "boundary", "The last free slot", {
          origin: "expansion",
        }),
        scenario("s4", "happy", "A reminder follows the invitation"),
        scenario("s5", "unhappy", "The candidate has no address"),
      ],
      openQuestions: ["Which timezone is the slot shown in?"],
      assumptions: [
        "Invitations go by email only.",
        "One invitation per slot.",
      ],
      ...draft,
    },
    origin: "draft",
    instruction: null,
    createdBy: null,
    runId: "brn_1",
    actualModel: "claude-sonnet-5",
    promptVersion: "draft-v1",
    createdAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

/** A server that answers the spec read, and records what it was asked. */
function server(answer: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchMock = vi.fn((input: string) => {
    calls.push(String(input));
    return Promise.resolve(answer());
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function block(
  props: Partial<Parameters<typeof Wired>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <Wired
      base={BASE}
      proposalId="bpr_1"
      specRevision={1}
      canAnalyze={false}
      {...props}
    />,
  );
}

/** Each group's heading text, as "Label count". */
function headings(container: HTMLElement) {
  return within(container)
    .getAllByRole("heading", { level: 4 })
    .map((heading) => heading.textContent);
}

test("scenarios are grouped by kind, in the kinds' order, each group counted", async () => {
  const calls = server(() => Response.json({ spec: spec() }));
  block();
  const panel = await screen.findByTestId("proposal-spec");
  await within(panel).findByText("Interview invitation delivery");

  expect(calls).toEqual([`${BASE}/proposals/bpr_1/spec`]);
  // Happy before boundary before unhappy, whatever order they were drafted
  // in, then what the ticket left open and what the draft assumed.
  expect(headings(panel)).toEqual([
    "Background",
    "Happy path2",
    "Boundary1",
    "Unhappy path2",
    "Open questions1",
    "Assumptions2",
  ]);
  // A kind the spec has none of gets no empty heading.
  expect(within(panel).queryByText("Concurrency")).toBeNull();

  const happy = within(panel).getByRole("region", { name: "Happy path" });
  expect(
    within(happy)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual([
    "An invitation is delivered",
    "A reminder follows the invitation",
  ]);
  const unhappy = within(panel).getByRole("region", { name: "Unhappy path" });
  expect(within(unhappy).getAllByRole("button")).toHaveLength(2);

  // The total, and which revision this is.
  expect(within(panel).getByText("5 scenarios · revision 1")).toBeDefined();
});

test("a scenario opens to its steps and closes again", async () => {
  server(() => Response.json({ spec: spec() }));
  block();
  const panel = await screen.findByTestId("proposal-spec");
  const title = await within(panel).findByRole("button", {
    name: "An invitation is delivered",
  });

  // Closed to begin with: the spec reads as a list of what is covered.
  expect(title.getAttribute("aria-expanded")).toBe("false");
  expect(within(panel).queryByText("the outcome of s2")).toBeNull();

  await userEvent.click(title);
  expect(title.getAttribute("aria-expanded")).toBe("true");
  const steps = document.getElementById(
    title.getAttribute("aria-controls") ?? "",
  );
  expect(steps).not.toBeNull();
  expect(
    within(steps!)
      .getAllByRole("listitem")
      .map((step) => step.textContent),
  ).toEqual([
    "Givena precondition for s2",
    "Whenthe action of s2",
    "Thenthe outcome of s2",
  ]);
  // Opening one leaves the others closed.
  expect(within(panel).queryByText("the outcome of s4")).toBeNull();

  await userEvent.click(title);
  expect(title.getAttribute("aria-expanded")).toBe("false");
  expect(within(panel).queryByText("the outcome of s2")).toBeNull();
});

test("the background reads as Given and And, and the notes are listed", async () => {
  server(() => Response.json({ spec: spec() }));
  block();
  const panel = await screen.findByTestId("proposal-spec");

  const background = await within(panel).findByRole("region", {
    name: "Background",
  });
  expect(
    within(background)
      .getAllByRole("listitem")
      .map((step) => step.textContent),
  ).toEqual(["Givena recruiter is signed in", "Andan open requisition exists"]);

  const questions = within(panel).getByRole("region", {
    name: "Open questions",
  });
  expect(
    within(questions)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Which timezone is the slot shown in?"]);
  const assumptions = within(panel).getByRole("region", {
    name: "Assumptions",
  });
  expect(within(assumptions).getAllByRole("listitem")).toHaveLength(2);
});

test("a scenario the first draft did not write says where it came from", async () => {
  server(() => Response.json({ spec: spec() }));
  block();
  const panel = await screen.findByTestId("proposal-spec");

  const added = await within(panel).findByRole("button", {
    name: /The last free slot/,
  });
  expect(within(added).getByText("Added")).toBeDefined();
  // A drafted scenario carries no badge: it is the ordinary case.
  const drafted = within(panel).getByRole("button", {
    name: "An invitation is delivered",
  });
  expect(drafted.querySelector("[data-slot='badge']")).toBeNull();
});

test("a spec with one scenario and nothing else shows only that", async () => {
  server(() =>
    Response.json({
      spec: spec({
        background: [],
        scenarios: [scenario("s1", "happy", "The label is corrected")],
        openQuestions: [],
        assumptions: [],
      }),
    }),
  );
  block();
  const panel = await screen.findByTestId("proposal-spec");
  await within(panel).findByText("The label is corrected");

  expect(headings(panel)).toEqual(["Happy path1"]);
  expect(within(panel).getByText("1 scenario · revision 1")).toBeDefined();
});

test("a spec of open questions alone says the ticket described no behaviour", async () => {
  server(() =>
    Response.json({
      spec: spec({
        background: [],
        scenarios: [],
        openQuestions: ["What should the export contain?"],
        assumptions: [],
      }),
    }),
  );
  block();
  const panel = await screen.findByTestId("proposal-spec");

  expect(
    await within(panel).findByText(
      "The ticket did not describe behaviour to write a scenario for.",
    ),
  ).toBeDefined();
  expect(headings(panel)).toEqual(["Open questions1"]);
  expect(within(panel).getByText("0 scenarios · revision 1")).toBeDefined();
});

test("a proposal from before specs says so, and asks the server nothing", async () => {
  const calls = server(() => Response.json({ spec: null }));
  // Null is what a stored proposal says; absent is a row from a server
  // that does not send the field at all.
  for (const specRevision of [null, undefined]) {
    const view = block({ specRevision });
    const empty = screen.getByTestId("spec-empty");
    expect(empty.textContent).toBe(
      "No scenarios were drafted for this proposal.",
    );
    expect(screen.queryByRole("status")).toBeNull();
    view.unmount();
  }
  expect(calls).toEqual([]);
});

test("someone who can re-analyze is told that it drafts the scenarios", () => {
  server(() => Response.json({ spec: null }));
  block({ specRevision: null, canAnalyze: true });
  expect(screen.getByTestId("spec-empty").textContent).toBe(
    "No scenarios were drafted for this proposal. Re-analyze, on the Bounty tab, drafts them from the ticket as it is now.",
  );
});

test("a pointer the server has no spec for reads as none", async () => {
  server(() => Response.json({ spec: null }));
  block();
  expect(await screen.findByTestId("spec-empty")).toBeDefined();
});

test("a response that is not a spec is no spec, not a crash", async () => {
  for (const body of [
    null,
    "spec",
    {},
    { spec: "text" },
    { spec: {} },
    { spec: { draft: null } },
    { spec: { draft: { feature: "F", scenarios: "none" } } },
    { spec: { draft: { feature: 7, background: [], scenarios: [] } } },
  ]) {
    server(() => Response.json(body));
    const view = block();
    expect(await screen.findByTestId("spec-empty")).toBeDefined();
    view.unmount();
  }
});

test("the block says it is loading until the spec lands", async () => {
  let release = (_response: Response) => {};
  server(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  block();
  const panel = screen.getByTestId("proposal-spec");

  expect(within(panel).getByRole("status").textContent).toBe(
    "Loading scenarios…",
  );
  expect(within(panel).queryByTestId("spec-empty")).toBeNull();

  release(Response.json({ spec: spec() }));
  expect(
    await within(panel).findByText("Interview invitation delivery"),
  ).toBeDefined();
  expect(within(panel).queryByRole("status")).toBeNull();
});

test("a failed read offers another try, which reads again", async () => {
  let healthy = false;
  const calls = server(() =>
    healthy
      ? Response.json({ spec: spec() })
      : new Response("", { status: 500 }),
  );
  block();
  const panel = screen.getByTestId("proposal-spec");

  expect(
    await within(panel).findByText("The scenarios could not be loaded."),
  ).toBeDefined();
  // Not the empty state: nothing is known about whether there is a spec.
  expect(within(panel).queryByTestId("spec-empty")).toBeNull();

  healthy = true;
  await userEvent.click(
    within(panel).getByRole("button", { name: "Try again" }),
  );
  expect(
    await within(panel).findByText("Interview invitation delivery"),
  ).toBeDefined();
  expect(calls).toHaveLength(2);
});

test("a server that cannot be reached is a failed read too", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline"))),
  );
  block();
  expect(
    await screen.findByText("The scenarios could not be loaded."),
  ).toBeDefined();
});

test("a new revision is read, and the old scenarios do not stand in for it", async () => {
  let revision = 1;
  const calls = server(() =>
    Response.json({
      spec: spec(
        {
          scenarios: [
            scenario("s1", "happy", `Drafted for revision ${revision}`),
          ],
        },
        { revision },
      ),
    }),
  );
  const view = block();
  await screen.findByText("Drafted for revision 1");

  // A re-price moved the proposal to a second revision.
  revision = 2;
  view.rerender(
    <Wired
      base={BASE}
      proposalId="bpr_1"
      specRevision={2}
      canAnalyze={false}
    />,
  );
  // Not the first revision's scenarios under the new one's heading.
  expect(screen.queryByText("Drafted for revision 1")).toBeNull();
  expect(await screen.findByText("Drafted for revision 2")).toBeDefined();
  expect(screen.getByText("1 scenario · revision 2")).toBeDefined();
  expect(calls).toHaveLength(2);
});

test("moving to another proposal reads that proposal's spec", async () => {
  const calls = server(() => Response.json({ spec: spec() }));
  const view = block();
  await screen.findByText("Interview invitation delivery");

  view.rerender(
    <Wired
      base={BASE}
      proposalId="bpr/2"
      specRevision={1}
      canAnalyze={false}
    />,
  );
  await waitFor(() => expect(calls).toHaveLength(2));
  // The id is a path segment, and is sent as one.
  expect(calls[1]).toBe(`${BASE}/proposals/bpr%2F2/spec`);
});

test("the tab's count is the spec's scenarios, and unknown until it is read", () => {
  expect(scenarioTotal({ state: "loading" })).toBeNull();
  expect(scenarioTotal({ state: "failed" })).toBeNull();
  expect(scenarioTotal({ state: "ready", spec: null })).toBeNull();
  expect(
    scenarioTotal({
      state: "ready",
      spec: spec() as unknown as BountySpecDto,
    }),
  ).toBe(5);
});
