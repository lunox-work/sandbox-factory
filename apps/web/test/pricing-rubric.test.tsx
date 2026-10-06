import type { BountyProposalDto } from "@sandbox-factory/shared";
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
import { render, screen, within } from "./render";

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
