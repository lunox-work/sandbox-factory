import type { BountyProposalDto, BountySpecDto } from "@sandbox-factory/shared";
import userEvent from "@testing-library/user-event";
import {
  assessRubric,
  COMPLEXITY_PROFILE_VERSION,
  type ComplexityProfile,
  type RubricCode,
  type SpecDraft,
} from "sandbox-factory";
import { expect, test, vi } from "vitest";

import { money } from "../src/lib/format";
import { PricingRubricBlock } from "../src/PricingRubric";
import type { ShownSpec } from "../src/ProposalSpec";
import type { RespecControl } from "../src/SpecChanges";
import { render, screen, waitFor, within } from "./render";

/** The worked example: three scenarios, five outcomes. */
const spec: SpecDraft = {
  feature: "Interview invitations",
  background: [],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "One invitation",
      steps: [
        { keyword: "When", text: "saved" },
        { keyword: "Then", text: "one email" },
        { keyword: "And", text: "the time is in it" },
      ],
      origin: "draft",
      weight: "moderate",
    },
    {
      id: "s2",
      kind: "recovery",
      title: "Retried once",
      steps: [{ keyword: "Then", text: "exactly one email" }],
      origin: "draft",
      weight: "heavy",
    },
    {
      id: "s3",
      kind: "happy",
      title: "Rescheduled",
      steps: [
        { keyword: "Then", text: "one updated email" },
        { keyword: "And", text: "none for the old time" },
      ],
      origin: "draft",
      weight: "moderate",
    },
  ],
  openQuestions: [],
  assumptions: [],
};

const profile: ComplexityProfile = {
  version: COMPLEXITY_PROFILE_VERSION,
  slice: {
    files: 9,
    bytes: 53_000,
    modules: ["src/mailer", "src/scheduler"],
    stubCoverage: "full",
    blockers: 0,
    ready: true,
  },
  touchedModules: ["src/mailer", "src/scheduler"],
  externals: { services: ["email"], environment: 0, seams: 1 },
  spec: {
    scenarios: 3,
    kinds: {
      happy: 2,
      boundary: 0,
      unhappy: 0,
      recovery: 1,
      permission: 0,
      concurrency: 0,
      "non-functional": 0,
    },
    openQuestions: 0,
    assumptions: 0,
  },
  tests: { files: 1, untestedModules: [] },
  pattern: { path: "src/mailer/offer.ts", reason: "retries idempotently" },
  nonFunctional: { scenarios: 0, migrations: false, ci: true },
  risks: [],
};

const card = {
  currency: "USD",
  xsMinor: 1_000,
  sMinor: 5_800,
  mMinor: 10_500,
  lMinor: 15_300,
  xlMinor: 20_000,
  revision: 1,
};

const measured: RubricCode = {
  status: "measured",
  profile,
  specRevision: 2,
};

type Props = Parameters<typeof PricingRubricBlock>[0]["proposal"];

function proposal(overrides: Partial<Props> = {}): Props {
  return {
    rubric: assessRubric({
      spec,
      code: measured,
    }) as BountyProposalDto["rubric"],
    sizedBy: "rubric",
    complexity: "M",
    modelComplexity: "S",
    rateCard: card,
    ...overrides,
  };
}

test("nothing is shown for a proposal sized before the rubric", () => {
  const { container } = render(
    <PricingRubricBlock
      proposal={proposal({ rubric: null })}
      canUse
      busy={false}
      onUse={() => {}}
    />,
  );
  expect(container.textContent).toBe("");
});

test("a rubric-sized price shows its working, factor by factor, and its band", () => {
  render(
    <PricingRubricBlock
      proposal={proposal()}
      canUse
      busy={false}
      onUse={() => {}}
    />,
  );
  const block = screen.getByRole("region", { name: "Why this price" });
  expect(within(block).getByTestId("rubric-total").textContent).toBe(
    "19 points →is M",
  );
  expect(within(block).getByTestId("rubric-source").textContent).toBe(
    "The rubric set this size.",
  );
  expect(within(block).getByTestId("rubric-rationale").textContent).toBe(
    "19 points: 8 from scenarios, 5 from test cases, 6 from code. 15 to 20 points is M. 2 more points would make it M+.",
  );

  // Each dimension sums its factors, each with what was counted.
  const scenarios = within(block).getByTestId("rubric-scenarios");
  expect(scenarios.textContent).toContain("Moderate scenarios2 × 2+4");
  expect(scenarios.textContent).toContain("Heavy scenarios1 × 4+4");
  const tests = within(block).getByTestId("rubric-tests");
  expect(tests.textContent).toContain("Test cases3 scenarios, one test each+3");
  expect(tests.textContent).toContain(
    "Additional checks5 outcomes checked in all+2",
  );
  const code = within(block).getByTestId("rubric-code");
  expect(code.textContent).toContain(
    "Modules touched2: src/mailer, src/scheduler+3",
  );
  // A discount reads as one.
  expect(code.textContent).toContain("Analogous patternsrc/mailer/offer.ts-2");
  expect(code.textContent).toContain("Measured for spec revision 2.");

  // Every size, with its points and its price on this card; M is in force.
  const rungs = within(within(block).getByTestId("rubric-ladder")).getAllByRole(
    "listitem",
  );
  expect(rungs).toHaveLength(9);
  const m = rungs[4];
  expect(m?.getAttribute("aria-current")).toBe("true");
  expect(m?.textContent).toContain("15–20");
  expect(m?.textContent).toContain(money(10_500, "USD"));
  expect(rungs[8]?.textContent).toContain("48+");
  // A half size prices between its neighbours.
  expect(rungs[5]?.textContent).toContain(money(12_900, "USD"));

  // Already the rubric's: nothing to offer.
  expect(within(block).queryByRole("button")).toBeNull();
});

test("the rules are folded away, and say what each factor scores and why", async () => {
  render(
    <PricingRubricBlock
      proposal={proposal()}
      canUse={false}
      busy={false}
      onUse={() => {}}
    />,
  );
  const rules = screen.getByTestId("rubric-rules");
  expect(rules.hasAttribute("open")).toBe(false);
  await userEvent.click(within(rules).getByText("How the rubric scores"));
  expect(rules.hasAttribute("open")).toBe(true);
  expect(rules.textContent).toContain("Heavy scenario4 each");
  expect(rules.textContent).toContain(
    "Modules touched3 per module beyond the first",
  );
  expect(rules.textContent).toContain(
    "Changes across module boundaries are the strongest predictor",
  );
});

test("while the code is measured, the model's size stands and the code says so", () => {
  render(
    <PricingRubricBlock
      proposal={proposal({
        sizedBy: "model",
        rubric: assessRubric({
          spec,
          code: { status: "pending" },
        }) as BountyProposalDto["rubric"],
      })}
      canUse
      busy={false}
      onUse={() => {}}
    />,
  );
  expect(screen.getByTestId("rubric-total").textContent).toBe("13 points");
  expect(screen.getByTestId("rubric-source").textContent).toBe(
    "The model's S stands until the code is measured.",
  );
  const code = screen.getByTestId("rubric-code");
  expect(within(code).getByRole("status").textContent).toBe(
    "Being measured from the repository's code graph.",
  );
  expect(code.textContent).toContain("—");
  expect(screen.queryByRole("button", { name: /rubric/ })).toBeNull();
});

test("code with nothing to measure, or that failed, says why", () => {
  const { rerender } = render(
    <PricingRubricBlock
      proposal={proposal({
        sizedBy: "model",
        rubric: assessRubric({
          spec,
          code: { status: "unavailable" },
        }) as BountyProposalDto["rubric"],
      })}
      canUse
      busy={false}
      onUse={() => {}}
    />,
  );
  expect(screen.getByTestId("rubric-source").textContent).toBe(
    "The model's S stands: the rubric needs the code to size.",
  );
  expect(screen.getByTestId("rubric-code").textContent).toContain(
    "Not measured: the bounty has no repository to measure.",
  );
  rerender(
    <PricingRubricBlock
      proposal={proposal({
        sizedBy: "model",
        rubric: assessRubric({
          spec,
          code: { status: "failed" },
        }) as BountyProposalDto["rubric"],
      })}
      canUse
      busy={false}
      onUse={() => {}}
    />,
  );
  expect(screen.getByTestId("rubric-code").textContent).toContain(
    "Could not be measured. Re-analyze to try again.",
  );
});

test("over a reviewer's size the rubric's is offered back", async () => {
  const onUse = vi.fn();
  const { rerender } = render(
    <PricingRubricBlock
      proposal={proposal({ sizedBy: "reviewer", complexity: "L" })}
      canUse
      busy={false}
      onUse={onUse}
    />,
  );
  expect(screen.getByTestId("rubric-source").textContent).toBe(
    "A reviewer set this size; the rubric says M.",
  );
  // The size in force is filled, the rubric's only outlined.
  const rungs = within(screen.getByTestId("rubric-ladder")).getAllByRole(
    "listitem",
  );
  expect(rungs[6]?.getAttribute("aria-current")).toBe("true");
  expect(rungs[4]?.textContent).toContain("(the rubric's size)");
  await userEvent.click(
    screen.getByRole("button", { name: "Use the rubric's M" }),
  );
  expect(onUse).toHaveBeenCalledOnce();

  rerender(
    <PricingRubricBlock
      proposal={proposal({ sizedBy: "reviewer", complexity: "L" })}
      canUse
      busy
      onUse={onUse}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Use the rubric's M",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  // Agreeing, or not the viewer's to change, there is nothing to offer.
  rerender(
    <PricingRubricBlock
      proposal={proposal({ sizedBy: "reviewer", complexity: "M" })}
      canUse
      busy={false}
      onUse={onUse}
    />,
  );
  expect(screen.getByTestId("rubric-source").textContent).toBe(
    "A reviewer set this size, and the rubric agrees.",
  );
  expect(screen.queryByRole("button")).toBeNull();
  rerender(
    <PricingRubricBlock
      proposal={proposal({ sizedBy: "model", complexity: "L" })}
      canUse={false}
      busy={false}
      onUse={onUse}
    />,
  );
  expect(screen.getByTestId("rubric-source").textContent).toBe(
    "The model set this size; the rubric says M.",
  );
  expect(screen.queryByRole("button")).toBeNull();
});

/** The spec as a revision of it, read. */
function revision(draft: SpecDraft, number = 2): BountySpecDto {
  return {
    id: `bsp_${number}`,
    organizationId: "org_1",
    proposalId: "bpr_1",
    revision: number,
    specHash: "a".repeat(64),
    specHashVersion: 1,
    draft: draft as BountySpecDto["draft"],
    origin: "draft",
    instruction: null,
    createdBy: null,
    runId: null,
    actualModel: null,
    promptVersion: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

function shown(overrides: Partial<ShownSpec> = {}): ShownSpec {
  const current = revision(spec);
  return {
    read: { state: "ready", spec: current },
    spec: current,
    current: 2,
    viewing: null,
    onView: () => {},
    revisions: [],
    diff: undefined,
    retry: () => {},
    ...overrides,
  };
}

function control() {
  return {
    state: { phase: "idle" },
    request: vi.fn<RespecControl["request"]>(),
  } satisfies RespecControl;
}

test("a scenario factor unfolds the scenarios it counted, and each opens with what it adds", async () => {
  const user = userEvent.setup();
  render(
    <PricingRubricBlock
      proposal={proposal()}
      canUse={false}
      busy={false}
      onUse={() => {}}
      scenarios={{ shown: shown() }}
    />,
  );
  const scenarios = screen.getByTestId("rubric-scenarios");
  // Still the factor's working, now a control that unfolds it.
  const moderate = within(scenarios).getByRole("button", {
    name: /Moderate scenarios2 × 2\+4/,
  });
  expect(moderate.getAttribute("aria-expanded")).toBe("false");
  // Nothing weighs light: nothing to open.
  expect(
    within(scenarios).queryByRole("button", { name: /Light scenarios/ }),
  ).toBeNull();

  await user.click(moderate);
  expect(moderate.getAttribute("aria-expanded")).toBe("true");
  const list = within(scenarios).getByTestId("rubric-drill-weight-moderate");
  expect(
    within(list)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["One invitation", "Rescheduled"]);

  // One open at a time.
  await user.click(
    within(scenarios).getByRole("button", { name: /Heavy scenarios/ }),
  );
  expect(moderate.getAttribute("aria-expanded")).toBe("false");
  await user.click(moderate);

  await user.click(
    within(list).getByRole("button", { name: "One invitation" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("heading").textContent).toBe(
    "One invitation",
  );
  expect(dialog.textContent).toContain("the time is in it");
  // Two points of weight, its test, and its one check past the first.
  expect(within(dialog).getByTestId("scenario-adds").textContent).toBe(
    "Moderate scenario+2Its acceptance test+11 check past the first+1Adds to the price4 points",
  );
  // A reader who may not change the spec is not offered to.
  expect(
    within(dialog).queryByRole("button", { name: "Remove scenario" }),
  ).toBeNull();

  // The scenarios either side, in the spec's order, round from the end.
  await user.click(
    within(dialog).getByRole("button", { name: "Next scenario" }),
  );
  expect(within(dialog).getByRole("heading").textContent).toBe("Rescheduled");
  await user.keyboard("{ArrowRight}");
  expect(within(dialog).getByRole("heading").textContent).toBe("Retried once");
  await user.keyboard("{ArrowRight}");
  expect(within(dialog).getByRole("heading").textContent).toBe(
    "One invitation",
  );

  // Back to them all, by kind.
  await user.click(
    within(dialog).getByRole("button", { name: "All scenarios" }),
  );
  expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe(
    "Interview invitations",
  );
  expect(
    within(dialog)
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label")),
  ).toEqual(["Happy path", "Recovery"]);
});

test("the test factors open onto every test, and the ones checking more than one outcome", async () => {
  const user = userEvent.setup();
  render(
    <PricingRubricBlock
      proposal={proposal()}
      canUse={false}
      busy={false}
      onUse={() => {}}
      scenarios={{ shown: shown() }}
    />,
  );
  const tests = screen.getByTestId("rubric-tests");
  await user.click(within(tests).getByRole("button", { name: /Test cases/ }));
  expect(within(tests).getByTestId("rubric-drill-test-cases").textContent).toBe(
    "One invitation2 checksRescheduled2 checksRetried once1 check",
  );
  await user.click(
    within(tests).getByRole("button", { name: /Additional checks/ }),
  );
  expect(
    within(tests).getByTestId("rubric-drill-extra-checks").textContent,
  ).toBe("One invitation+1Rescheduled+1");
});

test("the spec is opened whole from the Scenarios dimension, and changed from it", async () => {
  const user = userEvent.setup();
  const respec = control();
  const questions = {
    ...spec,
    openQuestions: ["Which time zone?", "Who is copied?"],
    assumptions: ["Email is already configured."],
  };
  const current = revision(questions);
  render(
    <PricingRubricBlock
      proposal={proposal({
        rubric: assessRubric({
          spec: questions,
          code: measured,
        }) as BountyProposalDto["rubric"],
      })}
      canUse
      busy={false}
      onUse={() => {}}
      scenarios={{
        shown: shown({
          read: { state: "ready", spec: current },
          spec: current,
        }),
        changes: { control: respec, size: "M" },
      }}
    />,
  );
  const scenarios = screen.getByTestId("rubric-scenarios");
  expect(within(scenarios).getByTestId("spec-changes")).toBeDefined();

  // The open questions open as a dialog, where they are answered.
  await user.click(
    within(scenarios).getByRole("button", { name: /Open questions/ }),
  );
  let dialog = await screen.findByRole("dialog", { name: "Open questions" });
  expect(dialog.textContent).toContain("Which time zone?");
  await user.click(within(dialog).getByRole("button", { name: /Answer them/ }));
  await user.type(within(dialog).getByLabelText("Which time zone?"), "UTC");
  await user.click(
    within(dialog).getByRole("button", { name: "Revise for this answer" }),
  );
  expect(respec.request).toHaveBeenCalledWith(
    {
      mode: "answer",
      answers: [{ question: "Which time zone?", answer: "UTC" }],
    },
    "Revising the spec for your answer…",
  );

  // What was assumed, unscored, the same way.
  await user.click(
    within(scenarios).getByRole("button", {
      name: "Drafted on 1 assumption, not scored",
    }),
  );
  dialog = await screen.findByRole("dialog", { name: "Assumptions" });
  expect(dialog.textContent).toContain("Email is already configured.");
  // Closed by its own button rather than Escape, which Radix routes to the
  // topmost layer and which CI on Node 24 was seen to drop.
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Every scenario, from the feature; one taken out from its own view.
  await user.click(
    within(scenarios).getByRole("button", { name: /Interview invitations/ }),
  );
  dialog = await screen.findByRole("dialog");
  await user.click(
    within(dialog).getByRole("button", { name: /Retried once/ }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Remove scenario" }),
  );
  const confirm = await screen.findByRole("alertdialog");
  await user.click(
    within(confirm).getByRole("button", { name: "Remove scenario" }),
  );
  expect(respec.request).toHaveBeenLastCalledWith(
    { mode: "trim", removeScenarioIds: ["s2"] },
    "Removing “Retried once”…",
  );
});

test("an earlier revision on show is scored as it would be, beside the price in force", async () => {
  const user = userEvent.setup();
  const onView = vi.fn();
  // Revision 1 had only the first scenario.
  const first = revision({ ...spec, scenarios: spec.scenarios.slice(0, 1) }, 1);
  render(
    <PricingRubricBlock
      proposal={proposal()}
      canUse
      busy={false}
      onUse={() => {}}
      scenarios={{
        shown: shown({
          read: { state: "ready", spec: first },
          spec: first,
          viewing: 1,
          onView,
        }),
      }}
    />,
  );
  // Four from its scenario and its test, six from the code.
  expect(screen.getByTestId("rubric-total").textContent).toBe(
    "10 points →is S",
  );
  expect(screen.getByTestId("rubric-source").textContent).toBe(
    "As revision 1 would score. The price goes with revision 2.",
  );
  // The size in force is still the proposal's.
  const rungs = within(screen.getByTestId("rubric-ladder")).getAllByRole(
    "listitem",
  );
  expect(rungs[4]?.getAttribute("aria-current")).toBe("true");
  await user.click(screen.getByRole("button", { name: "Show current" }));
  expect(onView).toHaveBeenCalledWith(null);
});
